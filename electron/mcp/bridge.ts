/**
 * The door an MCP client comes in through: a local pipe in Electron main
 * (docs/MCP_PLAN.md D1, §3.2).
 *
 * ```
 * Claude ──stdio──▶ premation-mcp (bundled script) ──pipe──▶ McpBridge (here)
 *        ──IPC──▶ the editor page's tool runtime ──▶ engine API ──▶ premation-engine
 * ```
 *
 * The engine has exactly one client (main, over stdio) and keeps it that way;
 * the tools that know how to edit a document live in the page. So this file
 * does three things and no editing:
 *
 *   1. **Listens** on a per-user named pipe (Windows) / unix socket (macOS,
 *      Linux) — never a TCP port — only while the user has turned Claude on.
 *   2. **Admits** a client that presents the token in `<userData>/mcp/token`
 *      (0600). The pipe is reachable by other local processes of the same
 *      user; the token is what separates "the server Premation configured"
 *      from "anything that found the pipe name".
 *   3. **Relays** each call to the editor page and its answer back. Calls are
 *      queued in the page, not here, so two clients (Claude Desktop and Claude
 *      Code at once) cannot interleave edits.
 *
 * Wire format on the pipe: one JSON object per line (see `PipeMessage`). The
 * bundled server (packages/mcp-server) speaks the other end.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Pipe protocol version; the server sends it in `hello`. */
export const PIPE_PROTOCOL_VERSION = 1;

/** MCP `CallToolResult`, as the page builds it. */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/** Client → main. */
export type ClientMessage =
  | { t: 'hello'; v: number; token: string; client?: { name?: string; version?: string } }
  | { t: 'call'; id: number; name: string; args: unknown };

/** Main → client. */
export type ServerMessage =
  | { t: 'welcome'; app: { version: string } }
  | { t: 'denied'; message: string }
  | { t: 'result'; id: number; result: McpToolResult };

/** The largest line either side accepts (a 2048px PNG in base64 is a few MB). */
export const MAX_LINE_BYTES = 48 * 1024 * 1024;
/** How long a client has to say hello. */
const HELLO_TIMEOUT_MS = 5_000;
/** How long the page may take on one call (author_scene builds a whole piece). */
const CALL_TIMEOUT_MS = 10 * 60_000;

export interface McpClientInfo {
  id: number;
  name: string;
  version: string;
  since: number;
  lastCallAt: number | null;
}

export interface McpBridgeStatus {
  enabled: boolean;
  listening: boolean;
  /** Why listening failed, if it did. */
  error: string | null;
  /** An editor window with a project is ready to take calls. */
  pageReady: boolean;
  clients: McpClientInfo[];
}

