import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AuthProvider, DiskStore, OAuthProxy, type GoogleSession } from 'fastmcp/auth';
import type { TokenStorage, UpstreamTokenSet } from 'fastmcp/auth';

export const DEFAULT_GOOGLE_SCOPES = ['openid', 'email'];

export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  'https://oauth-redirect.googleusercontent.com/r/*',
  'https://oauth-redirect-sandbox.googleusercontent.com/r/*',
  'https://oauth-redirect-test.googleusercontent.com/r/*',
  'https://oauth-redirect.googleusercontent.com/a/*',
  'https://oauth-redirect-sandbox.googleusercontent.com/a/*',
  'https://oauth-redirect-test.googleusercontent.com/a/*',
  'http://localhost:*',
  'http://127.0.0.1:*',
];

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const USERINFO_CACHE_TTL_MS = 60_000;

export interface AuthConfig {
  /** Public HTTPS base URL of this MCP server (e.g. https://docker-sbx-mcp.6uo.me). */
  publicUrl?: string;
  /** Google OAuth 2.0 Web Client ID (GOOGLE_OAUTH_CLIENT_ID or OAUTH_AUDIENCE). */
  googleClientId?: string;
  /** Google OAuth 2.0 Web Client Secret (GOOGLE_OAUTH_CLIENT_SECRET). */
  googleClientSecret?: string;
  /** Comma-separated allowlist of verified Google email addresses (ALLOWED_EMAILS or OAUTH_ALLOWED_EMAILS). */
  allowedEmails?: string[];
  /** Allowed DCR client redirect URI glob patterns (ALLOWED_CLIENT_REDIRECT_URIS). */
  allowedClientRedirectUris?: string[];
  /** Optional explicit signing key for FastMCP JWTs and encrypted state (FASTMCP_JWT_SIGNING_KEY). */
  jwtSigningKey?: string;
  /** Optional directory for persistent encrypted DiskStore state (FASTMCP_STATE_DIR / FASTMCP_HOME). */
  stateDir?: string;
  /** Require browser consent screen before redirecting to Google (default: true). */
  consentRequired?: boolean;
  /** Optional static Bearer token fallback for local scripts or smoke tests (MCP_BEARER_TOKEN). */
  bearerToken?: string;
  /** Optional upstream endpoint overrides (primarily for testing). */
  googleAuthorizationEndpoint?: string;
  googleTokenEndpoint?: string;
  googleUserInfoEndpoint?: string;
}

export interface SandboxSession extends GoogleSession, Record<string, unknown> {
  mode: 'google-oauth' | 'static-bearer';
  email?: string;
  subject?: string;
}

