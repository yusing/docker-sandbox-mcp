import path from 'node:path';
import {
  Sandboxes,
  bearer,
  pat,
  type Authenticator,
  type Sandbox,
} from '@docker/sandboxes';

export const DEFAULT_WORKSPACE = '/workspace';

export function resolveSandboxPath(
  inputPath?: string,
  baseDir: string = DEFAULT_WORKSPACE,
): string {
  const normalizedBase = path.posix.resolve('/', baseDir || DEFAULT_WORKSPACE);
  if (!inputPath || inputPath === '.') {
    return normalizedBase;
  }
  return path.posix.resolve(normalizedBase, inputPath);
}

export interface SandboxEnvironmentInfo {
  user?: string;
  home?: string;
  platform?: string;
  shell?: string;
}

export interface SandboxSummary {
  name: string;
  uid: string;
  displayName?: string;
  status: string;
  workspace: string;
  expiresAt?: string;
  environment?: SandboxEnvironmentInfo;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  incomplete: boolean;
  processName?: string;
}

export interface ProcessSummary {
  name: string;
  status: string;
  exitCode?: number;
  pid?: number;
}

export interface ProcessOutputResult {
  process: ProcessSummary;
  output: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export interface FileWriteInput {
  path: string;
  content: string;
}

export interface CreateSandboxInput {
  kit?: string;
  displayName?: string;
  timeoutMs?: number;
}

export function resolveCommandArgs(input: { command?: string; args?: string[] }): string[] {
  const hasCommand = input.command !== undefined;
  const hasArgs = input.args !== undefined && input.args.length > 0;
  if (hasCommand && hasArgs) {
    throw new Error('Provide either "command" or "args", not both.');
  }
  if (hasCommand) {
    if (!input.command!.trim()) {
      throw new Error('"command" must not be empty.');
    }
    return ['bash', '-lc', input.command!];
  }
  if (hasArgs) {
    return input.args!;
  }
  throw new Error('Provide either "command" (shell string) or "args" (argv array).');
}

export interface RunCommandInput {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApplyAndRunInput {
  files: FileWriteInput[];
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApplyAndRunResult {
  writtenFiles: string[];
  commandResult: CommandResult;
}

export interface SandboxService {
  readonly workspace?: string;
  createSandbox(input: CreateSandboxInput): Promise<SandboxSummary>;
  listSandboxes(): Promise<SandboxSummary[]>;
  getSandbox(name: string): Promise<SandboxSummary>;
  stopSandbox(name: string): Promise<SandboxSummary>;
  startSandbox(name: string): Promise<SandboxSummary>;
  deleteSandbox(name: string, force?: boolean): Promise<{ deleted: string }>;
  runCommand(name: string, input: RunCommandInput): Promise<CommandResult>;
  startProcess(name: string, input: RunCommandInput): Promise<ProcessSummary>;
  getProcessOutput(name: string, processName: string): Promise<ProcessOutputResult>;
  writeFiles(name: string, files: FileWriteInput[]): Promise<{ writtenFiles: string[] }>;
  readFile(name: string, path: string, maxBytes?: number): Promise<string>;
  listFiles(name: string, path: string): Promise<FileEntry[]>;
  applyAndRun(name: string, input: ApplyAndRunInput): Promise<ApplyAndRunResult>;
  close(): Promise<void>;
}

export interface DockerAuthConfig {
  username?: string;
  personalAccessToken?: string;
  accessToken?: string;
}

export function createDockerAuthenticator(config: DockerAuthConfig): Authenticator {
  if (config.accessToken) {
    return bearer(config.accessToken);
  }
  if (config.username && config.personalAccessToken) {
    return pat({
      username: config.username,
      personalAccessToken: config.personalAccessToken,
    });
  }
  throw new Error(
    'Docker Sandboxes credentials missing: set DOCKER_ACCESS_TOKEN or both DOCKER_USERNAME and DOCKER_PAT.',
  );
}

function formatTimestamp(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function toSandboxSummary(
  sandbox: Sandbox,
  workspace: string,
  environment?: SandboxEnvironmentInfo,
): SandboxSummary {
  const expiresAt = formatTimestamp(sandbox.effectiveFeatures?.timeouts?.expiresAt);
  return {
    name: sandbox.name,
    uid: sandbox.uid,
    displayName: sandbox.displayName,
    status: sandbox.status,
    workspace,
    ...(expiresAt ? { expiresAt } : {}),
    ...(environment ? { environment } : {}),
  };
}

export class DockerSandboxService implements SandboxService {
  private readonly client: Sandboxes;
  readonly workspace: string;

  constructor(client: Sandboxes, workspace: string = DEFAULT_WORKSPACE) {
    this.client = client;
    this.workspace = resolveSandboxPath(workspace, DEFAULT_WORKSPACE);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DockerSandboxService {
    const auth = createDockerAuthenticator({
      username: env.DOCKER_USERNAME,
      personalAccessToken: env.DOCKER_PAT,
      accessToken: env.DOCKER_ACCESS_TOKEN,
    });
    const client = new Sandboxes({ auth });
    const workspace = env.SANDBOX_WORKSPACE?.trim() || DEFAULT_WORKSPACE;
    return new DockerSandboxService(client, workspace);
  }

  private async probeEnvironment(sandbox: Sandbox): Promise<SandboxEnvironmentInfo | undefined> {
    try {
      const res = await sandbox.processes.run(
        {
          args: [
            'sh',
            '-c',
            'printf "%s\\n%s\\n%s\\n%s\\n" "$(id -un 2>/dev/null || true)" "${HOME:-}" "$(uname -sm 2>/dev/null || true)" "${SHELL:-}"',
          ],
          workingDir: this.workspace,
        },
        { timeoutMs: 5_000 },
      );
      if (res.exitCode !== 0) return undefined;
      const [user, home, platform, shell] = res.stdout.split('\n').map((s) => s.trim());
      const info: SandboxEnvironmentInfo = {
        ...(user ? { user } : {}),
        ...(home ? { home } : {}),
        ...(platform ? { platform } : {}),
        ...(shell ? { shell } : {}),
      };
      return Object.keys(info).length > 0 ? info : undefined;
    } catch {
      return undefined;
    }
  }

  async createSandbox(input: CreateSandboxInput): Promise<SandboxSummary> {
    const kit = input.kit ?? 'shell';
    const sandbox = await this.client.kits.launchAndWait(
      kit,
      input.displayName ? { displayName: input.displayName } : undefined,
      input.timeoutMs ? { timeoutMs: input.timeoutMs } : undefined,
    );
    await sandbox.files.mkdir(this.workspace, { parents: true }).catch(() => {});
    const environment = await this.probeEnvironment(sandbox);
    return toSandboxSummary(sandbox, this.workspace, environment);
  }

  async listSandboxes(): Promise<SandboxSummary[]> {
    const page = await this.client.list();
    return page.items.map((s) => toSandboxSummary(s, this.workspace));
  }

  async getSandbox(name: string): Promise<SandboxSummary> {
    const sandbox = await this.client.get(name);
    return toSandboxSummary(sandbox, this.workspace);
  }

  async stopSandbox(name: string): Promise<SandboxSummary> {
    const sandbox = await this.client.get(name);
    const stopped = await sandbox.stop();
    const settled = await stopped.waitUntilStopped();
    return toSandboxSummary(settled, this.workspace);
  }

  async startSandbox(name: string): Promise<SandboxSummary> {
    const sandbox = await this.client.get(name);
    const started = await sandbox.start();
    const running = await started.waitUntilRunning();
    return toSandboxSummary(running, this.workspace);
  }

  async deleteSandbox(name: string, force = true): Promise<{ deleted: string }> {
    const sandbox = await this.client.get(name);
    const latest = await sandbox.refresh();
    const deleting = await latest.delete({ force });
    await deleting?.waitUntilDeleted();
    return { deleted: name };
  }

  async runCommand(name: string, input: RunCommandInput): Promise<CommandResult> {
    const args = resolveCommandArgs(input);
    const sandbox = await this.client.get(name);
    const workingDir = resolveSandboxPath(input.cwd, this.workspace);
    const result = await sandbox.processes.run(
      {
        args,
        workingDir,
        ...(input.env ? { env: input.env } : {}),
      },
      { timeoutMs: input.timeoutMs ?? 120_000 },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      incomplete: result.incomplete,
      processName: result.process?.name,
    };
  }

  async startProcess(name: string, input: RunCommandInput): Promise<ProcessSummary> {
    const args = resolveCommandArgs(input);
    const sandbox = await this.client.get(name);
    const workingDir = resolveSandboxPath(input.cwd, this.workspace);
    const proc = await sandbox.processes.start({
      args,
      workingDir,
      ...(input.env ? { env: input.env } : {}),
    });
    return {
      name: proc.name,
      status: proc.status,
      exitCode: proc.exitCode ?? undefined,
      pid: proc.pid,
    };
  }

  async getProcessOutput(name: string, processName: string): Promise<ProcessOutputResult> {
    const sandbox = await this.client.get(name);
    const proc = await sandbox.processes.get(processName);
    const refreshed = await proc.refresh();
    const outputRes = await refreshed.readOutput();
    const chunks = (outputRes as { chunks?: Array<{ data?: string }> }).chunks ?? [];
    const output = chunks.map((c) => c.data ?? '').join('');
    return {
      process: {
        name: refreshed.name,
        status: refreshed.status,
        exitCode: refreshed.exitCode ?? undefined,
        pid: refreshed.pid,
      },
      output,
    };
  }

  async writeFiles(name: string, files: FileWriteInput[]): Promise<{ writtenFiles: string[] }> {
    const sandbox = await this.client.get(name);
    const writtenFiles: string[] = [];
    for (const file of files) {
      const targetPath = resolveSandboxPath(file.path, this.workspace);
      await sandbox.files.write(targetPath, file.content);
      writtenFiles.push(targetPath);
    }
    return { writtenFiles };
  }

  async readFile(name: string, filePath: string, maxBytes = 256 * 1024): Promise<string> {
    const sandbox = await this.client.get(name);
    return sandbox.files.read(resolveSandboxPath(filePath, this.workspace), {
      encoding: 'utf8',
      maxBytes,
    });
  }

  async listFiles(name: string, dirPath: string): Promise<FileEntry[]> {
    const sandbox = await this.client.get(name);
    const resolvedDir = resolveSandboxPath(dirPath, this.workspace);
    const page = await sandbox.files.list(resolvedDir);
    return page.items.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        name: String(record.name ?? ''),
        path: String(record.path ?? ''),
        isDir: Boolean(record.isDir ?? record.type === 'directory'),
        size: typeof record.size === 'number' ? record.size : undefined,
      };
    });
  }

  async applyAndRun(name: string, input: ApplyAndRunInput): Promise<ApplyAndRunResult> {
    const args = resolveCommandArgs(input);
    const resolvedCwd = resolveSandboxPath(input.cwd, this.workspace);
    const resolvedFiles = input.files.map((file) => ({
      path: resolveSandboxPath(file.path, resolvedCwd),
      content: file.content,
    }));
    const { writtenFiles } = await this.writeFiles(name, resolvedFiles);
    const commandResult = await this.runCommand(name, {
      args,
      cwd: resolvedCwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
    });
    return { writtenFiles, commandResult };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
