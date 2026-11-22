import { authConfigFromEnv } from './auth.js';
import { createSandboxMcpServer } from './mcp-server.js';
import { DockerSandboxService } from './sandbox-service.js';

async function main(): Promise<void> {
  const service = DockerSandboxService.fromEnv(process.env);
  const transportMode = (process.env.MCP_TRANSPORT ?? 'http').toLowerCase();

  if (transportMode === 'stdio') {
    const { server, destroy } = createSandboxMcpServer({ service });
    await server.start({ transportType: 'stdio' });

    const shutdown = async () => {
      await server.stop();
      destroy();
      await service.close();
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
    return;
  }

  const host = process.env.HOST?.trim() || '0.0.0.0';
  const port = Number(process.env.PORT ?? 8080);
  const { server, destroy } = createSandboxMcpServer({
    service,
    auth: authConfigFromEnv(process.env),
  });

  await server.start({
    transportType: 'httpStream',
    httpStream: {
      host,
      port,
      endpoint: '/mcp',
      sseEndpoint: null,
      stateless: true,
    },
  });

  console.log(`docker-sandbox-mcp listening on ${host}:${port} (POST /mcp)`);

  const shutdown = async () => {
    await server.stop();
    destroy();
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
