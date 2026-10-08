/**
 * The server's end of the local pipe into the running Premation app
 * (electron/mcp/bridge.ts is the other end; keep the message shapes in step).
 *
 * Connects lazily — on the first tool call, not at start-up — because Claude
 * starts its MCP servers when IT starts, which is often before Premation is
 * open. Every call re-reads where to connect and the token, so turning Claude
 * off and on in Premation (which rotates the token) needs no Claude restart.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

/** MCP's CallToolResult, as the app sends it. A type alias, so it satisfies the SDK's open result type. */
export type McpToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
};

/** A failure with a sentence the user can act on, shown to Claude as the tool result. */
export class PremationUnavailable extends Error {}

export const NOT_RUNNING =
  'Premation is not open. Open Premation (and a project), then try again.';
export const NOT_SET_UP =
  'Claude is not set up in Premation. In Premation open Settings → AI → Claude and click Connect.';

interface Endpoint {
  endpoint: string;
  token: string;
}

/** Where the app listens and the token it expects, from the files it wrote. */
export function readEndpoint(dir: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): Endpoint {
  let endpoint: string;
  try {
    const e = JSON.parse(readFile(path.join(dir, 'endpoint.json'))) as { endpoint?: unknown };
    if (typeof e.endpoint !== 'string' || !e.endpoint) throw new Error('no endpoint');
    endpoint = e.endpoint;
  } catch {
    throw new PremationUnavailable(NOT_SET_UP);
  }
  let token: string;
  try {
    token = readFile(path.join(dir, 'token')).trim();
  } catch {
    // Turned off (Disconnect deletes the token).
    throw new PremationUnavailable(NOT_SET_UP);
  }
  return { endpoint, token };
}

type Pending = { resolve: (r: McpToolResult) => void; reject: (e: Error) => void };

export interface PipeClientOptions {
  dir: string;
  client: () => { name?: string; version?: string } | undefined;
  /** Test seam. */
  connect?: (endpoint: string) => net.Socket;
  log?: (line: string) => void;
}

export class PipeClient {
  private socket: net.Socket | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly o: PipeClientOptions) {}

  private open(): Promise<void> {
    if (this.ready) return this.ready;
    const { endpoint, token } = readEndpoint(this.o.dir);
    this.ready = new Promise<void>((resolve, reject) => {
      const socket = (this.o.connect ?? ((e: string) => net.connect(e)))(endpoint);
      let welcomed = false;
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ t: 'hello', v: 1, token, client: this.o.client() ?? {} })}\n`);
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          let msg: { t?: string; id?: number; result?: McpToolResult; message?: string };
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.t === 'welcome') {
            welcomed = true;
            this.socket = socket;
            this.o.log?.('connected to Premation');
            resolve();
          } else if (msg.t === 'denied') {
            reject(new PremationUnavailable(msg.message || NOT_SET_UP));
          } else if (msg.t === 'result' && typeof msg.id === 'number') {
            const p = this.pending.get(msg.id);
            if (p && msg.result) { this.pending.delete(msg.id); p.resolve(msg.result); }
          }
        }
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (!welcomed) {
          const absent = err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE';
          reject(new PremationUnavailable(absent ? NOT_RUNNING : `Could not reach Premation (${err.code ?? err.message}).`));
        }
      });
      socket.on('close', () => {
        this.socket = null;
        this.ready = null;
        if (!welcomed) reject(new PremationUnavailable(NOT_RUNNING));
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(new PremationUnavailable('Premation closed while the call was running. Open Premation and try again.'));
        }
      });
    }).catch((err: unknown) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /** Run one tool in the app. Throws `PremationUnavailable` with a user-facing sentence. */
  async call(name: string, args: unknown): Promise<McpToolResult> {
    await this.open();
    const socket = this.socket;
    if (!socket) throw new PremationUnavailable(NOT_RUNNING);
    const id = this.nextId++;
    return new Promise<McpToolResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ t: 'call', id, name, args: args ?? {} })}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}
