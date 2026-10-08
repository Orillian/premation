/**
 * The whole MCP path short of the editor page, for real:
 *
 *   MCP client (this test) ─stdio─▶ the BUNDLED server (build/mcp/premation-mcp.cjs)
 *     ─pipe─▶ McpBridge ─▶ a stand-in page that answers like useMcpHost
 *
 * Covers the handshake and token, Claude being off, no project open, results
 * (text and images) coming back intact, and what the bridge refuses to pass on.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpBridge, endpointFor, sanitizeResult, type PageTarget } from './bridge';

jest.setTimeout(30_000);

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'build', 'mcp', 'premation-mcp.cjs');

beforeAll(() => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'buildMcp.cjs')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`buildMcp failed: ${r.stderr}`);
});

/** A page that answers every call like the editor would. */
class FakePage implements PageTarget {
  calls: Array<{ id: number; name: string; args: unknown }> = [];
  clients: number[][] = [];
  answer: (name: string, args: unknown) => unknown = (name) => ({ content: [{ type: 'text', text: `ran ${name}` }] });
  bridge!: McpBridge;
  send(channel: string, payload: unknown): void {
    if (channel === 'mcp:call') {
      const c = payload as { id: number; name: string; args: unknown };
      this.calls.push(c);
      setTimeout(() => this.bridge.resolveCall(c.id, this.answer(c.name, c.args)), 0);
    } else if (channel === 'mcp:clients') {
      this.clients.push(payload as number[]);
    }
  }
  isDestroyed(): boolean { return false; }
}

/** A minimal MCP client over the server's stdio. */
class McpClient {
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (m: Record<string, unknown>) => void>();
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, nl)) as Record<string, unknown>;
        this.buffer = this.buffer.slice(nl + 1);
        if (typeof msg.id === 'number') this.waiting.get(msg.id)?.(msg);
      }
    });
    child.stderr.resume();
  }
  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
  async init(name = 'Claude Desktop'): Promise<void> {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.2.3' } });
    this.notify('notifications/initialized');
  }
  async call(name: string, args: unknown = {}): Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }> {
    const r = await this.request('tools/call', { name, arguments: args });
    return r.result as { content: Array<Record<string, unknown>>; isError?: boolean };
  }
}

let dir: string;
let page: FakePage;
let bridge: McpBridge;
let children: ChildProcessWithoutNullStreams[] = [];

function startServer(mcpDir: string): McpClient {
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, PREMATION_MCP_DIR: mcpDir } });
  children.push(child);
  return new McpClient(child);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'premation-mcp-'));
  page = new FakePage();
  bridge = new McpBridge({ userDataDir: dir, platform: process.platform, appVersion: '9.9.9', getPage: () => page });
  page.bridge = bridge;
});

afterEach(async () => {
  for (const c of children) c.kill();
  children = [];
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (r: { content: Array<Record<string, unknown>> }): string => r.content.map((c) => String(c.text ?? '')).join(' ');

describe('MCP → bundled server → pipe → bridge → page', () => {
  it('runs a call in the page and returns its result, and reports the connected client', async () => {
    await bridge.enable();
    bridge.setPageReady(true);
    const client = startServer(bridge.paths.dir);
    await client.init();
    const r = await client.call('describe_scene', { depth: 1 });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe('ran describe_scene');
    expect(page.calls).toEqual([expect.objectContaining({ name: 'describe_scene', args: { depth: 1 } })]);
    expect(bridge.status().clients).toEqual([expect.objectContaining({ name: 'Claude Desktop', version: '1.2.3' })]);
  });

  it('passes an image result through intact', async () => {
    await bridge.enable();
    bridge.setPageReady(true);
    page.answer = () => ({ content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: 'Frame at 1s.' }] });
    const client = startServer(bridge.paths.dir);
    await client.init();
    const r = await client.call('render_frame', { time: 1 });
    expect(r.content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  });

  it('says "open a project" when no editor page can take calls', async () => {
    await bridge.enable();
    const client = startServer(bridge.paths.dir);
    await client.init();
    const r = await client.call('describe_scene');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no project open/);
    expect(page.calls).toEqual([]);
  });

  it('refuses a client with the wrong token, without reaching the page', async () => {
    await bridge.enable();
    bridge.setPageReady(true);
    // A copy of the endpoint with a forged token.
    const forged = mkdtempSync(path.join(os.tmpdir(), 'premation-mcp-forged-'));
    writeFileSync(path.join(forged, 'endpoint.json'), JSON.stringify({ v: 1, endpoint: bridge.endpoint }));
    writeFileSync(path.join(forged, 'token'), 'f'.repeat(64));
    const client = startServer(forged);
    await client.init();
    const r = await client.call('describe_scene');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/did not recognise/);
    expect(page.calls).toEqual([]);
    rmSync(forged, { recursive: true, force: true });
  });

  it('tells Claude to connect in Premation once it has been turned off', async () => {
    await bridge.enable();
    await bridge.disable();
    const client = startServer(bridge.paths.dir);
    await client.init();
    const r = await client.call('describe_scene');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Settings → AI → Claude/);
  });

  it('says Premation is not open when nothing listens', async () => {
    await bridge.enable();
    await bridge.stop();
    const client = startServer(bridge.paths.dir);
    await client.init();
    const r = await client.call('describe_scene');
    expect(textOf(r)).toMatch(/Premation is not open/);
  });

  it('offers the tool list even when Premation is closed, without the excluded tools', async () => {
    const client = startServer(path.join(dir, 'never-set-up'));
    await client.init();
    const list = await client.request('tools/list', {});
    const names = ((list.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['describe_scene', 'create_layer', 'render_frame', 'begin_edit', 'author_scene']));
    expect(names).not.toContain('export_video');
    expect(names).not.toContain('generate_video');
  });
});

describe('the bridge', () => {
  it('derives a per-user-data endpoint, never a TCP port', () => {
    expect(endpointFor('C:\\Users\\u\\AppData\\Roaming\\Premation', 'win32')).toMatch(/^\\\\\.\\pipe\\premation-mcp-[0-9a-f]{16}$/);
    expect(endpointFor('/Users/u/Library/Application Support/Premation', 'darwin')).toBe('/Users/u/Library/Application Support/Premation/mcp/premation.sock');
    expect(endpointFor(`/home/${'x'.repeat(120)}`, 'linux', '/tmp')).toMatch(/^\/tmp\/premation-mcp-[0-9a-f]{16}\.sock$/);
  });

  it('keeps only well-formed text and image parts of a page result', () => {
    expect(sanitizeResult({ content: [{ type: 'text', text: 'ok' }, { type: 'script', src: 'x' }, { type: 'image', data: 'AA', mimeType: 'image/svg+xml' }] }))
      .toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(sanitizeResult(null).isError).toBe(true);
    expect(sanitizeResult({ content: [], isError: true })).toEqual({ content: [{ type: 'text', text: '(no output)' }], isError: true });
  });
});
