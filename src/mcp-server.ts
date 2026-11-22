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

export interface FormatFileLinesOptions {
  startLine?: number;
  endLine?: number;
  lineNumbers?: boolean;
}

export function formatFileLines(
  content: string,
  options: FormatFileLinesOptions = {},
): string {
  const { startLine, endLine, lineNumbers = true } = options;
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new Error(`endLine (${endLine}) must be greater than or equal to startLine (${startLine}).`);
  }

  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = normalized.length === 0 ? [] : normalized.split(/\r?\n/);
  const totalLines = lines.length;

  const start = startLine ?? 1;
  const end = Math.min(endLine ?? totalLines, totalLines);

  if (totalLines === 0 || start > totalLines) {
    return totalLines === 0
      ? ''
      : `[No lines in range ${start}-${endLine ?? totalLines}; file has ${totalLines} lines]`;
  }

  const sliced = lines.slice(start - 1, end);
  const body = lineNumbers
    ? sliced.map((line, idx) => `${start + idx}\t${line}`).join('\n')
    : sliced.join('\n');

  if (start > 1 || end < totalLines) {
    return `${body}\n\n[Showing lines ${start}-${end} of ${totalLines}]`;
  }
  return body;
}

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
      `Write, edit, or delete files in a sandbox and optionally execute a command (such as build or test) in a single step. Relative paths resolve against cwd (default: ${workspace}). Command/args are optional for file-only batches. Ideal for Gemini Web to minimize write confirmations.`,
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
      edits: z
        .array(
          z.object({
            path: z
              .string()
              .min(1)
              .describe(`File path to edit (relative to cwd or absolute; default cwd: ${workspace}).`),
            oldText: z.string().min(1).describe('Exact text to replace.'),
            newText: z.string().describe('Replacement text.'),
            replaceAll: z
              .boolean()
              .default(false)
              .describe('Replace all occurrences instead of requiring a single unique match (default: false).'),
          }),
        )
        .default([])
        .describe('Targeted search/replace edits to apply after writing files.'),
      deletes: z
        .array(z.string().min(1))
        .default([])
        .describe(`File paths to delete (relative to cwd or absolute; default cwd: ${workspace}).`),
      command: z
        .string()
        .min(1)
        .optional()
        .describe('Optional shell command string executed via `bash -lc` (supports pipes, &&, redirects, globs). Mutually exclusive with args.'),
      args: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Optional direct argv array to execute without a shell (e.g. ["npm", "test"]). Mutually exclusive with command.'),
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
    execute: async ({ sandboxName, files, edits, deletes, command, args, cwd, env, timeoutMs }) => {
      try {
        const hasCommand = command !== undefined || (args !== undefined && args.length > 0);
        const resolvedArgs = hasCommand ? resolveCommandArgs({ command, args }) : undefined;
        if (!resolvedArgs && files.length === 0 && edits.length === 0 && deletes.length === 0) {
          throw new Error(
            'Provide at least one file operation (files, edits, deletes) or a command/args to run.',
          );
        }
        const resolvedCwd = resolveSandboxPath(cwd, workspace);
        const resolvedFiles = files.map((f) => ({
          path: resolveSandboxPath(f.path, resolvedCwd),
          content: f.content,
        }));
        const resolvedEdits = edits.map((e) => ({
          ...e,
          path: resolveSandboxPath(e.path, resolvedCwd),
        }));
        const resolvedDeletes = deletes.map((d) => resolveSandboxPath(d, resolvedCwd));
        const res = await service.applyAndRun(sandboxName, {
          files: resolvedFiles,
          edits: resolvedEdits,
          deletes: resolvedDeletes,
          ...(resolvedArgs ? { args: resolvedArgs } : {}),
          cwd: resolvedCwd,
          env,
          timeoutMs,
        });
        return jsonText({
          cwd: resolvedCwd,
          writtenFiles: res.writtenFiles,
          ...(res.editedFiles.length > 0 ? { editedFiles: res.editedFiles } : {}),
          ...(res.deletedFiles.length > 0 ? { deletedFiles: res.deletedFiles } : {}),
          ...(res.commandResult
            ? {
                exitCode: res.commandResult.exitCode,
                incomplete: res.commandResult.incomplete,
                stdout: truncateOutput(res.commandResult.stdout),
                stderr: truncateOutput(res.commandResult.stderr),
              }
            : {}),
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
    description: `Read a UTF-8 text file from a Docker Cloud Sandbox with optional line range and line numbers. Relative paths resolve against ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      path: z
        .string()
        .min(1)
        .describe(`File path inside the sandbox (relative to ${workspace} or absolute).`),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-based starting line number (inclusive).'),
      endLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-based ending line number (inclusive).'),
      lineNumbers: z
        .boolean()
        .default(true)
        .describe('Prefix each line with its 1-based line number (default: true).'),
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
    execute: async ({ sandboxName, path: filePath, startLine, endLine, lineNumbers, maxBytes }) => {
      try {
        const resolvedPath = resolveSandboxPath(filePath, workspace);
        const content = await service.readFile(sandboxName, resolvedPath, maxBytes);
        const formatted = formatFileLines(content, { startLine, endLine, lineNumbers });
        return {
          content: [{ type: 'text', text: truncateOutput(formatted) }],
        };
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'list_files',
    description: `List files and directories at a given path inside a Docker Cloud Sandbox, with optional bounded recursion. Defaults to ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      path: z
        .string()
        .min(1)
        .default('.')
        .describe(`Directory path inside the sandbox (relative to ${workspace} or absolute; default: "." -> ${workspace}).`),
      recursive: z
        .boolean()
        .default(false)
        .describe('Recursively traverse subdirectories (default: false).'),
      maxDepth: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe('Maximum traversal depth when recursive is true (default: 3, max: 10).'),
      maxEntries: z
        .number()
        .int()
        .positive()
        .max(1000)
        .default(200)
        .describe('Maximum number of entries to return (default: 200, max: 1000).'),
    }),
    annotations: {
      title: 'List Files',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, path: dirPath, recursive, maxDepth, maxEntries }) => {
      try {
        const resolvedPath = resolveSandboxPath(dirPath, workspace);
        const entries = await service.listFiles(sandboxName, resolvedPath, {
          recursive,
          maxDepth,
          maxEntries,
        });
        return jsonText({ path: resolvedPath, entries });
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'glob_files',
    description: `Find files matching a glob pattern inside a Docker Cloud Sandbox (read-only). Defaults to ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      pattern: z
        .string()
        .min(1)
        .describe('Glob pattern to match (e.g. "**/*.ts", "src/*.json", "*.test.{ts,js}").'),
      path: z
        .string()
        .min(1)
        .default('.')
        .describe(`Base directory to search (relative to ${workspace} or absolute; default: "." -> ${workspace}).`),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(1000)
        .default(200)
        .describe('Maximum number of matching file paths to return (default: 200).'),
    }),
    annotations: {
      title: 'Glob Files',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, pattern, path: dirPath, maxResults }) => {
      try {
        const resolvedPath = resolveSandboxPath(dirPath, workspace);
        const res = await service.globFiles(sandboxName, {
          pattern,
          path: resolvedPath,
          maxResults,
        });
        return jsonText(res);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'search_files',
    description: `Search file contents by regex or fixed string inside a Docker Cloud Sandbox (read-only, uses rg with grep fallback). Defaults to ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      pattern: z.string().min(1).describe('Regular expression or literal string to search for.'),
      path: z
        .string()
        .min(1)
        .default('.')
        .describe(`Directory to search (relative to ${workspace} or absolute; default: "." -> ${workspace}).`),
      glob: z
        .string()
        .min(1)
        .optional()
        .describe('Optional file glob filter (e.g. "*.ts", "src/**/*.js").'),
      caseSensitive: z
        .boolean()
        .default(true)
        .describe('Perform case-sensitive matching (default: true).'),
      fixedStrings: z
        .boolean()
        .default(false)
        .describe('Treat pattern as a literal string instead of a regex (default: false).'),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(500)
        .default(100)
        .describe('Maximum number of matching lines to return (default: 100).'),
    }),
    annotations: {
      title: 'Search Files',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({
      sandboxName,
      pattern,
      path: dirPath,
      glob,
      caseSensitive,
      fixedStrings,
      maxResults,
    }) => {
      try {
        const resolvedPath = resolveSandboxPath(dirPath, workspace);
        const res = await service.searchFiles(sandboxName, {
          pattern,
          path: resolvedPath,
          glob,
          caseSensitive,
          fixedStrings,
          maxResults,
        });
        return jsonText(res);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'edit_file',
    description: `Apply a targeted search-and-replace edit to a UTF-8 file inside a Docker Cloud Sandbox without rewriting the entire file. Relative paths resolve against ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      path: z
        .string()
        .min(1)
        .describe(`File path inside the sandbox (relative to ${workspace} or absolute).`),
      oldText: z.string().min(1).describe('Exact text to find and replace.'),
      newText: z.string().describe('Replacement text.'),
      replaceAll: z
        .boolean()
        .default(false)
        .describe('Replace every occurrence instead of requiring a single unique match (default: false).'),
    }),
    annotations: {
      title: 'Edit File',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, path: filePath, oldText, newText, replaceAll }) => {
      try {
        const resolvedPath = resolveSandboxPath(filePath, workspace);
        const res = await service.editFile(sandboxName, {
          path: resolvedPath,
          oldText,
          newText,
          replaceAll,
        });
        return jsonText(res);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'stat_file',
    description: `Inspect metadata (type, size, mode, symlink target) for a path inside a Docker Cloud Sandbox. Relative paths resolve against ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      path: z
        .string()
        .min(1)
        .describe(`Path inside the sandbox (relative to ${workspace} or absolute).`),
    }),
    annotations: {
      title: 'Stat File',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, path: filePath }) => {
      try {
        const resolvedPath = resolveSandboxPath(filePath, workspace);
        const info = await service.statFile(sandboxName, resolvedPath);
        return jsonText(info);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'mkdir',
    description: `Create a directory (and parent directories by default) inside a Docker Cloud Sandbox. Relative paths resolve against ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      path: z
        .string()
        .min(1)
        .describe(`Directory path to create (relative to ${workspace} or absolute).`),
      parents: z
        .boolean()
        .default(true)
        .describe('Create parent directories as needed (default: true).'),
    }),
    annotations: {
      title: 'Create Directory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, path: dirPath, parents }) => {
      try {
        const resolvedPath = resolveSandboxPath(dirPath, workspace);
        const res = await service.mkdir(sandboxName, resolvedPath, parents);
        return jsonText(res);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'move_file',
    description: `Move or rename a file or directory inside a Docker Cloud Sandbox. Relative paths resolve against ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      from: z
        .string()
        .min(1)
        .describe(`Source path (relative to ${workspace} or absolute).`),
      to: z
        .string()
        .min(1)
        .describe(`Destination path (relative to ${workspace} or absolute).`),
    }),
    annotations: {
      title: 'Move File',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, from, to }) => {
      try {
        const resolvedFrom = resolveSandboxPath(from, workspace);
        const resolvedTo = resolveSandboxPath(to, workspace);
        const res = await service.moveFile(sandboxName, resolvedFrom, resolvedTo);
        return jsonText(res);
      } catch (err) {
        return errorText(err);
      }
    },
  });

  server.addTool({
    name: 'remove_file',
    description: `Delete a file or directory inside a Docker Cloud Sandbox. Relative paths resolve against ${workspace}.`,
    parameters: z.object({
      sandboxName: z.string().min(1).describe('Resource name of the sandbox.'),
      path: z
        .string()
        .min(1)
        .describe(`Path to delete (relative to ${workspace} or absolute).`),
      recursive: z
        .boolean()
        .default(false)
        .describe('Recursively delete directories and their contents (default: false).'),
    }),
    annotations: {
      title: 'Remove File',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async ({ sandboxName, path: targetPath, recursive }) => {
      try {
        const resolvedPath = resolveSandboxPath(targetPath, workspace);
        const res = await service.removeFile(sandboxName, resolvedPath, recursive);
        return jsonText(res);
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
