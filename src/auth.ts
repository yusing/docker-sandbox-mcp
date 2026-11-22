import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface AuthConfig {
  /** Optional static Bearer token for local/dev or simple proxy auth. */
  bearerToken?: string;
  /** Public base URL of this MCP server (e.g. https://sbx-mcp.example.com). */
  publicUrl?: string;
  /** OIDC / OAuth 2.0 issuer URL (e.g. https://accounts.google.com). */
  oauthIssuer?: string;
  /** Expected JWT `aud` claim or Google OAuth Client ID (`*.apps.googleusercontent.com`). */
  oauthAudience?: string;
  /** Explicit JWKS URI override. If omitted, discovered via `${oauthIssuer}/.well-known/openid-configuration`. */
  oauthJwksUri?: string;
  /** Tokeninfo endpoint for opaque OAuth access tokens (auto-defaults to Google's tokeninfo when oauthIssuer is https://accounts.google.com). */
  oauthTokenInfoUri?: string;
  /** Optional allowlist of authorized `sub` claims. */
  allowedSubjects?: string[];
  /** Optional allowlist of authorized `email` claims (case-insensitive). */
  allowedEmails?: string[];
  /** Optional list of scopes that must all be present in the token's `scope` or `scp` claim. */
  requiredScopes?: string[];
}

export interface VerifiedAuth {
  mode: 'oauth-jwt' | 'oauth-opaque' | 'static-bearer';
  subject?: string;
  email?: string;
  scopes: string[];
  claims?: JWTPayload | Record<string, unknown>;
}

export interface AuthenticatedRequest extends Request {
  auth?: VerifiedAuth;
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_TOKENINFO_URI = 'https://oauth2.googleapis.com/tokeninfo';
const OPAQUE_CACHE_MAX_TTL_MS = 60_000;

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
    oauthTokenInfoUri: env.OAUTH_TOKENINFO_URI,
    allowedSubjects: parseCsvEnv(env.OAUTH_ALLOWED_SUBS),
    allowedEmails: parseCsvEnv(env.OAUTH_ALLOWED_EMAILS),
    requiredScopes: parseCsvEnv(env.OAUTH_REQUIRED_SCOPES),
  };
}

/**
 * Resolves the public origin for RFC 9728 metadata and WWW-Authenticate headers.
 * Prefers PUBLIC_URL, falling back to X-Forwarded-Proto + Host (e.g. behind GoDoxy / Cloud Run).
 */
