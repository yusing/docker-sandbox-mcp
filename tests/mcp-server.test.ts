import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSandboxMcpServer, formatFileLines } from '../src/mcp-server.js';
import {
  DEFAULT_WORKSPACE,
  applyTextEdit,
  createDockerAuthenticator,
  matchesGlob,
  resolveCommandArgs,
  resolveSandboxPath,
  type ApplyAndRunInput,
  type ApplyAndRunResult,
  type CommandResult,
  type CreateSandboxInput,
  type FileEditInput,
  type FileEditResult,
  type FileEntry,
  type FileStatResult,
  type FileWriteInput,
  type GlobFilesInput,
  type GlobFilesResult,
  type ListFilesOptions,
  type ProcessOutputResult,
  type ProcessSummary,
  type RunCommandInput,
  type SandboxService,
  type SandboxSummary,
  type SearchFilesInput,
  type SearchFilesResult,
} from '../src/sandbox-service.js';

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  assert(addr && typeof addr !== 'string');
  const { port } = addr;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

class MockSandboxService implements SandboxService {
  readonly workspace = DEFAULT_WORKSPACE;
  private counter = 0;
  private sandboxes = new Map<string, SandboxSummary>();
  private files = new Map<string, Map<string, string>>();
  private processes = new Map<string, Map<string, ProcessOutputResult>>();
  lastRunCwd?: string;
  lastStartProcessCwd?: string;

  async createSandbox(input: CreateSandboxInput): Promise<SandboxSummary> {
    this.counter += 1;
    const uid = `sbx-${this.counter}`;
    const name = `sandboxes/${uid}`;
    const summary: SandboxSummary = {
      name,
      uid,
      displayName: input.displayName ?? input.kit ?? 'shell',
      status: 'RUNNING',
      workspace: this.workspace,
      environment: {
        user: 'agent',
        home: '/home/agent',
        platform: 'Linux x86_64',
        shell: '/bin/bash',
      },
    };
    this.sandboxes.set(name, summary);
    this.files.set(name, new Map());
    this.processes.set(name, new Map());
    return summary;
  }

  async listSandboxes(): Promise<SandboxSummary[]> {
    return Array.from(this.sandboxes.values());
  }

  async getSandbox(name: string): Promise<SandboxSummary> {
    const sbx = this.sandboxes.get(name);
    if (!sbx) throw new Error(`Sandbox not found: ${name}`);
    return sbx;
  }

  async stopSandbox(name: string): Promise<SandboxSummary> {
    const sbx = await this.getSandbox(name);
    sbx.status = 'STOPPED';
    return sbx;
  }

  async startSandbox(name: string): Promise<SandboxSummary> {
    const sbx = await this.getSandbox(name);
    sbx.status = 'RUNNING';
    return sbx;
  }

  async deleteSandbox(name: string): Promise<{ deleted: string }> {
    await this.getSandbox(name);
    this.sandboxes.delete(name);
    this.files.delete(name);
    this.processes.delete(name);
    return { deleted: name };
  }

  async runCommand(name: string, input: RunCommandInput): Promise<CommandResult> {
    await this.getSandbox(name);
    const args = resolveCommandArgs(input);
    this.lastRunCwd = input.cwd;
    return {
      exitCode: 0,
      stdout: `ran: ${args.join(' ')}`,
      stderr: '',
      incomplete: false,
      processName: `${name}/processes/proc-1`,
    };
  }

  async startProcess(name: string, input: RunCommandInput): Promise<ProcessSummary> {
    await this.getSandbox(name);
    const args = resolveCommandArgs(input);
    this.lastStartProcessCwd = input.cwd;
    const procName = `${name}/processes/bg-1`;
    const summary: ProcessSummary = {
      name: procName,
      status: 'RUNNING',
      pid: 4242,
    };
    this.processes.get(name)!.set(procName, {
      process: summary,
      output: `server listening on :3000 (${args.join(' ')})\n`,
    });
    return summary;
  }

  async getProcessOutput(name: string, processName: string): Promise<ProcessOutputResult> {
    await this.getSandbox(name);
    const proc = this.processes.get(name)?.get(processName);
    if (!proc) throw new Error(`Process not found: ${processName}`);
    return proc;
  }

