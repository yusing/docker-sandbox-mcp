import path from 'node:path';
import {
  Sandboxes,
  bearer,
  pat,
  type Authenticator,
  type ComputeSize,
  type Kit,
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

export type ProcessSignal = 'term' | 'kill' | 'int' | 'hup' | 'quit' | 'usr1' | 'usr2';

export interface GetProcessOutputOptions {
  resumeFrom?: string | number;
  maxBytes?: number;
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
  nextResumeFrom?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export interface ListFilesOptions {
  recursive?: boolean;
  maxDepth?: number;
  maxEntries?: number;
}

export interface GlobFilesInput {
  pattern: string;
  path?: string;
  maxResults?: number;
}

export interface GlobFilesResult {
  basePath: string;
  matches: string[];
  truncated: boolean;
}

export interface SearchFilesInput {
  pattern: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  fixedStrings?: boolean;
  maxResults?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchFilesResult {
  basePath: string;
  matches: SearchMatch[];
  truncated: boolean;
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, '');
  let regex = '^';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
          continue;
        }
        regex += '.*';
        i += 2;
        continue;
      }
      regex += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '{') {
      const close = normalized.indexOf('}', i + 1);
      if (close !== -1) {
        const alts = normalized
          .slice(i + 1, close)
          .split(',')
          .map((alt) => alt.replace(/[.+^$|()[\]\\]/g, '\\$&'));
        regex += `(?:${alts.join('|')})`;
        i = close + 1;
        continue;
      }
    }
    regex += ch.replace(/[.+^$|()[\]\\]/g, '\\$&');
    i += 1;
  }
  regex += '$';
  return new RegExp(regex);
}

export function matchesGlob(relativePath: string, pattern: string): boolean {
  const clean = relativePath.replace(/^\.\//, '');
  const re = globToRegExp(pattern);
  if (re.test(clean)) return true;
  if (!pattern.includes('/')) {
    return re.test(path.posix.basename(clean));
  }
  return false;
}

export interface FileWriteInput {
  path: string;
  content: string;
}

export interface FileEditInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface FileEditResult {
  path: string;
  replacements: number;
}

export interface FileStatResult {
  path: string;
  isDir: boolean;
  type: string;
  size?: number;
  mode?: number;
  linkTarget?: string;
}

export function applyTextEdit(
  content: string,
  edit: { oldText: string; newText: string; replaceAll?: boolean },
): { content: string; replacements: number } {
  const { oldText, newText, replaceAll = false } = edit;
  if (!oldText) {
    throw new Error('oldText must not be empty.');
  }
  if (oldText === newText) {
    throw new Error('newText must differ from oldText.');
  }
  const parts = content.split(oldText);
  const count = parts.length - 1;
  if (count === 0) {
    throw new Error('oldText not found in file.');
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `oldText matched ${count} times; provide more surrounding context or set replaceAll: true.`,
    );
  }
  if (replaceAll) {
    return { content: parts.join(newText), replacements: count };
  }
  const idx = content.indexOf(oldText);
  return {
    content: content.slice(0, idx) + newText + content.slice(idx + oldText.length),
    replacements: 1,
  };
}

export type SandboxComputeSize = ComputeSize;

export type KitSummary = Kit;

export type PortProtocol = 'tcp';

export interface PortSummary {
  name?: string;
  number: number;
  protocol?: string;
  url?: string;
}

