import { FastMCP, type ContentResult } from 'fastmcp';
import { z } from 'zod';
import {
  SandboxGoogleProvider,
  createStaticBearerAuthenticate,
  isGoogleOAuthConfigured,
  type AuthConfig,
  type SandboxSession,
} from './auth.js';
import {
  DEFAULT_WORKSPACE,
  resolveCommandArgs,
  resolveSandboxPath,
  type SandboxService,
} from './sandbox-service.js';

const MAX_OUTPUT_CHARS = 32_000;

const SERVER_INSTRUCTIONS =
  'Manage isolated Docker Cloud Sandboxes for writing files, running commands, builds, tests, ' +
  'and background processes. Prefer apply_and_run to write files and execute a command in a ' +
  'single step, and clean up or stop sandboxes when finished.';

function truncateOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n\n...[truncated ${omitted} characters]`;
}

function jsonText(payload: unknown): ContentResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function errorText(err: unknown): ContentResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

export interface CreateSandboxMcpServerOptions {
  service: SandboxService;
  auth?: AuthConfig;
}

export interface SandboxMcpServerHandle {
  server: FastMCP<SandboxSession>;
  authProvider?: SandboxGoogleProvider;
  destroy(): void;
}

export function createSandboxMcpServer({
  service,
  auth = {},
}: CreateSandboxMcpServerOptions): SandboxMcpServerHandle {
  const workspace = resolveSandboxPath(service.workspace, DEFAULT_WORKSPACE);
  let authProvider: SandboxGoogleProvider | undefined;
  let authenticate:
    | ((request: import('node:http').IncomingMessage) => Promise<SandboxSession | undefined>)
    | undefined;

  if (isGoogleOAuthConfigured(auth)) {
    authProvider = new SandboxGoogleProvider(auth);
  } else if (auth.bearerToken) {
    authenticate = createStaticBearerAuthenticate(auth.bearerToken);
  }

  const server = new FastMCP<SandboxSession>({
    name: 'docker-sandbox-mcp',
    version: '0.1.0',
    instructions: SERVER_INSTRUCTIONS,
    ...(authProvider ? { auth: authProvider } : {}),
    ...(authenticate ? { authenticate } : {}),
    health: {
      enabled: true,
      path: '/healthz',
      status: 200,
      message: JSON.stringify({ status: 'ok', service: 'docker-sandbox-mcp' }),
    },
  });

  server.addTool({
    name: 'list_sandboxes',
    description: 'List all Docker Cloud Sandboxes in the authenticated account.',
    parameters: z.object({}),
    annotations: {
      title: 'List Sandboxes',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async () => {
      try {
        const sandboxes = await service.listSandboxes();
        return jsonText({ sandboxes });
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'get_sandbox',
    description:
      'Inspect the current status and metadata of a Docker Cloud Sandbox by resource name (e.g., sandboxes/<uid>).',
    parameters: z.object({
      sandboxName: z
        .string()
        .min(1)
        .describe('Resource name of the sandbox (e.g. sandboxes/<uid>).'),
    }),
    annotations: {
      title: 'Get Sandbox',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName }) => {
      try {
        const sandbox = await service.getSandbox(sandboxName);
        return jsonText(sandbox);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'create_sandbox',
    description:
      'Create a new isolated Docker Cloud Sandbox from a kit (defaults to "shell") and wait until it is running.',
    parameters: z.object({
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
    }),
    annotations: {
      title: 'Create Sandbox',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: async ({ kit, displayName, timeoutMs }) => {
      try {
        const sandbox = await service.createSandbox({ kit, displayName, timeoutMs });
        return jsonText(sandbox);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'apply_and_run',
    description:
      `Write one or more files into a sandbox and execute a command (such as build or test) in a single step. Relative paths resolve against cwd (default: ${workspace}). Provide either command (shell string) or args (argv array). Ideal for Gemini Web to minimize write confirmations.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the target sandbox.'),
      files: z
        .array(
          z.object({
            path: z
              .string()
              .min(1)
              .describe(`File path inside the sandbox (relative to cwd or absolute; default cwd: ${workspace}).`),
            content: z.string().describe('UTF-8 file contents to write.'),
          }),
        )
        .default([])
        .describe('Files to write before running the command.'),
      command: z
        .string()
        .min(1)
        .optional()
        .describe('Shell command string executed via `bash -lc` (supports pipes, &&, redirects, globs). Mutually exclusive with args.'),
      args: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Direct argv array to execute without a shell (e.g. ["npm", "test"]). Mutually exclusive with command.'),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe(`Working directory inside the sandbox (relative to ${workspace} or absolute; default: ${workspace}).`),
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
    }),
    annotations: {
      title: 'Apply Files and Run Command',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, files, command, args, cwd, env, timeoutMs }) => {
      try {
        const resolvedArgs = resolveCommandArgs({ command, args });
        const resolvedCwd = resolveSandboxPath(cwd, workspace);
        const resolvedFiles = files.map((f) => ({
          path: resolveSandboxPath(f.path, resolvedCwd),
          content: f.content,
        }));
        const res = await service.applyAndRun(sandboxName, {
          files: resolvedFiles,
          args: resolvedArgs,
          cwd: resolvedCwd,
          env,
          timeoutMs,
        });
        return jsonText({
          cwd: resolvedCwd,
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
  });

  server.addTool({
    name: 'run_command',
    description:
      `Execute a command inside a running Docker Cloud Sandbox and return exit code, stdout, and stderr. Provide either command (shell string) or args (argv array). Defaults to ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the target sandbox.'),
      command: z
        .string()
        .min(1)
        .optional()
        .describe('Shell command string executed via `bash -lc` (supports pipes, &&, redirects, globs). Mutually exclusive with args.'),
      args: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Direct argv array to execute without a shell (e.g. ["pytest", "-q"]). Mutually exclusive with command.'),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe(`Working directory inside the sandbox (relative to ${workspace} or absolute; default: ${workspace}).`),
      env: z.record(z.string(), z.string()).optional().describe('Optional environment variables.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(300_000)
        .optional()
        .describe('Command timeout in milliseconds (default: 120000).'),
    }),
    annotations: {
      title: 'Run Command',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, command, args, cwd, env, timeoutMs }) => {
      try {
        const resolvedArgs = resolveCommandArgs({ command, args });
        const resolvedCwd = resolveSandboxPath(cwd, workspace);
        const res = await service.runCommand(sandboxName, {
          args: resolvedArgs,
          cwd: resolvedCwd,
          env,
          timeoutMs,
        });
        return jsonText({
          cwd: resolvedCwd,
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
  });

  server.addTool({
    name: 'start_background_process',
    description:
      `Start a long-running command asynchronously inside a sandbox (such as a dev server or large build) and return its process handle for polling with get_process_output. Provide either command (shell string) or args (argv array). Defaults to ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the target sandbox.'),
      command: z
        .string()
        .min(1)
        .optional()
        .describe('Shell command string executed via `bash -lc`. Mutually exclusive with args.'),
      args: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Direct argv array to execute without a shell. Mutually exclusive with command.'),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe(`Working directory inside the sandbox (relative to ${workspace} or absolute; default: ${workspace}).`),
      env: z.record(z.string(), z.string()).optional().describe('Optional environment variables.'),
    }),
    annotations: {
      title: 'Start Background Process',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, command, args, cwd, env }) => {
      try {
        const resolvedArgs = resolveCommandArgs({ command, args });
        const resolvedCwd = resolveSandboxPath(cwd, workspace);
        const proc = await service.startProcess(sandboxName, {
          args: resolvedArgs,
          cwd: resolvedCwd,
          env,
        });
        return jsonText(proc);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'get_process_output',
    description: 'Read status and buffered output of a background process in a sandbox.',
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      processName: z
        .string()
        .min(1)
        .describe('Resource name of the process returned by start_background_process.'),
    }),
    annotations: {
      title: 'Get Process Output',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, processName }) => {
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
  });

  server.addTool({
    name: 'read_file',
    description: `Read a UTF-8 text file from a Docker Cloud Sandbox. Relative paths resolve against ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      path: z
        .string()
        .min(1)
        .describe(`File path inside the sandbox (relative to ${workspace} or absolute).`),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024)
        .optional()
        .describe('Maximum bytes to read (default: 262144).'),
    }),
    annotations: {
      title: 'Read File',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, path: filePath, maxBytes }) => {
      try {
        const resolvedPath = resolveSandboxPath(filePath, workspace);
        const content = await service.readFile(sandboxName, resolvedPath, maxBytes);
        return {
          content: [{ type: 'text', text: truncateOutput(content) }],
        };
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'list_files',
    description: `List files and directories at a given path inside a Docker Cloud Sandbox. Defaults to ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      path: z
        .string()
        .min(1)
        .default('.')
        .describe(`Directory path inside the sandbox (relative to ${workspace} or absolute; default: "." -> ${workspace}).`),
    }),
    annotations: {
      title: 'List Files',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, path: dirPath }) => {
      try {
        const resolvedPath = resolveSandboxPath(dirPath, workspace);
        const entries = await service.listFiles(sandboxName, resolvedPath);
        return jsonText({ path: resolvedPath, entries });
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'stop_sandbox',
    description: 'Stop a running Docker Cloud Sandbox to pause compute billing while keeping state.',
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox to stop.'),
    }),
    annotations: {
      title: 'Stop Sandbox',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName }) => {
      try {
        const sandbox = await service.stopSandbox(sandboxName);
        return jsonText(sandbox);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'start_sandbox',
    description: 'Start or resume a stopped Docker Cloud Sandbox and wait until it is running.',
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox to start.'),
    }),
    annotations: {
      title: 'Start Sandbox',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName }) => {
      try {
        const sandbox = await service.startSandbox(sandboxName);
        return jsonText(sandbox);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'delete_sandbox',
    description: 'Permanently delete a Docker Cloud Sandbox and release its stored resources.',
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox to delete.'),
      force: z
        .boolean()
        .default(true)
        .describe('Allow deleting even if the sandbox is currently running (default: true).'),
    }),
    annotations: {
      title: 'Delete Sandbox',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, force }) => {
      try {
        const res = await service.deleteSandbox(sandboxName, force);
        return jsonText(res);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  return {
    server,
    authProvider,
    destroy() {
      authProvider?.destroy();
    },
  };
}