  async writeFiles(name: string, files: FileWriteInput[]): Promise<{ writtenFiles: string[] }> {
    await this.getSandbox(name);
    const store = this.files.get(name)!;
    const writtenFiles: string[] = [];
    for (const f of files) {
      store.set(f.path, f.content);
      writtenFiles.push(f.path);
    }
    return { writtenFiles };
  }

  async editFile(name: string, input: FileEditInput): Promise<FileEditResult> {
    await this.getSandbox(name);
    const store = this.files.get(name)!;
    const current = store.get(input.path);
    if (current === undefined) throw new Error(`File not found: ${input.path}`);
    const { content, replacements } = applyTextEdit(current, input);
    store.set(input.path, content);
    return { path: input.path, replacements };
  }

  async readFile(name: string, path: string): Promise<string> {
    await this.getSandbox(name);
    const content = this.files.get(name)?.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async statFile(name: string, filePath: string): Promise<FileStatResult> {
    await this.getSandbox(name);
    const content = this.files.get(name)?.get(filePath);
    if (content === undefined) throw new Error(`File not found: ${filePath}`);
    return { path: filePath, isDir: false, type: 'regular', size: content.length };
  }

  async mkdir(name: string, dirPath: string): Promise<{ path: string }> {
    await this.getSandbox(name);
    return { path: dirPath };
  }

  async moveFile(name: string, from: string, to: string): Promise<{ from: string; to: string }> {
    await this.getSandbox(name);
    const store = this.files.get(name)!;
    const content = store.get(from);
    if (content === undefined) throw new Error(`File not found: ${from}`);
    store.delete(from);
    store.set(to, content);
    return { from, to };
  }

  async removeFile(
    name: string,
    targetPath: string,
    recursive = false,
  ): Promise<{ removed: string; recursive: boolean }> {
    await this.getSandbox(name);
    const store = this.files.get(name)!;
    store.delete(targetPath);
    return { removed: targetPath, recursive };
  }

  async listFiles(
    name: string,
    dirPath: string,
    options: ListFilesOptions = {},
  ): Promise<FileEntry[]> {
    await this.getSandbox(name);
    const store = this.files.get(name)!;
    const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
    const maxDepth = options.recursive ? (options.maxDepth ?? 3) : 1;
    const maxEntries = options.maxEntries ?? 200;
    const entries: FileEntry[] = [];
    for (const [p, content] of store.entries()) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      const depth = rel.split('/').length;
      if (depth > maxDepth) continue;
      entries.push({
        name: p.split('/').pop() ?? p,
        path: p,
        isDir: false,
        size: content.length,
      });
      if (entries.length >= maxEntries) break;
    }
    return entries;
  }

  async globFiles(name: string, input: GlobFilesInput): Promise<GlobFilesResult> {
    await this.getSandbox(name);
    const basePath = resolveSandboxPath(input.path, this.workspace);
    const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
    const maxResults = input.maxResults ?? 200;
    const store = this.files.get(name)!;
    const allMatches: string[] = [];
    for (const filePath of store.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rel = filePath.slice(prefix.length);
      if (matchesGlob(rel, input.pattern)) {
        allMatches.push(filePath);
      }
    }
    return {
      basePath,
      matches: allMatches.slice(0, maxResults),
      truncated: allMatches.length > maxResults,
    };
  }

  async searchFiles(name: string, input: SearchFilesInput): Promise<SearchFilesResult> {
    await this.getSandbox(name);
    const basePath = resolveSandboxPath(input.path, this.workspace);
    const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
    const maxResults = input.maxResults ?? 100;
    const store = this.files.get(name)!;
    const flags = input.caseSensitive === false ? 'i' : '';
    const regex = input.fixedStrings
      ? new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
      : new RegExp(input.pattern, flags);

    const matches: SearchFilesResult['matches'] = [];
    let truncated = false;
    for (const [filePath, content] of store.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rel = filePath.slice(prefix.length);
      if (input.glob && !matchesGlob(rel, input.glob)) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
          matches.push({ path: filePath, line: i + 1, text: lines[i] });
        }
      }
      if (truncated) break;
    }
    return { basePath, matches, truncated };
  }

  async applyAndRun(name: string, input: ApplyAndRunInput): Promise<ApplyAndRunResult> {
    const files = input.files ?? [];
    const edits = input.edits ?? [];
    const deletes = input.deletes ?? [];
    const { writtenFiles } =
      files.length > 0 ? await this.writeFiles(name, files) : { writtenFiles: [] };
    const editedFiles: FileEditResult[] = [];
    for (const edit of edits) {
      editedFiles.push(await this.editFile(name, edit));
    }
    const deletedFiles: string[] = [];
    for (const delPath of deletes) {
      const { removed } = await this.removeFile(name, delPath, false);
      deletedFiles.push(removed);
    }
    const hasCommand =
      input.command !== undefined || (input.args !== undefined && input.args.length > 0);
    const commandResult = hasCommand
      ? await this.runCommand(name, {
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env,
          timeoutMs: input.timeoutMs,
        })
      : undefined;
    return {
      writtenFiles,
      editedFiles,
      deletedFiles,
      ...(commandResult ? { commandResult } : {}),
    };
  }

  async close(): Promise<void> {}
}

