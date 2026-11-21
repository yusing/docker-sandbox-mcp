import {
  Sandboxes,
  bearer,
  pat,
  type Authenticator,
  type Sandbox,
} from '@docker/sandboxes';

export interface SandboxSummary {
  name: string;
  uid: string;
  displayName?: string;
  status: string;
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

export interface RunCommandInput {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApplyAndRunInput {
  files: FileWriteInput[];
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApplyAndRunResult {
  writtenFiles: string[];
  commandResult: CommandResult;
}

export interface SandboxService {
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

function toSandboxSummary(sandbox: Sandbox): SandboxSummary {
  return {
    name: sandbox.name,
    uid: sandbox.uid,
    displayName: sandbox.displayName,
    status: sandbox.status,
  };
}

export class DockerSandboxService implements SandboxService {
  private readonly client: Sandboxes;

  constructor(client: Sandboxes) {
    this.client = client;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DockerSandboxService {
    const auth = createDockerAuthenticator({
      username: env.DOCKER_USERNAME,
      personalAccessToken: env.DOCKER_PAT,
      accessToken: env.DOCKER_ACCESS_TOKEN,
    });
    const client = new Sandboxes({ auth });
    return new DockerSandboxService(client);
  }

  async createSandbox(input: CreateSandboxInput): Promise<SandboxSummary> {
    const kit = input.kit ?? 'shell';
    const sandbox = await this.client.kits.launchAndWait(
      kit,
      input.displayName ? { displayName: input.displayName } : undefined,
      input.timeoutMs ? { timeoutMs: input.timeoutMs } : undefined,
    );
    return toSandboxSummary(sandbox);
  }

  async listSandboxes(): Promise<SandboxSummary[]> {
    const page = await this.client.list();
    return page.items.map(toSandboxSummary);
  }

  async getSandbox(name: string): Promise<SandboxSummary> {
    const sandbox = await this.client.get(name);
    return toSandboxSummary(sandbox);
  }

  async stopSandbox(name: string): Promise<SandboxSummary> {
    const sandbox = await this.client.get(name);
    const stopped = await sandbox.stop();
    const settled = await stopped.waitUntilStopped();
    return toSandboxSummary(settled);
  }

  async startSandbox(name: string): Promise<SandboxSummary> {
    const sandbox = await this.client.get(name);
    const started = await sandbox.start();
    const running = await started.waitUntilRunning();
    return toSandboxSummary(running);
  }

  async deleteSandbox(name: string, force = true): Promise<{ deleted: string }> {
    const sandbox = await this.client.get(name);
    const latest = await sandbox.refresh();
    const deleting = await latest.delete({ force });
    await deleting?.waitUntilDeleted();
    return { deleted: name };
  }

  async runCommand(name: string, input: RunCommandInput): Promise<CommandResult> {
    const sandbox = await this.client.get(name);
    const result = await sandbox.processes.run(
      {
        args: input.args,
        ...(input.cwd ? { workdir: input.cwd } : {}),
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
    const sandbox = await this.client.get(name);
    const proc = await sandbox.processes.start({
      args: input.args,
      ...(input.cwd ? { workdir: input.cwd } : {}),
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
      await sandbox.files.write(file.path, file.content);
      writtenFiles.push(file.path);
    }
    return { writtenFiles };
  }

  async readFile(name: string, path: string, maxBytes = 256 * 1024): Promise<string> {
    const sandbox = await this.client.get(name);
    return sandbox.files.read(path, { encoding: 'utf8', maxBytes });
  }

  async listFiles(name: string, path: string): Promise<FileEntry[]> {
    const sandbox = await this.client.get(name);
    const page = await sandbox.files.list(path);
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
    const { writtenFiles } = await this.writeFiles(name, input.files);
    const commandResult = await this.runCommand(name, {
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
    });
    return { writtenFiles, commandResult };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
