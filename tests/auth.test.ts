import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { authConfigFromEnv, SandboxGoogleProvider } from '../src/auth.js';
import { createSandboxMcpServer } from '../src/mcp-server.js';
import type { SandboxService } from '../src/sandbox-service.js';

const noopService = {} as SandboxService;

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  assert(addr && typeof addr !== 'string');
  const { port } = addr;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function initializeRequest(token?: string) {
  return {
    method: 'POST',
    headers: {
      connection: 'close',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'gemini-web', version: '1.0.0' },
      },
    }),
  };
}

describe('FastMCP Google OAuth 2.1 proxy', () => {
  it('validates env parsing and required Google OAuth proxy configuration', () => {
    const cfg = authConfigFromEnv({
      PUBLIC_URL: 'https://docker-sbx-mcp.6uo.me/',
      OAUTH_AUDIENCE: '123.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-secret',
      OAUTH_ALLOWED_EMAILS: 'Owner@Example.com, other@example.com',
      ALLOWED_CLIENT_REDIRECT_URIS: 'https://oauth-redirect.googleusercontent.com/r/*',
      FASTMCP_HOME: '/var/lib/fastmcp',
    });

    assert.equal(cfg.publicUrl, 'https://docker-sbx-mcp.6uo.me');
    assert.equal(cfg.googleClientId, '123.apps.googleusercontent.com');
    assert.equal(cfg.googleClientSecret, 'GOCSPX-secret');
    assert.deepEqual(cfg.allowedEmails, ['Owner@Example.com', 'other@example.com']);
    assert.deepEqual(cfg.allowedClientRedirectUris, [
      'https://oauth-redirect.googleusercontent.com/r/*',
    ]);
    assert.equal(cfg.stateDir, '/var/lib/fastmcp');

    assert.throws(
      () => new SandboxGoogleProvider({ googleClientId: '123', googleClientSecret: 'sec' }),
      /PUBLIC_URL is required/,
    );
    assert.throws(
      () =>
        new SandboxGoogleProvider({
          publicUrl: 'https://mcp.example.com',
          googleClientId: '123',
        }),
      /GOOGLE_OAUTH_CLIENT_SECRET/,
    );
  });

  it('serves Gemini-compatible OAuth discovery, DCR, PKCE S256 flow, email allowlist, refresh userinfo fallback, and DiskStore persistence', async () => {
    let nextGoogleUser: { email: string; email_verified: boolean; sub: string; includeIdToken: boolean } = {
      email: 'OWNER@example.com',
      email_verified: true,
      sub: 'google-sub-owner',
      includeIdToken: true,
    };
    const tokenUsers = new Map<string, { email: string; email_verified: boolean; sub: string }>();
    let tokenCounter = 0;
    let userInfoCalls = 0;

    const mockGoogle = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/token' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const params = new URLSearchParams(raw);
          const grantType = params.get('grant_type');
          tokenCounter += 1;
          const accessToken = `ya29.mock-${tokenCounter}`;

          if (grantType === 'authorization_code') {
            const user = { ...nextGoogleUser };
            tokenUsers.set(accessToken, {
              email: user.email,
              email_verified: user.email_verified,
              sub: user.sub,
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                access_token: accessToken,
                refresh_token: `1//refresh-${tokenCounter}`,
                token_type: 'Bearer',
                expires_in: 3600,
                scope: 'openid email',
                ...(user.includeIdToken
                  ? {
                      id_token: makeFakeJwt({
                        sub: user.sub,
                        email: user.email,
                        email_verified: user.email_verified,
                      }),
                    }
                  : {}),
              }),
            );
            return;
          }

          if (grantType === 'refresh_token') {
            // Simulate Google omitting id_token on refresh to exercise userinfo fallback
            tokenUsers.set(accessToken, {
              email: 'owner@example.com',
              email_verified: true,
              sub: 'google-sub-owner',
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                access_token: accessToken,
                token_type: 'Bearer',
                expires_in: 3600,
                scope: 'openid email',
              }),
            );
            return;
          }

          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
        });
        return;
      }

      if (url.pathname === '/userinfo' && req.method === 'GET') {
        userInfoCalls += 1;
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const user = tokenUsers.get(token);
        if (!user) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_token' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(user));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockGoogle.listen(0, '127.0.0.1', resolve));
    const googleAddr = mockGoogle.address();
    assert(googleAddr && typeof googleAddr !== 'string');
    const googleBase = `http://127.0.0.1:${googleAddr.port}`;

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-sbx-fastmcp-'));
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const authConfig = {
      publicUrl: baseUrl,
      googleClientId: 'google-client-id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-test-secret-value',
      allowedEmails: ['owner@example.com'],
      stateDir,
      consentRequired: false,
      googleAuthorizationEndpoint: `${googleBase}/authorize`,
      googleTokenEndpoint: `${googleBase}/token`,
      googleUserInfoEndpoint: `${googleBase}/userinfo`,
    };

    let handle = createSandboxMcpServer({ service: noopService, auth: authConfig });
    await handle.server.start({
      transportType: 'httpStream',
      httpStream: {
        host: '127.0.0.1',
        port,
        endpoint: '/mcp',
        sseEndpoint: null,
        stateless: true,
      },
    });

    async function runOAuthFlow(
      clientId: string,
      clientSecret: string | undefined,
      redirectUri: string,
    ): Promise<{ access_token: string; refresh_token?: string }> {
      const { verifier, challenge } = makePkce();
      const authUrl = new URL(`${baseUrl}/oauth/authorize`);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email');
      authUrl.searchParams.set('state', 'gemini-state-1');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      const authRes = await fetch(authUrl, { redirect: 'manual' });
      assert.equal(authRes.status, 302);
      const upstreamLocation = new URL(authRes.headers.get('location') ?? '');
      assert.equal(upstreamLocation.origin, googleBase);
      assert.equal(upstreamLocation.searchParams.get('access_type'), 'offline');
      assert.equal(upstreamLocation.searchParams.get('prompt'), 'consent');
      assert.equal(
        upstreamLocation.searchParams.get('redirect_uri'),
        `${baseUrl}/oauth/callback`,
      );
      const txnState = upstreamLocation.searchParams.get('state');
      assert(txnState);

      const cbUrl = new URL(`${baseUrl}/oauth/callback`);
      cbUrl.searchParams.set('code', 'google-auth-code');
      cbUrl.searchParams.set('state', txnState);
      const cbRes = await fetch(cbUrl, { redirect: 'manual' });
      assert.equal(cbRes.status, 302);
      const clientRedirect = new URL(cbRes.headers.get('location') ?? '');
      assert.equal(`${clientRedirect.origin}${clientRedirect.pathname}`, redirectUri);
      assert.equal(clientRedirect.searchParams.get('state'), 'gemini-state-1');
      assert.equal(clientRedirect.searchParams.get('iss'), baseUrl);
      const clientCode = clientRedirect.searchParams.get('code');
      assert(clientCode);

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: clientCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });
      const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
      });
      assert.equal(tokenRes.status, 200, await tokenRes.clone().text());
      return (await tokenRes.json()) as { access_token: string; refresh_token?: string };
    }

    try {
      // 1. Discovery metadata matches Gemini Web Connected Apps requirements
      const prmRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
      assert.equal(prmRes.status, 200);
      const prm = (await prmRes.json()) as Record<string, unknown>;
      assert.equal(prm.resource, `${baseUrl}/mcp`);
      assert.deepEqual(prm.authorization_servers, [baseUrl]);

      const asRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
      assert.equal(asRes.status, 200);
      const asMeta = (await asRes.json()) as Record<string, unknown>;
      assert.equal(asMeta.issuer, baseUrl);
      assert.equal(asMeta.authorization_endpoint, `${baseUrl}/oauth/authorize`);
      assert.equal(asMeta.token_endpoint, `${baseUrl}/oauth/token`);
      assert.equal(asMeta.registration_endpoint, `${baseUrl}/oauth/register`);
      assert.deepEqual(asMeta.response_types_supported, ['code']);
      assert.deepEqual(asMeta.code_challenge_methods_supported, ['S256']);
      assert.equal(asMeta.client_id_metadata_document_supported, true);

      // 2. Unauthenticated POST /mcp returns 401 with resource_metadata challenge
      const unauth = await fetch(`${baseUrl}/mcp`, initializeRequest());
      assert.equal(unauth.status, 401);
      assert.match(
        unauth.headers.get('www-authenticate') ?? '',
        /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/,
      );

      // 3. DCR rejects untrusted redirect URI and accepts Gemini redirect URI
      const badDcr = await fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'evil',
          redirect_uris: ['https://evil.example/callback'],
          token_endpoint_auth_method: 'none',
        }),
      });
      assert.equal(badDcr.status, 400);

      const geminiRedirect = 'https://oauth-redirect.googleusercontent.com/r/project-123';
      const dcrRes = await fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Gemini Web',
          redirect_uris: [geminiRedirect],
          token_endpoint_auth_method: 'none',
        }),
      });
      assert.equal(dcrRes.status, 201, await dcrRes.clone().text());
      const dcr = (await dcrRes.json()) as { client_id: string; client_secret?: string };
      assert(dcr.client_id);

      // 4. Full OAuth flow for allowlisted verified owner
      const ownerTokens = await runOAuthFlow(dcr.client_id, dcr.client_secret, geminiRedirect);
      assert(ownerTokens.access_token);
      assert(ownerTokens.refresh_token);

      const okRes = await fetch(`${baseUrl}/mcp`, initializeRequest(ownerTokens.access_token));
      assert.equal(okRes.status, 200, await okRes.clone().text());

      // 5. Reject non-allowlisted Google user with 403
      nextGoogleUser = {
        email: 'intruder@example.com',
        email_verified: true,
        sub: 'google-sub-intruder',
        includeIdToken: true,
      };
      const intruderTokens = await runOAuthFlow(dcr.client_id, dcr.client_secret, geminiRedirect);
      const forbiddenRes = await fetch(
        `${baseUrl}/mcp`,
        initializeRequest(intruderTokens.access_token),
      );
      assert.equal(forbiddenRes.status, 403);

      // 6. Reject unverified Google email with 403
      nextGoogleUser = {
        email: 'owner@example.com',
        email_verified: false,
        sub: 'google-sub-unverified',
        includeIdToken: true,
      };
      const unverifiedTokens = await runOAuthFlow(
        dcr.client_id,
        dcr.client_secret,
        geminiRedirect,
      );
      const unverifiedRes = await fetch(
        `${baseUrl}/mcp`,
        initializeRequest(unverifiedTokens.access_token),
      );
      assert.equal(unverifiedRes.status, 403);

      // 7. Refresh token flow without id_token falls back to userinfo and succeeds
      const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: ownerTokens.refresh_token!,
          client_id: dcr.client_id,
        }).toString(),
      });
      assert.equal(refreshRes.status, 200, await refreshRes.clone().text());
      const refreshed = (await refreshRes.json()) as { access_token: string };

      const refreshedMcp1 = await fetch(`${baseUrl}/mcp`, initializeRequest(refreshed.access_token));
      assert.equal(refreshedMcp1.status, 200, await refreshedMcp1.clone().text());
      const refreshedMcp2 = await fetch(`${baseUrl}/mcp`, initializeRequest(refreshed.access_token));
      assert.equal(refreshedMcp2.status, 200, await refreshedMcp2.clone().text());
      assert.equal(userInfoCalls, 1);

      // 8. Persisted DiskStore survives server restart with deterministic derived keys
      await handle.server.stop();
      handle.destroy();

      handle = createSandboxMcpServer({ service: noopService, auth: authConfig });
      await handle.server.start({
        transportType: 'httpStream',
        httpStream: {
          host: '127.0.0.1',
          port,
          endpoint: '/mcp',
          sseEndpoint: null,
          stateless: true,
        },
      });

      const afterRestart = await fetch(
        `${baseUrl}/mcp`,
        initializeRequest(ownerTokens.access_token),
      );
      assert.equal(afterRestart.status, 200, await afterRestart.clone().text());
    } finally {
      await handle.server.stop();
      handle.destroy();
      await new Promise<void>((resolve) => mockGoogle.close(() => resolve()));
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