describe('docker-sandbox-mcp tools & HTTP transport', () => {
  it('exposes all tools with proper annotations, enforces static Bearer auth, and executes full lifecycle', async () => {
    const service = new MockSandboxService();
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const handle = createSandboxMcpServer({
      service,
      auth: { bearerToken: 'test-secret-token' },
    });

    await handle.server.start({
      transportType: 'httpStream',
      httpStream: {
        host: '127.0.0.1',
        port,
        endpoint: '/mcp',
        sseEndpoint: null,
        stateless: true,
      },
    });

    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: {
          authorization: 'Bearer test-secret-token',
        },
      },
    });

    try {
      const health = await fetch(`${baseUrl}/healthz`);
      assert.equal(health.status, 200);

      const unauth = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(unauth.status, 401);
      assert.match(unauth.headers.get('www-authenticate') ?? '', /Bearer/);

      await client.connect(transport);

      const listed = await client.listTools();
      const toolMap = new Map(listed.tools.map((t) => [t.name, t]));
      assert.equal(toolMap.get('list_sandboxes')?.annotations?.readOnlyHint, true);
      assert.equal(toolMap.get('get_sandbox')?.annotations?.readOnlyHint, true);
      assert.equal(toolMap.get('read_file')?.annotations?.readOnlyHint, true);
      assert.equal(toolMap.get('list_files')?.annotations?.readOnlyHint, true);
      assert.equal(toolMap.get('glob_files')?.annotations?.readOnlyHint, true);
      assert.equal(toolMap.get('search_files')?.annotations?.readOnlyHint, true);
      assert.equal(toolMap.get('stat_file')?.annotations?.readOnlyHint, true);
      assert.equal(toolMap.get('get_process_output')?.annotations?.readOnlyHint, true);
      assert.equal(toolMap.get('apply_and_run')?.annotations?.readOnlyHint, false);
      assert.equal(toolMap.get('edit_file')?.annotations?.readOnlyHint, false);
      assert.equal(toolMap.get('remove_file')?.annotations?.destructiveHint, true);
      assert.equal(toolMap.get('delete_sandbox')?.annotations?.destructiveHint, true);

      const createdRes = await client.callTool({
        name: 'create_sandbox',
        arguments: { kit: 'shell', displayName: 'ci-test' },
      });
      const created = JSON.parse((createdRes.content as Array<{ text: string }>)[0].text);
      assert.equal(created.name, 'sandboxes/sbx-1');
      assert.equal(created.status, 'RUNNING');
      assert.equal(created.workspace, '/workspace');
      assert.equal(created.environment.user, 'agent');

      const applyRes = await client.callTool({
        name: 'apply_and_run',
        arguments: {
          sandboxName: created.name,
          cwd: 'app',
          files: [{ path: 'hello.txt', content: 'line1\nhello world\nline3\n' }],
          args: ['sh', '-c', 'cat hello.txt'],
        },
      });
      const applied = JSON.parse((applyRes.content as Array<{ text: string }>)[0].text);
      assert.equal(applied.cwd, '/workspace/app');
      assert.deepEqual(applied.writtenFiles, ['/workspace/app/hello.txt']);
      assert.equal(service.lastRunCwd, '/workspace/app');
      assert.equal(applied.exitCode, 0);
      assert.match(applied.stdout, /ran: sh -c cat hello.txt/);

      const readRes = await client.callTool({
        name: 'read_file',
        arguments: {
          sandboxName: created.name,
          path: 'app/hello.txt',
          startLine: 2,
          endLine: 2,
        },
      });
      assert.equal(
        (readRes.content as Array<{ text: string }>)[0].text,
        '2\thello world\n\n[Showing lines 2-2 of 3]',
      );

      const listedFilesRes = await client.callTool({
        name: 'list_files',
        arguments: { sandboxName: created.name, recursive: true, maxDepth: 3 },
      });
      const listedFiles = JSON.parse((listedFilesRes.content as Array<{ text: string }>)[0].text);
      assert.equal(listedFiles.path, '/workspace');
      assert.equal(listedFiles.entries.length, 1);
      assert.equal(listedFiles.entries[0].path, '/workspace/app/hello.txt');

      const globRes = await client.callTool({
        name: 'glob_files',
        arguments: { sandboxName: created.name, pattern: '**/*.txt' },
      });
      const globbed = JSON.parse((globRes.content as Array<{ text: string }>)[0].text);
      assert.deepEqual(globbed.matches, ['/workspace/app/hello.txt']);

      const searchRes = await client.callTool({
        name: 'search_files',
        arguments: {
          sandboxName: created.name,
          pattern: 'HELLO',
          caseSensitive: false,
          glob: '*.txt',
        },
      });
      const searched = JSON.parse((searchRes.content as Array<{ text: string }>)[0].text);
      assert.deepEqual(searched.matches, [
        { path: '/workspace/app/hello.txt', line: 2, text: 'hello world' },
      ]);

      // Targeted edit_file, file-only apply_and_run, stat/mkdir/move/remove
      const editRes = await client.callTool({
        name: 'edit_file',
        arguments: {
          sandboxName: created.name,
          path: 'app/hello.txt',
          oldText: 'hello world',
          newText: 'hello sandbox',
        },
      });
      assert.deepEqual(JSON.parse((editRes.content as Array<{ text: string }>)[0].text), {
        path: '/workspace/app/hello.txt',
        replacements: 1,
      });

      const writeOnlyRes = await client.callTool({
        name: 'apply_and_run',
        arguments: {
          sandboxName: created.name,
          cwd: 'app',
          files: [{ path: 'temp.txt', content: 'tmp' }],
          edits: [{ path: 'hello.txt', oldText: 'line3', newText: 'line3-updated' }],
        },
      });
      const writeOnly = JSON.parse((writeOnlyRes.content as Array<{ text: string }>)[0].text);
      assert.deepEqual(writeOnly.writtenFiles, ['/workspace/app/temp.txt']);
      assert.deepEqual(writeOnly.editedFiles, [{ path: '/workspace/app/hello.txt', replacements: 1 }]);
      assert.equal(writeOnly.exitCode, undefined);

      const statRes = await client.callTool({
        name: 'stat_file',
        arguments: { sandboxName: created.name, path: 'app/temp.txt' },
      });
      assert.equal(JSON.parse((statRes.content as Array<{ text: string }>)[0].text).size, 3);

      const mkdirRes = await client.callTool({
        name: 'mkdir',
        arguments: { sandboxName: created.name, path: 'app/sub' },
      });
      assert.equal(
        JSON.parse((mkdirRes.content as Array<{ text: string }>)[0].text).path,
        '/workspace/app/sub',
      );

      await client.callTool({
        name: 'move_file',
        arguments: { sandboxName: created.name, from: 'app/temp.txt', to: 'app/moved.txt' },
      });
      const movedRead = await client.callTool({
        name: 'read_file',
        arguments: { sandboxName: created.name, path: 'app/moved.txt', lineNumbers: false },
      });
      assert.equal((movedRead.content as Array<{ text: string }>)[0].text, 'tmp');

      const rmRes = await client.callTool({
        name: 'remove_file',
        arguments: { sandboxName: created.name, path: 'app/moved.txt' },
      });
      assert.deepEqual(JSON.parse((rmRes.content as Array<{ text: string }>)[0].text), {
        removed: '/workspace/app/moved.txt',
        recursive: false,
      });

      const runCmdRes = await client.callTool({
        name: 'run_command',
        arguments: {
          sandboxName: created.name,
          command: 'ls -la && echo done',
        },
      });
      const runCmd = JSON.parse((runCmdRes.content as Array<{ text: string }>)[0].text);
      assert.equal(runCmd.stdout, 'ran: bash -lc ls -la && echo done');

      const badCmdRes = await client.callTool({
        name: 'run_command',
        arguments: {
          sandboxName: created.name,
          command: 'echo hi',
          args: ['echo', 'hi'],
        },
      });
      assert.equal(badCmdRes.isError, true);

      const bgRes = await client.callTool({
        name: 'start_background_process',
        arguments: { sandboxName: created.name, command: 'npm run dev' },
      });
      const bg = JSON.parse((bgRes.content as Array<{ text: string }>)[0].text);
      assert.equal(service.lastStartProcessCwd, '/workspace');
      const outRes = await client.callTool({
        name: 'get_process_output',
        arguments: { sandboxName: created.name, processName: bg.name },
      });
      const out = JSON.parse((outRes.content as Array<{ text: string }>)[0].text);
      assert.match(out.output, /server listening/);

      await client.callTool({ name: 'stop_sandbox', arguments: { sandboxName: created.name } });
      const stopped = JSON.parse(
        ((await client.callTool({ name: 'get_sandbox', arguments: { sandboxName: created.name } }))
          .content as Array<{ text: string }>)[0].text,
      );
      assert.equal(stopped.status, 'STOPPED');

      await client.callTool({ name: 'delete_sandbox', arguments: { sandboxName: created.name } });
      const afterDelete = JSON.parse(
        ((await client.callTool({ name: 'list_sandboxes', arguments: {} }))
          .content as Array<{ text: string }>)[0].text,
      );
      assert.equal(afterDelete.sandboxes.length, 0);
    } finally {
      await client.close();
      await handle.server.stop();
      handle.destroy();
    }
  });

  it('resolves sandbox paths relative to workspace and preserves absolute paths', () => {
    assert.equal(resolveSandboxPath(undefined), '/workspace');
    assert.equal(resolveSandboxPath('.'), '/workspace');
    assert.equal(resolveSandboxPath('src/index.ts'), '/workspace/src/index.ts');
    assert.equal(resolveSandboxPath('../other', '/workspace/app'), '/workspace/other');
    assert.equal(resolveSandboxPath('/etc/hosts', '/workspace/app'), '/etc/hosts');
  });

  it('resolves command strings to bash -lc and rejects ambiguous or empty command inputs', () => {
    assert.deepEqual(resolveCommandArgs({ command: 'npm test | tail -n 20' }), [
      'bash',
      '-lc',
      'npm test | tail -n 20',
    ]);
    assert.deepEqual(resolveCommandArgs({ args: ['pytest', '-q'] }), ['pytest', '-q']);
    assert.throws(() => resolveCommandArgs({}), /Provide either "command"/);
    assert.throws(
      () => resolveCommandArgs({ command: 'ls', args: ['ls'] }),
      /not both/,
    );
    assert.throws(() => resolveCommandArgs({ command: '   ' }), /must not be empty/);
  });

  it('formats line-ranged file content and matches glob patterns accurately', () => {
    const sample = 'alpha\nbeta\ngamma\ndelta\n';
    assert.equal(formatFileLines(sample), '1\talpha\n2\tbeta\n3\tgamma\n4\tdelta');
    assert.equal(
      formatFileLines(sample, { startLine: 2, endLine: 3, lineNumbers: false }),
      'beta\ngamma\n\n[Showing lines 2-3 of 4]',
    );
    assert.throws(() => formatFileLines(sample, { startLine: 4, endLine: 2 }), /endLine/);

    assert.equal(matchesGlob('src/mcp-server.ts', '**/*.ts'), true);
    assert.equal(matchesGlob('src/mcp-server.ts', '*.ts'), true);
    assert.equal(matchesGlob('src/mcp-server.ts', '**/*.{js,json}'), false);
  });

  it('applies targeted text edits and enforces uniqueness unless replaceAll is set', () => {
    assert.deepEqual(
      applyTextEdit('foo bar foo', { oldText: 'bar', newText: '$&baz' }),
      { content: 'foo $&baz foo', replacements: 1 },
    );
    assert.throws(
      () => applyTextEdit('foo bar foo', { oldText: 'foo', newText: 'qux' }),
      /matched 2 times/,
    );
    assert.deepEqual(
      applyTextEdit('foo bar foo', { oldText: 'foo', newText: 'qux', replaceAll: true }),
      { content: 'qux bar qux', replacements: 2 },
    );
    assert.throws(
      () => applyTextEdit('hello', { oldText: 'missing', newText: 'x' }),
      /not found/,
    );
  });

  it('throws clear error when Docker credentials are missing', () => {
    assert.throws(() => createDockerAuthenticator({}), /Docker Sandboxes credentials missing/);
  });
});