/** The page side of the relay (a webContents, narrowed for tests). */
export interface PageTarget {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

export interface McpPaths {
  dir: string;
  tokenFile: string;
  endpointFile: string;
  stateFile: string;
}

export function mcpPaths(userDataDir: string): McpPaths {
  const dir = path.join(userDataDir, 'mcp');
  return {
    dir,
    tokenFile: path.join(dir, 'token'),
    endpointFile: path.join(dir, 'endpoint.json'),
    stateFile: path.join(dir, 'state.json'),
  };
}

/**
 * The pipe/socket address for this user-data folder. Hashed from the folder so
 * a development build and the installed app never answer each other's calls.
 */
export function endpointFor(userDataDir: string, platform: NodeJS.Platform, tmpDir: string = os.tmpdir()): string {
  const hash = createHash('sha256').update(userDataDir).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\premation-mcp-${hash}`;
  const inData = path.posix.join(userDataDir, 'mcp', 'premation.sock');
  // sun_path is 104 bytes on macOS; a long home folder would not fit.
  return Buffer.byteLength(inData) < 100 ? inData : path.posix.join(tmpDir, `premation-mcp-${hash}.sock`);
}

function textResult(text: string, isError = true): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Conn {
  socket: net.Socket;
  info: McpClientInfo | null;
}

export interface McpBridgeDeps {
  userDataDir: string;
  platform: NodeJS.Platform;
  appVersion: string;
  /** The editor window's page, or null when there is none. */
  getPage(): PageTarget | null;
  /** Status changed: push it to the settings page. */
  onStatus?(status: McpBridgeStatus): void;
  log?(line: string): void;
}

export class McpBridge {
  readonly paths: McpPaths;
  readonly endpoint: string;
  private server: net.Server | null = null;
  private enabled = false;
  private error: string | null = null;
  private pageReady = false;
  private readonly conns = new Set<Conn>();
  private nextClientId = 1;
  private nextRelayId = 1;
  private readonly pending = new Map<number, { resolve: (r: McpToolResult) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly deps: McpBridgeDeps) {
    this.paths = mcpPaths(deps.userDataDir);
    this.endpoint = endpointFor(deps.userDataDir, deps.platform);
  }

  private log(line: string): void {
    this.deps.log?.(`[mcp] ${line}`);
  }

  // ── State on disk ────────────────────────────────────────────────────

  /** Was Claude turned on in a previous session? */
  readEnabled(): boolean {
    try {
      const s = JSON.parse(fs.readFileSync(this.paths.stateFile, 'utf8')) as { enabled?: unknown };
      return s.enabled === true;
    } catch {
      return false;
    }
  }

  private writeState(enabled: boolean): void {
    fs.mkdirSync(this.paths.dir, { recursive: true });
    fs.writeFileSync(this.paths.stateFile, JSON.stringify({ enabled }), 'utf8');
  }

  /** The current token, created on first use. Never logged, never sent to a page. */
  private token(): string {
    try {
      const t = fs.readFileSync(this.paths.tokenFile, 'utf8').trim();
      if (t.length >= 32) return t;
    } catch { /* first run */ }
    return this.rotateToken();
  }

  private rotateToken(): string {
    fs.mkdirSync(this.paths.dir, { recursive: true });
    const t = randomBytes(32).toString('hex');
    fs.writeFileSync(this.paths.tokenFile, t, { encoding: 'utf8', mode: 0o600 });
    return t;
  }

  private writeEndpoint(): void {
    fs.mkdirSync(this.paths.dir, { recursive: true });
    fs.writeFileSync(this.paths.endpointFile, JSON.stringify({ v: PIPE_PROTOCOL_VERSION, endpoint: this.endpoint }), 'utf8');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Start listening if Claude was turned on before. */
  async restore(): Promise<void> {
    if (this.readEnabled()) await this.enable();
  }

  async enable(): Promise<McpBridgeStatus> {
    this.enabled = true;
    this.writeState(true);
    this.token();
    this.writeEndpoint();
    if (!this.server) await this.listen();
    this.emit();
    return this.status();
  }

  /** Turn Claude off: stop listening, drop clients, and invalidate the token. */
  async disable(): Promise<McpBridgeStatus> {
    this.enabled = false;
    this.writeState(false);
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    await this.close();
    try { fs.unlinkSync(this.paths.tokenFile); } catch { /* none */ }
    this.emit();
    return this.status();
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    await this.close();
  }

  private close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private listen(): Promise<void> {
    return new Promise((resolve) => {
      if (this.deps.platform !== 'win32') {
        // A socket file left by a crash refuses the bind (EADDRINUSE).
        try { fs.unlinkSync(this.endpoint); } catch { /* none */ }
      }
      const server = net.createServer((socket) => this.accept(socket));
      server.on('error', (err) => {
        this.error = `Could not open the local connection for Claude: ${err.message}`;
        this.log(this.error);
        this.server = null;
        this.emit();
        resolve();
      });
      server.listen(this.endpoint, () => {
        if (this.deps.platform !== 'win32') {
          try { fs.chmodSync(this.endpoint, 0o600); } catch { /* best effort; the token still guards it */ }
        }
        this.server = server;
        this.error = null;
        this.log('listening');
        resolve();
      });
    });
  }

  // ── Connections ──────────────────────────────────────────────────────

  private accept(socket: net.Socket): void {
    const conn: Conn = { socket, info: null };
    this.conns.add(conn);
    let buffer = '';
    const helloTimer = setTimeout(() => { if (!conn.info) socket.destroy(); }, HELLO_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) { socket.destroy(); return; }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) void this.onLine(conn, line);
      }
    });
    socket.on('error', () => { /* closed below */ });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(conn);
      if (conn.info) {
        this.log(`client ${conn.info.name} disconnected`);
        this.emit();
      }
    });
  }

  private write(conn: Conn, msg: ServerMessage): void {
    if (!conn.socket.destroyed) conn.socket.write(`${JSON.stringify(msg)}\n`);
  }

  private async onLine(conn: Conn, line: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(line) as ClientMessage;
    } catch {
      conn.socket.destroy();
      return;
    }
    if (!conn.info) {
      if (msg.t !== 'hello' || typeof msg.token !== 'string') { conn.socket.destroy(); return; }
      if (!this.enabled) {
        this.write(conn, { t: 'denied', message: 'Claude is turned off in Premation (Settings → AI → Claude).' });
        conn.socket.end();
        return;
      }
      if (!tokensEqual(msg.token, this.token())) {
        this.log('refused a client with a wrong token');
        this.write(conn, { t: 'denied', message: 'Premation did not recognise this connection. Reconnect Claude in Premation (Settings → AI → Claude → Repair).' });
        conn.socket.end();
        return;
      }
      conn.info = {
        id: this.nextClientId++,
        name: String(msg.client?.name ?? 'MCP client').slice(0, 80),
        version: String(msg.client?.version ?? '').slice(0, 40),
        since: Date.now(),
        lastCallAt: null,
      };
      this.log(`client ${conn.info.name} ${conn.info.version} connected`);
      this.write(conn, { t: 'welcome', app: { version: this.deps.appVersion } });
      this.emit();
      return;
    }
    if (msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.name !== 'string') return;
    conn.info.lastCallAt = Date.now();
    const result = await this.relay(conn.info.id, msg.name, msg.args);
    this.write(conn, { t: 'result', id: msg.id, result });
  }

  // ── The page relay ───────────────────────────────────────────────────

  /** The editor page says whether it can take calls (a project is open). */
  setPageReady(ready: boolean): void {
    if (this.pageReady === ready) return;
    this.pageReady = ready;
    if (!ready) this.failPending('The Premation editor closed while Claude was working. Open a project and try again.');
    this.emit();
  }

  private relay(clientId: number, name: string, args: unknown): Promise<McpToolResult> {
    const page = this.deps.getPage();
    if (!page || page.isDestroyed() || !this.pageReady) {
      return Promise.resolve(textResult('Premation has no project open. Open (or create) a project in Premation, then try again.'));
    }
    const id = this.nextRelayId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(textResult(`${name} took longer than ${CALL_TIMEOUT_MS / 60_000} minutes and was abandoned.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      page.send('mcp:call', { id, clientId, name, args });
    });
  }

  /** The page's answer to a relayed call. */
  resolveCall(id: unknown, result: unknown): void {
    if (typeof id !== 'number') return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(sanitizeResult(result));
  }

  private failPending(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(textResult(message));
      this.pending.delete(id);
    }
  }

  // ── Status ───────────────────────────────────────────────────────────

  status(): McpBridgeStatus {
    return {
      enabled: this.enabled,
      listening: this.server !== null,
      error: this.error,
      pageReady: this.pageReady,
      clients: [...this.conns].flatMap((c) => (c.info ? [{ ...c.info }] : [])),
    };
  }

  private emit(): void {
    const s = this.status();
    this.deps.onStatus?.(s);
    // The page closes an open edit group when the last client goes away.
    const page = this.deps.getPage();
    if (page && !page.isDestroyed()) page.send('mcp:clients', s.clients.map((c) => c.id));
  }
}

/** Accept only the MCP result shape from the page; anything else becomes an error. */
export function sanitizeResult(raw: unknown): McpToolResult {
  if (!raw || typeof raw !== 'object') return textResult('The editor returned no result.');
  const r = raw as { content?: unknown; isError?: unknown };
  if (!Array.isArray(r.content)) return textResult('The editor returned a malformed result.');
  const content: McpToolResult['content'] = [];
  for (const c of r.content) {
    if (!c || typeof c !== 'object') continue;
    const item = c as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') content.push({ type: 'text', text: item.text });
    else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string' && /^image\/(png|jpeg|webp)$/.test(item.mimeType)) {
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '(no output)' });
  return { content, ...(r.isError === true ? { isError: true } : {}) };
}
