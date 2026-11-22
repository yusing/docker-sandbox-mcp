import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  authConfigFromEnv,
  buildProtectedResourceMetadata,
  createAuthMiddleware,
  type AuthConfig,
} from './auth.js';
import { createSandboxMcpServer } from './mcp-server.js';
import { DockerSandboxService, type SandboxService } from './sandbox-service.js';

export interface HttpAppOptions {
  service: SandboxService;
  auth?: AuthConfig;
}

export function createHttpApp({ service, auth = {} }: HttpAppOptions): Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'docker-sandbox-mcp' });
  });

  // RFC 9728 Protected Resource Metadata (root and path-scoped variants)
  const serveResourceMetadata = (req: Request, res: Response) => {
    res.status(200).json(buildProtectedResourceMetadata(auth, req));
  };
  app.get('/.well-known/oauth-protected-resource', serveResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', serveResourceMetadata);

  // Fallback RFC 8414 Authorization Server Metadata proxy for clients that query
  // /.well-known/oauth-authorization-server directly on the MCP host.
  if (auth.oauthIssuer) {
    const issuerBase = auth.oauthIssuer.replace(/\/$/, '');
    let cachedAsMeta: { data: unknown; expiresAt: number } | undefined;
    app.get('/.well-known/oauth-authorization-server', async (_req: Request, res: Response) => {
      try {
        const now = Date.now();
        if (!cachedAsMeta || cachedAsMeta.expiresAt <= now) {
          const upstream = await fetch(`${issuerBase}/.well-known/openid-configuration`, {
            headers: { accept: 'application/json' },
          });
          if (!upstream.ok) {
            res.status(502).json({ error: 'upstream_oidc_discovery_failed' });
            return;
          }
          cachedAsMeta = {
            data: await upstream.json(),
            expiresAt: now + 5 * 60_000,
          };
        }
        res.status(200).json(cachedAsMeta.data);
      } catch {
        res.status(502).json({ error: 'upstream_oidc_discovery_failed' });
      }
    });
  }

  const authMiddleware = createAuthMiddleware(auth);

  // Stateless Streamable HTTP handler — ideal for Cloud Run autoscaling & scale-to-zero.
  app.post('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const server = createSandboxMcpServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', authMiddleware, (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed in stateless Streamable HTTP mode. Use POST /mcp.',
      },
      id: null,
    });
  });

  app.delete('/mcp', authMiddleware, (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Session termination is not required in stateless mode.',
      },
      id: null,
    });
  });

  return app;
}

async function main(): Promise<void> {
  const service = DockerSandboxService.fromEnv(process.env);
  const transportMode = (process.env.MCP_TRANSPORT ?? 'http').toLowerCase();

  if (transportMode === 'stdio') {
    const server = createSandboxMcpServer(service);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const port = Number(process.env.PORT ?? 8080);
  const app = createHttpApp({
    service,
    auth: authConfigFromEnv(process.env),
  });

  const httpServer = app.listen(port, () => {
    console.log(`docker-sandbox-mcp listening on port ${port} (POST /mcp)`);
  });

  const shutdown = async () => {
    httpServer.close();
    await service.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

const isDirectRun =
  process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;

if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
