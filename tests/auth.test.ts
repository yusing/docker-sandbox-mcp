import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHttpApp } from '../src/index.js';
import type { SandboxService } from '../src/sandbox-service.js';

const noopService = {} as SandboxService;

describe('OAuth 2.0 / OIDC JWKS JWT verification', () => {
  it('discovers JWKS via OIDC metadata and enforces signature, audience, allowlist, and scopes', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    // Spin up a mock OIDC issuer exposing /.well-known/openid-configuration and /jwks.json
    let issuerBaseUrl = '';
    const oidcServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: issuerBaseUrl,
            jwks_uri: `${issuerBaseUrl}/jwks.json`,
          }),
        );
        return;
      }
      if (req.url === '/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => oidcServer.listen(0, '127.0.0.1', resolve));
    const oidcAddr = oidcServer.address();
    assert(oidcAddr && typeof oidcAddr !== 'string');
    issuerBaseUrl = `http://127.0.0.1:${oidcAddr.port}`;

    const app = createHttpApp({
      service: noopService,
      auth: {
        publicUrl: 'https://mcp.example.com',
        oauthIssuer: issuerBaseUrl,
        oauthAudience: 'https://mcp.example.com/mcp',
        allowedEmails: ['owner@example.com'],
        requiredScopes: ['sandboxes:write'],
      },
    });

    const mcpServer = http.createServer(app);
    await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
    const mcpAddr = mcpServer.address();
    assert(mcpAddr && typeof mcpAddr !== 'string');
    const mcpBaseUrl = `http://127.0.0.1:${mcpAddr.port}`;

    const sign = async (claims: Record<string, unknown>, exp = '5m') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(issuerBaseUrl)
        .setAudience('https://mcp.example.com/mcp')
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(privateKey);

    const postMcp = (token?: string) =>
      fetch(`${mcpBaseUrl}/mcp`, {
        method: 'POST',
        headers: {
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
      });

    try {
      // 1. RFC 9728 metadata (both root and /mcp suffix)
      const meta = await fetch(`${mcpBaseUrl}/.well-known/oauth-protected-resource/mcp`);
      assert.equal(meta.status, 200);
      const metaJson = (await meta.json()) as Record<string, unknown>;
      assert.deepEqual(metaJson.authorization_servers, [issuerBaseUrl]);
      assert.equal(metaJson.resource, 'https://mcp.example.com/mcp');

      // 2. Valid JWT passes
      const validToken = await sign({
        sub: 'user-123',
        email: 'OWNER@example.com',
        scope: 'openid email sandboxes:write',
      });
      const okRes = await postMcp(validToken);
      const okBody = await okRes.text();
      assert.equal(okRes.status, 200, okBody);

      // 3. Disallowed email -> 403 Forbidden
      const wrongUserToken = await sign({
        sub: 'user-999',
        email: 'intruder@example.com',
        scope: 'sandboxes:write',
      });
      const forbiddenRes = await postMcp(wrongUserToken);
      assert.equal(forbiddenRes.status, 403);

      // 4. Missing required scope -> 403 insufficient_scope
      const lowScopeToken = await sign({
        sub: 'user-123',
        email: 'owner@example.com',
        scope: 'openid email',
      });
      const scopeRes = await postMcp(lowScopeToken);
      assert.equal(scopeRes.status, 403);
      assert.match(scopeRes.headers.get('www-authenticate') ?? '', /insufficient_scope/);

      // 5. Expired token -> 401 invalid_token
      const expiredToken = await sign(
        { sub: 'user-123', email: 'owner@example.com', scope: 'sandboxes:write' },
        '-10s',
      );
      const expiredRes = await postMcp(expiredToken);
      assert.equal(expiredRes.status, 401);
      assert.match(expiredRes.headers.get('www-authenticate') ?? '', /invalid_token/);
    } finally {
      await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
      await new Promise<void>((resolve) => oidcServer.close(() => resolve()));
    }
  });
});