export function parseCsvEnv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseBoolEnv(value?: string): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/$/, '') || undefined;
  const googleClientId =
    env.GOOGLE_OAUTH_CLIENT_ID?.trim() || env.OAUTH_AUDIENCE?.trim() || undefined;
  const googleClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined;
  const allowedEmails = parseCsvEnv(env.ALLOWED_EMAILS ?? env.OAUTH_ALLOWED_EMAILS);
  const allowedClientRedirectUris = parseCsvEnv(env.ALLOWED_CLIENT_REDIRECT_URIS);
  const jwtSigningKey =
    env.FASTMCP_JWT_SIGNING_KEY?.trim() || env.OAUTH_JWT_SIGNING_KEY?.trim() || undefined;
  const stateDir = env.FASTMCP_STATE_DIR?.trim() || env.FASTMCP_HOME?.trim() || undefined;
  const consentRequired = parseBoolEnv(env.OAUTH_CONSENT_REQUIRED);
  const bearerToken = env.MCP_BEARER_TOKEN?.trim() || undefined;

  return {
    publicUrl,
    googleClientId,
    googleClientSecret,
    allowedEmails,
    allowedClientRedirectUris,
    jwtSigningKey,
    stateDir,
    consentRequired,
    bearerToken,
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function deriveKey(seed: string, purpose: string): string {
  return crypto.createHmac('sha256', seed).update(`docker-sandbox-mcp:${purpose}`).digest('hex');
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const raw = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isEmailVerified(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function forbiddenResponse(message: string): Response {
  return new Response(JSON.stringify({ error: 'forbidden', message }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractBearerToken(request?: IncomingMessage): string | undefined {
  const raw = request?.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export interface GoogleIdentity {
  email?: string;
  emailVerified: boolean;
  subject?: string;
}

export class SandboxGoogleProvider extends AuthProvider<SandboxSession> {
  private readonly sandboxConfig: AuthConfig;
  private readonly allowedEmails?: Set<string>;
  private readonly userInfoEndpoint: string;
  private readonly userInfoCache = new Map<string, { identity: GoogleIdentity; expiresAt: number }>();
  private diskStore?: DiskStore;

  constructor(config: AuthConfig) {
    if (!config.publicUrl) {
      throw new Error('PUBLIC_URL is required when Google OAuth proxy is enabled.');
    }
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error(
        'Both GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required for Google OAuth proxy.',
      );
    }

    const baseUrl = config.publicUrl.replace(/\/$/, '');
    const keySeed = config.jwtSigningKey || config.googleClientSecret;
    const allowedRedirectUriPatterns =
      config.allowedClientRedirectUris ?? DEFAULT_ALLOWED_REDIRECT_URIS;

    super({
      baseUrl,
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      scopes: DEFAULT_GOOGLE_SCOPES,
      consentRequired: config.consentRequired ?? true,
      allowedRedirectUriPatterns,
      allowPlainPkce: false,
      authorizationResponseIss: true,
      enableCimd: true,
      jwtSigningKey: deriveKey(keySeed, 'jwt'),
      encryptionKey: deriveKey(keySeed, 'encryption'),
    });

    this.sandboxConfig = config;
    this.allowedEmails = config.allowedEmails
      ? new Set(config.allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))
      : undefined;
    this.userInfoEndpoint = config.googleUserInfoEndpoint ?? GOOGLE_USERINFO_ENDPOINT;
  }

  protected override getAuthorizationEndpoint(): string {
    return this.sandboxConfig.googleAuthorizationEndpoint ?? GOOGLE_AUTH_ENDPOINT;
  }

  protected override getDefaultScopes(): string[] {
    return DEFAULT_GOOGLE_SCOPES;
  }

  protected override getTokenEndpoint(): string {
    return this.sandboxConfig.googleTokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
  }

  protected override createProxy(): OAuthProxy {
    const keySeed = this.sandboxConfig.jwtSigningKey || this.sandboxConfig.googleClientSecret!;
    let tokenStorage: TokenStorage | undefined;
    if (this.sandboxConfig.stateDir) {
      this.diskStore = new DiskStore({ directory: this.sandboxConfig.stateDir });
      tokenStorage = this.diskStore;
    }

    return new OAuthProxy({
      ...this.forwardedProxyOptions,
      allowedRedirectUriPatterns:
        this.sandboxConfig.allowedClientRedirectUris ?? DEFAULT_ALLOWED_REDIRECT_URIS,
      baseUrl: this.sandboxConfig.publicUrl!.replace(/\/$/, ''),
      consentRequired: this.sandboxConfig.consentRequired ?? true,
      consentSigningKey: deriveKey(keySeed, 'consent'),
      encryptionKey: deriveKey(keySeed, 'encryption'),
      extraAuthorizationParams: {
        access_type: 'offline',
        prompt: 'consent',
      },
      jwtSigningKey: deriveKey(keySeed, 'jwt'),
      scopes: DEFAULT_GOOGLE_SCOPES,
      tokenStorage,
      upstreamAuthorizationEndpoint:
        this.sandboxConfig.googleAuthorizationEndpoint ?? GOOGLE_AUTH_ENDPOINT,
      upstreamClientId: this.sandboxConfig.googleClientId!,
      upstreamClientSecret: this.sandboxConfig.googleClientSecret!,
      upstreamTokenEndpoint: this.sandboxConfig.googleTokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT,
    });
  }

  private async resolveIdentity(upstreamTokens: UpstreamTokenSet): Promise<GoogleIdentity> {
    if (upstreamTokens.idToken) {
      const payload = decodeJwtPayload(upstreamTokens.idToken);
      if (payload && typeof payload.email === 'string') {
        return {
          email: payload.email,
          emailVerified: isEmailVerified(payload.email_verified),
          subject: typeof payload.sub === 'string' ? payload.sub : undefined,
        };
      }
    }

    const tokenHash = crypto
      .createHash('sha256')
      .update(upstreamTokens.accessToken)
      .digest('hex');
    const now = Date.now();
    const cached = this.userInfoCache.get(tokenHash);
    if (cached && cached.expiresAt > now) {
      return cached.identity;
    }

    const res = await fetch(this.userInfoEndpoint, {
      headers: {
        authorization: `Bearer ${upstreamTokens.accessToken}`,
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch Google userinfo (${res.status}).`);
    }
    const info = (await res.json()) as Record<string, unknown>;
    const identity: GoogleIdentity = {
      email: typeof info.email === 'string' ? info.email : undefined,
      emailVerified: isEmailVerified(info.email_verified),
      subject: typeof info.sub === 'string' ? info.sub : undefined,
    };
    this.userInfoCache.set(tokenHash, {
      identity,
      expiresAt: now + USERINFO_CACHE_TTL_MS,
    });
    return identity;
  }

  override async authenticate(
    request: IncomingMessage | undefined,
  ): Promise<SandboxSession | undefined> {
    if (!request) {
      return undefined;
    }

    const token = extractBearerToken(request);
    if (!token) {
      return undefined;
    }

    if (
      this.sandboxConfig.bearerToken &&
      constantTimeEquals(token, this.sandboxConfig.bearerToken)
    ) {
      return {
        mode: 'static-bearer',
        accessToken: token,
        scopes: [],
      };
    }

    const upstreamTokens = await this.proxy.loadUpstreamTokens(token);
    if (!upstreamTokens) {
      return undefined;
    }

    const baseSession = this.createSession(upstreamTokens);
    let identity: GoogleIdentity | undefined;

    if (this.allowedEmails && this.allowedEmails.size > 0) {
      try {
        identity = await this.resolveIdentity(upstreamTokens);
      } catch {
        return undefined;
      }

      if (!identity.emailVerified) {
        throw forbiddenResponse('A verified Google email address is required.');
      }
      if (!identity.email || !this.allowedEmails.has(identity.email.trim().toLowerCase())) {
        throw forbiddenResponse('Authenticated Google account is not authorized for this server.');
      }
    } else if (upstreamTokens.idToken) {
      const payload = decodeJwtPayload(upstreamTokens.idToken);
      if (payload) {
        identity = {
          email: typeof payload.email === 'string' ? payload.email : undefined,
          emailVerified: isEmailVerified(payload.email_verified),
          subject: typeof payload.sub === 'string' ? payload.sub : undefined,
        };
      }
    }

    return {
      ...baseSession,
      mode: 'google-oauth',
      email: identity?.email,
      subject: identity?.subject,
      scopes: baseSession.scopes ?? [],
    };
  }

  destroy(): void {
    this.getProxy().destroy();
    this.diskStore?.destroy();
    this.userInfoCache.clear();
  }
}

export function createStaticBearerAuthenticate(
  bearerToken: string,
): (request: IncomingMessage) => Promise<SandboxSession | undefined> {
  return async (request: IncomingMessage): Promise<SandboxSession | undefined> => {
    const token = extractBearerToken(request);
    if (!token || !constantTimeEquals(token, bearerToken)) {
      return undefined;
    }
    return {
      mode: 'static-bearer',
      accessToken: token,
      scopes: [],
    };
  };
}

export function isGoogleOAuthConfigured(config: AuthConfig): boolean {
  return Boolean(config.googleClientId || config.googleClientSecret);
}
