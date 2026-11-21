import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHttpApp } from '../src/index.js';
import { createSandboxMcpServer } from '../src/mcp-server.js';
import {
  createDockerAuthenticator,
  type ApplyAndRunInput,
  type ApplyAndRunResult,
  type CommandResult,
  type CreateSandboxInput,
  type FileEntry,
  type FileWriteInput,
  type ProcessOutputResult,
  type ProcessSummary,
  type RunCommandInput,
  type SandboxService,
  type SandboxSummary,
} from '../src/sandbox-service.js';

class MockSandboxService implements SandboxService {
  private counter = 0;
  private sandboxes = new Map<string, SandboxSummary>();
  private files = new Map<string, Map<string, string>>();
  private processes = new Map<string, Map<string, ProcessOutputResult>>();

  async createSandbox(input: CreateSandboxInput): Promise<SandboxSummary> {
    this.counter += 1;
    const uid = `sbx-${this.counter}`;
    const name = `sandboxes/${uid}`;
    const summary: SandboxSummary = {
      name,
      uid,
      displayName: input.displayName ?? input.kit ?? 'shell',
      status: 'RUNNING',
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
    return {
      exitCode: 0,
      stdout: `ran: ${input.args.join(' ')}`,
      stderr: '',
      incomplete: false,
      processName: `${name}/processes/proc-1`,
    };
  }

  async startProcess(name: string, _input: RunCommandInput): Promise<ProcessSummary> {
    await this.getSandbox(name);
    const procName = `${name}/processes/bg-1`;
    const summary: ProcessSummary = {
      name: procName,
      status: 'RUNNING',
      pid: 4242,
    };
    this.processes.get(name)!.set(procName, {
      process: summary,
      output: 'server listening on :3000\n',
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

  async readFile(name: string, path: string): Promise<string> {
    await this.getSandbox(name);
    const content = this.files.get(name)?.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async listFiles(name: string, path: string): Promise<FileEntry[]> {
    await this.getSandbox(name);
    const store = this.files.get(name)!;
    return Array.from(store.entries())
      .filter(([p]) => p.startsWith(path))
      .map(([p, content]) => ({
        name: p.split('/').pop() ?? p,
        path: p,
        isDir: false,
        size: content.length,
      }));
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

  async close(): Promise<void> {}
}

describe('docker-sandbox-mcp tools', () => {
  it('exposes all tools with proper readOnlyHint annotations and executes full lifecycle', async () => {
    const service = new MockSandboxService();
    const server = createSandboxMcpServer(service);
    const client = new Client({ name: 'test-client', version: '0.1.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const toolMap = new Map(listed.tools.map((t) => [t.name, t]));
    assert.equal(toolMap.get('list_sandboxes')?.annotations?.readOnlyHint, true);
    assert.equal(toolMap.get('get_sandbox')?.annotations?.readOnlyHint, true);
    assert.equal(toolMap.get('read_file')?.annotations?.readOnlyHint, true);
    assert.equal(toolMap.get('list_files')?.annotations?.readOnlyHint, true);
    assert.equal(toolMap.get('get_process_output')?.annotations?.readOnlyHint, true);
    assert.equal(toolMap.get('apply_and_run')?.annotations?.readOnlyHint, false);
    assert.equal(toolMap.get('delete_sandbox')?.annotations?.destructiveHint, true);

    const createdRes = await client.callTool({
      name: 'create_sandbox',
      arguments: { kit: 'shell', displayName: 'ci-test' },
    });
    const created = JSON.parse((createdRes.content as Array<{ text: string }>)[0].text);
    assert.equal(created.name, 'sandboxes/sbx-1');
    assert.equal(created.status, 'RUNNING');

    const applyRes = await client.callTool({
      name: 'apply_and_run',
      arguments: {
        sandboxName: created.name,
        files: [{ path: '/workspace/hello.txt', content: 'hello world' }],
        args: ['sh', '-c', 'cat /workspace/hello.txt'],
      },
    });
    const applied = JSON.parse((applyRes.content as Array<{ text: string }>)[0].text);
    assert.deepEqual(applied.writtenFiles, ['/workspace/hello.txt']);
    assert.equal(applied.exitCode, 0);
    assert.match(applied.stdout, /ran: sh -c cat \/workspace\/hello.txt/);

    const readRes = await client.callTool({
      name: 'read_file',
      arguments: { sandboxName: created.name, path: '/workspace/hello.txt' },
    });
    assert.equal((readRes.content as Array<{ text: string }>)[0].text, 'hello world');

    const bgRes = await client.callTool({
      name: 'start_background_process',
      arguments: { sandboxName: created.name, args: ['node', 'server.js'] },
    });
    const bg = JSON.parse((bgRes.content as Array<{ text: string }>)[0].text);
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

    await Promise.all([client.close(), server.close()]);
  });

  it('throws clear error when Docker credentials are missing', () => {
    assert.throws(() => createDockerAuthenticator({}), /Docker Sandboxes credentials missing/);
  });
});

describe('HTTP Streamable transport & auth', () => {
  it('serves /healthz, /.well-known/oauth-protected-resource, and enforces Bearer auth on /mcp', async () => {
    const service = new MockSandboxService();
    const app = createHttpApp({
      service,
      auth: {
        bearerToken: 'test-secret-token',
        publicUrl: 'https://mcp.example.com',
        oauthIssuer: 'https://accounts.google.com',
      },
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const health = await fetch(`${baseUrl}/healthz`);
      assert.equal(health.status, 200);

      const meta = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
      assert.equal(meta.status, 200);
      const metaJson = (await meta.json()) as Record<string, unknown>;
      assert.equal(metaJson.resource, 'https://mcp.example.com/mcp');

      const unauth = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(unauth.status, 401);
      assert.match(unauth.headers.get('www-authenticate') ?? '', /Bearer/);

      const authed = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer test-secret-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      const authedBody = await authed.text();
      assert.equal(authed.status, 200, authedBody);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