export function resolvePublicOrigin(config: AuthConfig, req?: Request): string {
  if (config.publicUrl) {
    return config.publicUrl.replace(/\/$/, '');
  }
  if (req) {
    const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol || 'https';
    const host = req.header('x-forwarded-host')?.split(',')[0]?.trim() || req.header('host');
    if (host) {
      return `${proto}://${host}`;
    }
  }
  return 'http://localhost:8080';
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isJwtFormat(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function extractScopes(payload: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (typeof payload.scope === 'string') {
    for (const s of payload.scope.split(/\s+/)) {
      if (s) out.add(s);
    }
  }
  const scp = payload.scp;
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

function buildWwwAuthenticate(
  config: AuthConfig,
  req: Request,
  error?: string,
  description?: string,
): string {
  const origin = resolvePublicOrigin(config, req);
  const parts = [
    'Bearer realm="docker-sandbox-mcp"',
    `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
  ];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(', ');
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedAuth>;
}

/**
 * Creates a verifier that handles both:
 * - Signed JWTs via OIDC JWKS discovery (`jose.jwtVerify`)
 * - Opaque OAuth 2.0 access tokens (such as Google Cloud OAuth `ya29.*` tokens) via
 *   the tokeninfo endpoint with short-lived in-memory caching.
 */
export function createJwtVerifier(config: AuthConfig): TokenVerifier {
  if (!config.oauthIssuer && !config.oauthJwksUri && !config.oauthTokenInfoUri) {
    throw new Error(
      'One of oauthIssuer, oauthJwksUri, or oauthTokenInfoUri is required for OAuth verification.',
    );
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

  const normalizedIssuer = config.oauthIssuer?.replace(/\/$/, '');
  const tokenInfoUri =
    config.oauthTokenInfoUri ??
    (normalizedIssuer === GOOGLE_ISSUER ? GOOGLE_TOKENINFO_URI : undefined);

  const opaqueCache = new Map<string, { auth: VerifiedAuth; expiresAt: number }>();

  const allowedSubs = config.allowedSubjects ? new Set(config.allowedSubjects) : undefined;
  const allowedEmails = config.allowedEmails
    ? new Set(config.allowedEmails.map((e) => e.toLowerCase()))
    : undefined;

  function enforcePolicy(
    mode: 'oauth-jwt' | 'oauth-opaque',
    subject: string | undefined,
    email: string | undefined,
    scopes: string[],
    claims: Record<string, unknown>,
  ): VerifiedAuth {
    if (allowedSubs && (!subject || !allowedSubs.has(subject))) {
      throw new AuthForbiddenError('Token subject is not authorized to access this MCP server.');
    }

    if (allowedEmails && (!email || !allowedEmails.has(email.toLowerCase()))) {
      throw new AuthForbiddenError('Token email is not authorized to access this MCP server.');
    }

    if (config.requiredScopes && config.requiredScopes.length > 0) {
      const scopeSet = new Set(scopes);
      const missing = config.requiredScopes.filter((s) => !scopeSet.has(s));
      if (missing.length > 0) {
        throw new AuthInsufficientScopeError(
          `Missing required scope(s): ${missing.join(', ')}`,
        );
      }
    }

    return { mode, subject, email, scopes, claims };
  }

  async function verifyOpaqueToken(token: string): Promise<VerifiedAuth> {
    if (!tokenInfoUri) {
      throw new Error('Token is not a JWT and no opaque tokeninfo endpoint is configured.');
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const cached = opaqueCache.get(tokenHash);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.auth;
    }

    const body = new URLSearchParams({ access_token: token });
    const res = await fetch(tokenInfoUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Token introspection rejected the access token (${res.status}).`);
    }

    const info = (await res.json()) as Record<string, unknown>;

    if (config.oauthAudience) {
      const aud = typeof info.aud === 'string' ? info.aud : undefined;
      const azp = typeof info.azp === 'string' ? info.azp : undefined;
      if (aud !== config.oauthAudience && azp !== config.oauthAudience) {
        throw new Error('Access token audience does not match OAUTH_AUDIENCE.');
      }
    }

    if (info.email && info.email_verified !== undefined) {
      const verified = info.email_verified === true || info.email_verified === 'true';
      if (!verified) {
        throw new Error('Access token email is not verified.');
      }
    }

    const expSec = typeof info.exp === 'string' ? Number(info.exp) : Number(info.exp ?? 0);
    if (expSec > 0 && expSec * 1000 <= now) {
      throw new Error('Access token is expired.');
    }

    const subject = typeof info.sub === 'string' ? info.sub : undefined;
    const email = typeof info.email === 'string' ? info.email : undefined;
    const scopes = extractScopes(info);
    const verified = enforcePolicy('oauth-opaque', subject, email, scopes, info);

    const tokenExpMs = expSec > 0 ? expSec * 1000 : now + OPAQUE_CACHE_MAX_TTL_MS;
    const cacheUntil = Math.min(tokenExpMs, now + OPAQUE_CACHE_MAX_TTL_MS);
    opaqueCache.set(tokenHash, { auth: verified, expiresAt: cacheUntil });
    return verified;
  }

  return {
    async verify(token: string): Promise<VerifiedAuth> {
      if (!isJwtFormat(token)) {
        return verifyOpaqueToken(token);
      }

      const jwks = await getJwks();
      const { payload } = await jwtVerify(token, jwks, {
        ...(config.oauthIssuer ? { issuer: config.oauthIssuer } : {}),
        ...(config.oauthAudience ? { audience: config.oauthAudience } : {}),
      });

      const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      const scopes = extractScopes(payload as Record<string, unknown>);
      return enforcePolicy('oauth-jwt', subject, email, scopes, payload as Record<string, unknown>);
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
 * 2. Opaque OAuth 2.0 access tokens (e.g., Google Cloud OAuth `ya29.*` tokens via tokeninfo).
 * 3. Static Bearer token verification (`MCP_BEARER_TOKEN`) as an optional fallback.
 */
export function createAuthMiddleware(config: AuthConfig) {
  const oauthEnabled = Boolean(
    config.oauthIssuer || config.oauthJwksUri || config.oauthTokenInfoUri,
  );
  const staticEnabled = Boolean(config.bearerToken);
  const verifier = oauthEnabled ? createJwtVerifier(config) : undefined;

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!oauthEnabled && !staticEnabled) {
      next();
      return;
    }

    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      res.setHeader('WWW-Authenticate', buildWwwAuthenticate(config, req));
      res.status(401).json({
        error: 'unauthorized',
        message: 'OAuth 2.0 Bearer access token required.',
      });
      return;
    }

    const token = match[1];

    if (staticEnabled && config.bearerToken && constantTimeEquals(token, config.bearerToken)) {
      req.auth = { mode: 'static-bearer', scopes: [] };
      next();
      return;
    }

    if (verifier) {
      try {
        req.auth = await verifier.verify(token);
        next();
        return;
      } catch (err) {
        if (err instanceof AuthInsufficientScopeError) {
          res.setHeader(
            'WWW-Authenticate',
            buildWwwAuthenticate(config, req, 'insufficient_scope', err.message),
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
          buildWwwAuthenticate(config, req, 'invalid_token', detail),
        );
        res.status(401).json({
          error: 'invalid_token',
          message: 'Bearer token verification failed.',
        });
        return;
      }
    }

    res.setHeader('WWW-Authenticate', buildWwwAuthenticate(config, req, 'invalid_token'));
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
export function buildProtectedResourceMetadata(
  config: AuthConfig,
  req?: Request,
): Record<string, unknown> {
  const origin = resolvePublicOrigin(config, req);
  return {
    resource: `${origin}/mcp`,
    ...(config.oauthIssuer ? { authorization_servers: [config.oauthIssuer] } : {}),
    bearer_methods_supported: ['header'],
    scopes_supported:
      config.requiredScopes && config.requiredScopes.length > 0
        ? config.requiredScopes
        : ['openid', 'email', 'profile'],
  };
}