export interface CreateSandboxInput {
  kit?: string;
  displayName?: string;
  resources?: SandboxComputeSize;
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
  files?: FileWriteInput[];
  edits?: FileEditInput[];
  deletes?: string[];
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApplyAndRunResult {
  writtenFiles: string[];
  editedFiles: FileEditResult[];
  deletedFiles: string[];
  commandResult?: CommandResult;
}

export interface SandboxService {
  readonly workspace?: string;
  createSandbox(input: CreateSandboxInput): Promise<SandboxSummary>;
  listKits(): Promise<KitSummary[]>;
  listSandboxes(): Promise<SandboxSummary[]>;
  getSandbox(name: string): Promise<SandboxSummary>;
  stopSandbox(name: string): Promise<SandboxSummary>;
  startSandbox(name: string): Promise<SandboxSummary>;
  deleteSandbox(name: string, force?: boolean): Promise<{ deleted: string }>;
  exposePort(name: string, port: number, protocol?: PortProtocol): Promise<PortSummary>;
  listPorts(name: string): Promise<PortSummary[]>;
  runCommand(name: string, input: RunCommandInput): Promise<CommandResult>;
  startProcess(name: string, input: RunCommandInput): Promise<ProcessSummary>;
  getProcessOutput(
    name: string,
    processName: string,
    options?: GetProcessOutputOptions,
  ): Promise<ProcessOutputResult>;
  listProcesses(name: string): Promise<ProcessSummary[]>;
  stopProcess(name: string, processName: string, signal?: ProcessSignal): Promise<ProcessSummary>;
  writeFiles(name: string, files: FileWriteInput[]): Promise<{ writtenFiles: string[] }>;
  editFile(name: string, input: FileEditInput): Promise<FileEditResult>;
  readFile(name: string, path: string, maxBytes?: number): Promise<string>;
  statFile(name: string, path: string): Promise<FileStatResult>;
  mkdir(name: string, path: string, parents?: boolean): Promise<{ path: string }>;
  moveFile(name: string, from: string, to: string): Promise<{ from: string; to: string }>;
  removeFile(
    name: string,
    path: string,
    recursive?: boolean,
  ): Promise<{ removed: string; recursive: boolean }>;
  listFiles(name: string, path: string, options?: ListFilesOptions): Promise<FileEntry[]>;
  globFiles(name: string, input: GlobFilesInput): Promise<GlobFilesResult>;
  searchFiles(name: string, input: SearchFilesInput): Promise<SearchFilesResult>;
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
    const launchOptions = {
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.resources ? { resources: input.resources } : {}),
    };
    const sandbox = await this.client.kits.launchAndWait(
      kit,
      Object.keys(launchOptions).length > 0 ? launchOptions : undefined,
      input.timeoutMs ? { timeoutMs: input.timeoutMs } : undefined,
    );
    await sandbox.files.mkdir(this.workspace, { parents: true }).catch(() => {});
    const environment = await this.probeEnvironment(sandbox);
    return toSandboxSummary(sandbox, this.workspace, environment);
  }

  async listKits(): Promise<KitSummary[]> {
    return this.client.kits.list();
  }

  async listSandboxes(): Promise<SandboxSummary[]> {
    const sandboxes: SandboxSummary[] = [];
    for await (const sandbox of this.client.all()) {
      sandboxes.push(toSandboxSummary(sandbox, this.workspace));
    }
    return sandboxes;
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

  async exposePort(
    name: string,
    portNumber: number,
    protocol: PortProtocol = 'tcp',
  ): Promise<PortSummary> {
    const sandbox = await this.client.get(name);
    const port = await sandbox.ports.create({ number: portNumber, protocol });
    return {
      ...(port.name ? { name: port.name } : {}),
      number: port.number,
      ...(port.protocol ? { protocol: port.protocol } : {}),
      ...(port.url ? { url: port.url } : {}),
    };
  }

  async listPorts(name: string): Promise<PortSummary[]> {
    const sandbox = await this.client.get(name);
    const res = await sandbox.ports.list();
    return (res.published ?? []).map((port) => ({
      ...(port.name ? { name: port.name } : {}),
      number: port.number,
      ...(port.protocol ? { protocol: port.protocol } : {}),
      ...(port.url ? { url: port.url } : {}),
    }));
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

  async getProcessOutput(
    name: string,
    processName: string,
    options: GetProcessOutputOptions = {},
  ): Promise<ProcessOutputResult> {
    const sandbox = await this.client.get(name);
    const proc = await sandbox.processes.get(processName);
    const refreshed = await proc.refresh();
    const readInput = {
      ...(options.resumeFrom !== undefined ? { resumeFrom: options.resumeFrom } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    };
    const outputRes = await refreshed.readOutput(readInput);
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const chunks =
      (outputRes as { chunks?: Array<{ data?: Uint8Array | string }> }).chunks ?? [];
    const output = chunks
      .map((c) => {
        if (!c.data) return '';
        return typeof c.data === 'string' ? c.data : decoder.decode(c.data, { stream: true });
      })
      .join('') + decoder.decode();
    const nextResumeFrom =
      outputRes.nextResumeFrom !== undefined ? String(outputRes.nextResumeFrom) : undefined;
    return {
      process: {
        name: refreshed.name,
        status: refreshed.status,
        exitCode: refreshed.exitCode ?? undefined,
        pid: refreshed.pid,
      },
      output,
      ...(nextResumeFrom !== undefined ? { nextResumeFrom } : {}),
    };
  }

  async listProcesses(name: string): Promise<ProcessSummary[]> {
    const sandbox = await this.client.get(name);
    const processes: ProcessSummary[] = [];
    for await (const proc of sandbox.processes.all()) {
      processes.push({
        name: proc.name,
        status: proc.status,
        exitCode: proc.exitCode ?? undefined,
        pid: proc.pid,
      });
    }
    return processes;
  }

  async stopProcess(
    name: string,
    processName: string,
    signal: ProcessSignal = 'term',
  ): Promise<ProcessSummary> {
    const sandbox = await this.client.get(name);
    const proc = await sandbox.processes.get(processName);
    await proc.signal(signal);
    const refreshed = await proc.refresh();
    return {
      name: refreshed.name,
      status: refreshed.status,
      exitCode: refreshed.exitCode ?? undefined,
      pid: refreshed.pid,
    };
  }

  async writeFiles(name: string, files: FileWriteInput[]): Promise<{ writtenFiles: string[] }> {
    const sandbox = await this.client.get(name);
    const writtenFiles = await Promise.all(
      files.map(async (file) => {
        const targetPath = resolveSandboxPath(file.path, this.workspace);
        await sandbox.files.write(targetPath, file.content);
        return targetPath;
      }),
    );
    return { writtenFiles };
  }

  async editFile(name: string, input: FileEditInput): Promise<FileEditResult> {
    const sandbox = await this.client.get(name);
    const targetPath = resolveSandboxPath(input.path, this.workspace);
    const current = await sandbox.files.read(targetPath, { encoding: 'utf8' });
    const { content, replacements } = applyTextEdit(current, input);
    await sandbox.files.write(targetPath, content);
    return { path: targetPath, replacements };
  }

  async readFile(name: string, filePath: string, maxBytes = 256 * 1024): Promise<string> {
    const sandbox = await this.client.get(name);
    return sandbox.files.read(resolveSandboxPath(filePath, this.workspace), {
      encoding: 'utf8',
      maxBytes,
    });
  }

  async statFile(name: string, filePath: string): Promise<FileStatResult> {
    const sandbox = await this.client.get(name);
    const resolvedPath = resolveSandboxPath(filePath, this.workspace);
    const res = await sandbox.files.stat(resolvedPath);
    const info = res.info;
    const rawSize = info?.size;
    const size =
      typeof rawSize === 'number'
        ? rawSize
        : typeof rawSize === 'string' && rawSize.trim() !== '' && !Number.isNaN(Number(rawSize))
          ? Number(rawSize)
          : undefined;
    const type = info?.type ?? (info?.isDir ? 'directory' : 'regular');
    return {
      path: info?.path ? resolveSandboxPath(info.path, this.workspace) : resolvedPath,
      isDir: Boolean(info?.isDir ?? info?.type === 'directory'),
      type,
      ...(size !== undefined ? { size } : {}),
      ...(info?.mode !== undefined ? { mode: info.mode } : {}),
      ...(info?.linkTarget ? { linkTarget: info.linkTarget } : {}),
    };
  }

  async mkdir(name: string, dirPath: string, parents = true): Promise<{ path: string }> {
    const sandbox = await this.client.get(name);
    const resolvedPath = resolveSandboxPath(dirPath, this.workspace);
    await sandbox.files.mkdir(resolvedPath, { parents });
    return { path: resolvedPath };
  }

  async moveFile(name: string, from: string, to: string): Promise<{ from: string; to: string }> {
    const sandbox = await this.client.get(name);
    const resolvedFrom = resolveSandboxPath(from, this.workspace);
    const resolvedTo = resolveSandboxPath(to, this.workspace);
    await sandbox.files.move(resolvedFrom, resolvedTo);
    return { from: resolvedFrom, to: resolvedTo };
  }

  async removeFile(
    name: string,
    targetPath: string,
    recursive = false,
  ): Promise<{ removed: string; recursive: boolean }> {
    const sandbox = await this.client.get(name);
    const resolvedPath = resolveSandboxPath(targetPath, this.workspace);
    await sandbox.files.remove(resolvedPath, { recursive });
    return { removed: resolvedPath, recursive };
  }

  async listFiles(
    name: string,
    dirPath: string,
    options: ListFilesOptions = {},
  ): Promise<FileEntry[]> {
    const sandbox = await this.client.get(name);
    const resolvedDir = resolveSandboxPath(dirPath, this.workspace);
    const maxEntries = options.maxEntries ?? 200;
    const recursive = Boolean(options.recursive || (options.maxDepth && options.maxDepth > 1));
    const maxDepth = recursive ? (options.maxDepth ?? 3) : 1;

    const entries: FileEntry[] = [];
    const visited = new Set<string>([resolvedDir]);
    const queue: Array<{ dir: string; depth: number }> = [{ dir: resolvedDir, depth: 1 }];

    while (queue.length > 0 && entries.length < maxEntries) {
      const current = queue.shift()!;
      for await (const item of sandbox.files.all(current.dir)) {
        const record = item as Record<string, unknown>;
        const rawPath = String(record.path ?? '');
        const entryPath = rawPath ? resolveSandboxPath(rawPath, current.dir) : current.dir;
        const entryName =
          typeof record.name === 'string' && record.name
            ? record.name
            : path.posix.basename(entryPath);
        const isDir = Boolean(record.isDir ?? record.type === 'directory');
        const rawSize = record.size;
        const size =
          typeof rawSize === 'number'
            ? rawSize
            : typeof rawSize === 'string' && rawSize.trim() !== '' && !Number.isNaN(Number(rawSize))
              ? Number(rawSize)
              : undefined;

        entries.push({ name: entryName, path: entryPath, isDir, size });
        if (entries.length >= maxEntries) {
          break;
        }
        if (isDir && current.depth < maxDepth && !visited.has(entryPath)) {
          visited.add(entryPath);
          queue.push({ dir: entryPath, depth: current.depth + 1 });
        }
      }
    }

    return entries;
  }

  async globFiles(name: string, input: GlobFilesInput): Promise<GlobFilesResult> {
    const sandbox = await this.client.get(name);
    const basePath = resolveSandboxPath(input.path, this.workspace);
    const maxResults = input.maxResults ?? 200;

    const script = [
      'if command -v rg >/dev/null 2>&1; then',
      '  rg --files --hidden --glob "!.git/**" --glob "!.git" -g "$1" .',
      'else',
      '  find . -not -path "*/.git/*" -not -path "*/.git" -not -path "*/node_modules/*" -type f -print',
      'fi',
    ].join('\n');

    const res = await sandbox.processes.run(
      {
        args: ['sh', '-c', script, '_', input.pattern],
        workingDir: basePath,
      },
      { timeoutMs: 30_000 },
    );

    if (res.exitCode > 1) {
      throw new Error(res.stderr.trim() || `glob failed with exit code ${res.exitCode}`);
    }

    const rawLines = res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\.\//, ''))
      .filter(Boolean);

    const filtered = rawLines.filter((rel) => matchesGlob(rel, input.pattern));
    const truncated = filtered.length > maxResults;
    const matches = filtered.slice(0, maxResults).map((rel) => resolveSandboxPath(rel, basePath));

    return { basePath, matches, truncated };
  }

  async searchFiles(name: string, input: SearchFilesInput): Promise<SearchFilesResult> {
    const sandbox = await this.client.get(name);
    const basePath = resolveSandboxPath(input.path, this.workspace);
    const maxResults = input.maxResults ?? 100;
    const caseSensitive = input.caseSensitive ?? true;
    const fixedStrings = input.fixedStrings ?? false;

    const rgFlags = ['-n', '--no-heading', '--color', 'never', '--hidden', '--glob', '!.git/**'];
    if (!caseSensitive) rgFlags.push('-i');
    if (fixedStrings) rgFlags.push('-F');
    if (input.glob) rgFlags.push('-g', input.glob);

    const grepFlags = ['-rnI', '--exclude-dir=.git', '--exclude-dir=node_modules'];
    if (!caseSensitive) grepFlags.push('-i');
    if (fixedStrings) grepFlags.push('-F');
    else grepFlags.push('-E');
    if (input.glob) grepFlags.push(`--include=${input.glob}`);

    const script = [
      'pattern="$1"',
      'if command -v rg >/dev/null 2>&1; then',
      `  rg ${rgFlags.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')} -- "$pattern" .`,
      'else',
      `  grep ${grepFlags.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')} -- "$pattern" .`,
      'fi',
    ].join('\n');

    const res = await sandbox.processes.run(
      {
        args: ['sh', '-c', script, '_', input.pattern],
        workingDir: basePath,
      },
      { timeoutMs: 30_000 },
    );

    if (res.exitCode > 1) {
      throw new Error(res.stderr.trim() || `search_files failed with exit code ${res.exitCode}`);
    }

    const matches: SearchMatch[] = [];
    let truncated = false;
    for (const rawLine of res.stdout.split(/\r?\n/)) {
      if (!rawLine) continue;
      const match = /^(.+?):(\d+):(.*)$/.exec(rawLine);
      if (!match) continue;
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      const relPath = match[1].replace(/^\.\//, '');
      matches.push({
        path: resolveSandboxPath(relPath, basePath),
        line: Number(match[2]),
        text: match[3],
      });
    }

    return { basePath, matches, truncated };
  }

  async applyAndRun(name: string, input: ApplyAndRunInput): Promise<ApplyAndRunResult> {
    const files = input.files ?? [];
    const edits = input.edits ?? [];
    const deletes = input.deletes ?? [];
    const hasCommand =
      input.command !== undefined || (input.args !== undefined && input.args.length > 0);
    const args = hasCommand ? resolveCommandArgs(input) : undefined;

    if (!args && files.length === 0 && edits.length === 0 && deletes.length === 0) {
      throw new Error(
        'Provide at least one file operation (files, edits, deletes) or a command/args to run.',
      );
    }

    const sandbox = await this.client.get(name);
    const resolvedCwd = resolveSandboxPath(input.cwd, this.workspace);

    const writtenFiles = await Promise.all(
      files.map(async (file) => {
        const targetPath = resolveSandboxPath(file.path, resolvedCwd);
        await sandbox.files.write(targetPath, file.content);
        return targetPath;
      }),
    );

    const editedFiles: FileEditResult[] = [];
    for (const edit of edits) {
      const targetPath = resolveSandboxPath(edit.path, resolvedCwd);
      const current = await sandbox.files.read(targetPath, { encoding: 'utf8' });
      const { content, replacements } = applyTextEdit(current, edit);
      await sandbox.files.write(targetPath, content);
      editedFiles.push({ path: targetPath, replacements });
    }

    const deletedFiles = await Promise.all(
      deletes.map(async (delPath) => {
        const targetPath = resolveSandboxPath(delPath, resolvedCwd);
        await sandbox.files.remove(targetPath, { recursive: false });
        return targetPath;
      }),
    );

    let commandResult: CommandResult | undefined;
    if (args) {
      const result = await sandbox.processes.run(
        {
          args,
          workingDir: resolvedCwd,
          ...(input.env ? { env: input.env } : {}),
        },
        { timeoutMs: input.timeoutMs ?? 120_000 },
      );
      commandResult = {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        incomplete: result.incomplete,
        processName: result.process?.name,
      };
    }

    return { writtenFiles, editedFiles, deletedFiles, ...(commandResult ? { commandResult } : {}) };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
