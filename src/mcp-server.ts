import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SandboxService } from './sandbox-service.js';

const MAX_OUTPUT_CHARS = 32_000;

function truncateOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n\n...[truncated ${omitted} characters]`;
}

function jsonText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function errorText(err: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

export function createSandboxMcpServer(service: SandboxService): McpServer {
  const server = new McpServer({
    name: 'docker-sandbox-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'list_sandboxes',
    {
      title: 'List Sandboxes',
      description: 'List all Docker Cloud Sandboxes in the authenticated account.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const sandboxes = await service.listSandboxes();
        return jsonText({ sandboxes });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'get_sandbox',
    {
      title: 'Get Sandbox',
      description: 'Inspect the current status and metadata of a Docker Cloud Sandbox by resource name (e.g., sandboxes/<uid>).',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the sandbox (e.g. sandboxes/<uid>).'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sandboxName }) => {
      try {
        const sandbox = await service.getSandbox(sandboxName);
        return jsonText(sandbox);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'create_sandbox',
    {
      title: 'Create Sandbox',
      description:
        'Create a new isolated Docker Cloud Sandbox from a kit (defaults to "shell") and wait until it is running.',
      inputSchema: {
        kit: z
          .string()
          .min(1)
          .default('shell')
          .describe('Sandbox kit name or OCI reference (default: "shell").'),
        displayName: z
          .string()
          .min(1)
          .optional()
          .describe('Optional human-readable label for the sandbox.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600_000)
          .optional()
          .describe('Max wait time in milliseconds for the sandbox to start.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ kit, displayName, timeoutMs }) => {
      try {
        const sandbox = await service.createSandbox({ kit, displayName, timeoutMs });
        return jsonText(sandbox);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'apply_and_run',
    {
      title: 'Apply Files and Run Command',
      description:
        'Write one or more files into a sandbox and execute a command (such as build or test) in a single step. Ideal for Gemini Web to minimize write confirmations.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the target sandbox.'),
        files: z
          .array(
            z.object({
              path: z.string().min(1).describe('Absolute path inside the sandbox.'),
              content: z.string().describe('UTF-8 file contents to write.'),
            }),
          )
          .default([])
          .describe('Files to write before running the command.'),
        args: z
          .array(z.string().min(1))
          .min(1)
          .describe('Command and arguments to execute (e.g. ["sh", "-c", "npm test"]).'),
        cwd: z.string().min(1).optional().describe('Working directory inside the sandbox.'),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional environment variables for the command.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(300_000)
          .optional()
          .describe('Command timeout in milliseconds (default: 120000).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sandboxName, files, args, cwd, env, timeoutMs }) => {
      try {
        const res = await service.applyAndRun(sandboxName, {
          files,
          args,
          cwd,
          env,
          timeoutMs,
        });
        return jsonText({
          writtenFiles: res.writtenFiles,
          exitCode: res.commandResult.exitCode,
          incomplete: res.commandResult.incomplete,
          stdout: truncateOutput(res.commandResult.stdout),
          stderr: truncateOutput(res.commandResult.stderr),
        });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run Command',
      description: 'Execute a command inside a running Docker Cloud Sandbox and return exit code, stdout, and stderr.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the target sandbox.'),
        args: z
          .array(z.string().min(1))
          .min(1)
          .describe('Command and arguments to execute (e.g. ["bash", "-lc", "pytest"]).'),
        cwd: z.string().min(1).optional().describe('Working directory inside the sandbox.'),
        env: z.record(z.string(), z.string()).optional().describe('Optional environment variables.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(300_000)
          .optional()
          .describe('Command timeout in milliseconds (default: 120000).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sandboxName, args, cwd, env, timeoutMs }) => {
      try {
        const res = await service.runCommand(sandboxName, { args, cwd, env, timeoutMs });
        return jsonText({
          exitCode: res.exitCode,
          incomplete: res.incomplete,
          processName: res.processName,
          stdout: truncateOutput(res.stdout),
          stderr: truncateOutput(res.stderr),
        });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'start_background_process',
    {
      title: 'Start Background Process',
      description:
        'Start a long-running command asynchronously inside a sandbox (such as a dev server or large build) and return its process handle for polling with get_process_output.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the target sandbox.'),
        args: z.array(z.string().min(1)).min(1).describe('Command and arguments to execute.'),
        cwd: z.string().min(1).optional().describe('Working directory inside the sandbox.'),
        env: z.record(z.string(), z.string()).optional().describe('Optional environment variables.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sandboxName, args, cwd, env }) => {
      try {
        const proc = await service.startProcess(sandboxName, { args, cwd, env });
        return jsonText(proc);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'get_process_output',
    {
      title: 'Get Process Output',
      description: 'Read status and buffered output of a background process in a sandbox.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
        processName: z.string().min(1).describe('Resource name of the process returned by start_background_process.'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sandboxName, processName }) => {
      try {
        const res = await service.getProcessOutput(sandboxName, processName);
        return jsonText({
          process: res.process,
          output: truncateOutput(res.output),
        });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read File',
      description: 'Read a UTF-8 text file from a Docker Cloud Sandbox.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
        path: z.string().min(1).describe('Absolute path to the file inside the sandbox.'),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(1024 * 1024)
          .optional()
          .describe('Maximum bytes to read (default: 262144).'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sandboxName, path, maxBytes }) => {
      try {
        const content = await service.readFile(sandboxName, path, maxBytes);
        return {
          content: [{ type: 'text', text: truncateOutput(content) }],
        };
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'list_files',
    {
      title: 'List Files',
      description: 'List files and directories at a given path inside a Docker Cloud Sandbox.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
        path: z.string().min(1).default('/').describe('Directory path inside the sandbox.'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sandboxName, path }) => {
      try {
        const entries = await service.listFiles(sandboxName, path);
        return jsonText({ path, entries });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'stop_sandbox',
    {
      title: 'Stop Sandbox',
      description: 'Stop a running Docker Cloud Sandbox to pause compute billing while keeping state.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the sandbox to stop.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sandboxName }) => {
      try {
        const sandbox = await service.stopSandbox(sandboxName);
        return jsonText(sandbox);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'start_sandbox',
    {
      title: 'Start Sandbox',
      description: 'Start or resume a stopped Docker Cloud Sandbox and wait until it is running.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the sandbox to start.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sandboxName }) => {
      try {
        const sandbox = await service.startSandbox(sandboxName);
        return jsonText(sandbox);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'delete_sandbox',
    {
      title: 'Delete Sandbox',
      description: 'Permanently delete a Docker Cloud Sandbox and release its stored resources.',
      inputSchema: {
        sandboxName: z.string().min(1).describe('Resource name of the sandbox to delete.'),
        force: z
          .boolean()
          .default(true)
          .describe('Allow deleting even if the sandbox is currently running (default: true).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sandboxName, force }) => {
      try {
        const res = await service.deleteSandbox(sandboxName, force);
        return jsonText(res);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  return server;
}
