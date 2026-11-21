import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface AuthConfig {
  bearerToken?: string;
  publicUrl?: string;
  oauthIssuer?: string;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Bearer-token authentication middleware for remote MCP endpoints.
 * When MCP_BEARER_TOKEN is configured, every /mcp request must carry
 * `Authorization: Bearer <token>`.
 */
export function createAuthMiddleware(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.bearerToken) {
      next();
      return;
    }

    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !constantTimeEquals(match[1], config.bearerToken)) {
      const resourceMeta = config.publicUrl
        ? `, resource_metadata="${config.publicUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource"`
        : '';
      res.setHeader('WWW-Authenticate', `Bearer realm="docker-sandbox-mcp"${resourceMeta}`);
      res.status(401).json({
        error: 'unauthorized',
        message: 'Valid Bearer token required.',
      });
      return;
    }

    next();
  };
}

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata document for MCP clients
 * (such as Gemini Web Connected Apps) when fronting the server with an OAuth IdP.
 */
export function buildProtectedResourceMetadata(config: AuthConfig): Record<string, unknown> {
  const resource = (config.publicUrl ?? 'http://localhost:8080').replace(/\/$/, '');
  return {
    resource: `${resource}/mcp`,
    ...(config.oauthIssuer ? { authorization_servers: [config.oauthIssuer] } : {}),
    bearer_methods_supported: ['header'],
    scopes_supported: ['sandboxes:read', 'sandboxes:write'],
  };
}
