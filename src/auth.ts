import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface AuthConfig {
  /** Optional static Bearer token for local/dev or simple proxy auth. */
  bearerToken?: string;
  /** Public base URL of this MCP server (e.g. https://mcp.example.com). */
  publicUrl?: string;
  /** OIDC / OAuth 2.0 issuer URL (e.g. https://accounts.google.com or https://tenant.auth0.com/). */
  oauthIssuer?: string;
  /** Expected JWT audience (`aud` claim). Defaults to `${publicUrl}/mcp` if omitted when oauthAudience is set. */
  oauthAudience?: string;
  /** Explicit JWKS URI override. If omitted, discovered via `${oauthIssuer}/.well-known/openid-configuration`. */
  oauthJwksUri?: string;
  /** Optional allowlist of authorized `sub` claims. */
  allowedSubjects?: string[];
  /** Optional allowlist of authorized `email` claims (case-insensitive). */
  allowedEmails?: string[];
  /** Optional list of scopes that must all be present in the JWT `scope` or `scp` claim. */
  requiredScopes?: string[];
}

export interface VerifiedAuth {
  mode: 'oauth-jwt' | 'static-bearer';
  subject?: string;
  email?: string;
  scopes: string[];
  claims?: JWTPayload;
}

export interface AuthenticatedRequest extends Request {
  auth?: VerifiedAuth;
}

export function parseCsvEnv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    bearerToken: env.MCP_BEARER_TOKEN,
    publicUrl: env.PUBLIC_URL,
    oauthIssuer: env.OAUTH_ISSUER,
    oauthAudience: env.OAUTH_AUDIENCE,
    oauthJwksUri: env.OAUTH_JWKS_URI,
    allowedSubjects: parseCsvEnv(env.OAUTH_ALLOWED_SUBS),
    allowedEmails: parseCsvEnv(env.OAUTH_ALLOWED_EMAILS),
    requiredScopes: parseCsvEnv(env.OAUTH_REQUIRED_SCOPES),
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractScopes(payload: JWTPayload): string[] {
  const out = new Set<string>();
  if (typeof payload.scope === 'string') {
    for (const s of payload.scope.split(/\s+/)) {
      if (s) out.add(s);
    }
  }
  const scp = (payload as Record<string, unknown>).scp;
  if (Array.isArray(scp)) {
    for (const s of scp) {
      if (typeof s === 'string' && s) out.add(s);
    }
  } else if (typeof scp === 'string') {
    for (const s of scp.split(/\s+/)) {
      if (s) out.add(s);
    }
  }
  return Array.from(out);
}

function buildWwwAuthenticate(config: AuthConfig, error?: string, description?: string): string {
  const parts = ['Bearer realm="docker-sandbox-mcp"'];
  if (config.publicUrl) {
    const base = config.publicUrl.replace(/\/$/, '');
    parts.push(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  }
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(', ');
}

export interface JwtVerifier {
  verify(token: string): Promise<VerifiedAuth>;
}

/**
 * Creates a JWKS-backed OAuth 2.0 / OIDC JWT verifier.
 * Automatically discovers `jwks_uri` from `.well-known/openid-configuration` when
 * `oauthJwksUri` is not explicitly provided, and caches the remote JWKS resolver.
 */
export function createJwtVerifier(config: AuthConfig): JwtVerifier {
  if (!config.oauthIssuer && !config.oauthJwksUri) {
    throw new Error('Either oauthIssuer or oauthJwksUri is required for OAuth JWT verification.');
  }

  let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;

  async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!jwksPromise) {
      jwksPromise = (async () => {
        if (config.oauthJwksUri) {
          return createRemoteJWKSet(new URL(config.oauthJwksUri));
        }
        const issuerBase = config.oauthIssuer!.replace(/\/$/, '');
        const discoveryUrl = `${issuerBase}/.well-known/openid-configuration`;
        const res = await fetch(discoveryUrl, {
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`OIDC discovery failed (${res.status}) at ${discoveryUrl}`);
        }
        const doc = (await res.json()) as { jwks_uri?: string };
        if (!doc.jwks_uri) {
          throw new Error(`OIDC discovery document at ${discoveryUrl} is missing jwks_uri`);
        }
        return createRemoteJWKSet(new URL(doc.jwks_uri));
      })().catch((err) => {
        jwksPromise = undefined;
        throw err;
      });
    }
    return jwksPromise;
  }

  const allowedSubs = config.allowedSubjects ? new Set(config.allowedSubjects) : undefined;
  const allowedEmails = config.allowedEmails
    ? new Set(config.allowedEmails.map((e) => e.toLowerCase()))
    : undefined;

  return {
    async verify(token: string): Promise<VerifiedAuth> {
      const jwks = await getJwks();
      const { payload } = await jwtVerify(token, jwks, {
        ...(config.oauthIssuer ? { issuer: config.oauthIssuer } : {}),
        ...(config.oauthAudience ? { audience: config.oauthAudience } : {}),
      });

      const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
      const email = typeof payload.email === 'string' ? payload.email : undefined;

      if (allowedSubs && (!subject || !allowedSubs.has(subject))) {
        throw new AuthForbiddenError('Token subject is not authorized to access this MCP server.');
      }

      if (allowedEmails && (!email || !allowedEmails.has(email.toLowerCase()))) {
        throw new AuthForbiddenError('Token email is not authorized to access this MCP server.');
      }

      const scopes = extractScopes(payload);
      if (config.requiredScopes && config.requiredScopes.length > 0) {
        const scopeSet = new Set(scopes);
        const missing = config.requiredScopes.filter((s) => !scopeSet.has(s));
        if (missing.length > 0) {
          throw new AuthInsufficientScopeError(
            `Missing required scope(s): ${missing.join(', ')}`,
          );
        }
      }

      return {
        mode: 'oauth-jwt',
        subject,
        email,
        scopes,
        claims: payload,
      };
    },
  };
}

class AuthForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthForbiddenError';
  }
}

class AuthInsufficientScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthInsufficientScopeError';
  }
}

/**
 * Express authentication middleware supporting:
 * 1. OAuth 2.0 / OIDC JWT verification via JWKS (`OAUTH_ISSUER` / `OAUTH_JWKS_URI`).
 * 2. Static Bearer token verification (`MCP_BEARER_TOKEN`) as an optional fallback.
 */
export function createAuthMiddleware(config: AuthConfig) {
  const oauthEnabled = Boolean(config.oauthIssuer || config.oauthJwksUri);
  const staticEnabled = Boolean(config.bearerToken);
  const jwtVerifier = oauthEnabled ? createJwtVerifier(config) : undefined;

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!oauthEnabled && !staticEnabled) {
      next();
      return;
    }

    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      res.setHeader('WWW-Authenticate', buildWwwAuthenticate(config));
      res.status(401).json({
        error: 'unauthorized',
        message: 'Authorization: Bearer <token> header required.',
      });
      return;
    }

    const token = match[1];

    // Optional static Bearer token check (useful for CI/health scripts alongside OAuth).
    if (staticEnabled && config.bearerToken && constantTimeEquals(token, config.bearerToken)) {
      req.auth = { mode: 'static-bearer', scopes: [] };
      next();
      return;
    }

    if (jwtVerifier) {
      try {
        req.auth = await jwtVerifier.verify(token);
        next();
        return;
      } catch (err) {
        if (err instanceof AuthInsufficientScopeError) {
          res.setHeader(
            'WWW-Authenticate',
            buildWwwAuthenticate(config, 'insufficient_scope', err.message),
          );
          res.status(403).json({
            error: 'insufficient_scope',
            message: err.message,
          });
          return;
        }
        if (err instanceof AuthForbiddenError) {
          res.status(403).json({
            error: 'forbidden',
            message: err.message,
          });
          return;
        }
        const detail = err instanceof Error ? err.message : 'Invalid token';
        res.setHeader(
          'WWW-Authenticate',
          buildWwwAuthenticate(config, 'invalid_token', detail),
        );
        res.status(401).json({
          error: 'invalid_token',
          message: 'Bearer JWT verification failed.',
        });
        return;
      }
    }

    res.setHeader('WWW-Authenticate', buildWwwAuthenticate(config, 'invalid_token'));
    res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid Bearer token.',
    });
  };
}

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata document for MCP clients
 * (including Gemini Web Connected Apps).
 */
export function buildProtectedResourceMetadata(config: AuthConfig): Record<string, unknown> {
  const resource = (config.publicUrl ?? 'http://localhost:8080').replace(/\/$/, '');
  return {
    resource: `${resource}/mcp`,
    ...(config.oauthIssuer ? { authorization_servers: [config.oauthIssuer] } : {}),
    bearer_methods_supported: ['header'],
    scopes_supported:
      config.requiredScopes && config.requiredScopes.length > 0
        ? config.requiredScopes
        : ['openid', 'email', 'profile'],
  };
}
