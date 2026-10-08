/**
 * premation-mcp — the MCP server Claude Desktop and Claude Code launch.
 *
 * docs/MCP_PLAN.md §3.1. A thin adapter with no editing logic:
 *
 *   tools/list   the tool surface from `@motion/ai-tools` (the same vocabulary
 *                the in-app assistant uses, filtered by `mcpToolDefs`). Static,
 *                so Claude sees every tool even when Premation is closed.
 *   tools/call   forwarded over the local pipe to the running app, whose editor
 *                page runs it through the engine; the answer comes back as is.
 *
 * It runs as Node inside the installed app's own binary
 * (`ELECTRON_RUN_AS_NODE=1 Premation.exe premation-mcp.cjs`), so a user needs
 * no Node.js. `PREMATION_MCP_DIR` points at `<userData>/mcp`, where the app
 * keeps the pipe address and the token.
 *
 * stdout is the MCP channel and nothing else may write to it; diagnostics go
 * to stderr (Claude keeps them in its MCP log) and to `server.log` beside the
 * token — the tool names and outcomes, never arguments or project content.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOL_DEFS, MCP_SERVER_INSTRUCTIONS, mcpToolDefs } from '@motion/ai-tools';
import { PipeClient, PremationUnavailable, NOT_SET_UP, type McpToolResult } from './pipeClient';

declare const __PREMATION_VERSION__: string;
const VERSION = typeof __PREMATION_VERSION__ === 'string' ? __PREMATION_VERSION__ : '0.0.0-dev';

const LOG_LIMIT = 1024 * 1024;

function makeLogger(dir: string | undefined): (line: string) => void {
  const file = dir ? path.join(dir, 'server.log') : null;
  return (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    process.stderr.write(`[premation-mcp] ${stamped}\n`);
    if (!file) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${stamped}\n`);
    } catch { /* logging is best effort */ }
  };
}

/** The tools this server announces. */
export function listTools(): { tools: Array<{ name: string; description: string; inputSchema: unknown }> } {
  return {
    tools: mcpToolDefs(ALL_TOOL_DEFS).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export async function main(): Promise<void> {
  const dir = process.env.PREMATION_MCP_DIR;
  const log = makeLogger(dir);
  const known = new Set(listTools().tools.map((t) => t.name));

  const server = new Server(
    { name: 'premation', version: VERSION },
    { capabilities: { tools: {} }, instructions: MCP_SERVER_INSTRUCTIONS },
  );
  const pipe = dir ? new PipeClient({ dir, client: () => server.getClientVersion(), log }) : null;

  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!known.has(name)) return errorResult(`Unknown tool '${name}'. Call tools/list for the tools Premation offers.`);
    if (!pipe) return errorResult(NOT_SET_UP);
    const started = Date.now();
    try {
      const result = await pipe.call(name, args ?? {});
      log(`${name} ${result.isError ? 'failed' : 'ok'} ${Date.now() - started}ms`);
      return result;
    } catch (err) {
      const message = err instanceof PremationUnavailable ? err.message : `Premation could not run ${name}: ${err instanceof Error ? err.message : String(err)}`;
      log(`${name} unavailable: ${message}`);
      return errorResult(message);
    }
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => pipe?.close();
  await server.connect(transport);
  log(`started ${VERSION}${dir ? '' : ' (no PREMATION_MCP_DIR — not configured by Premation)'}`);
}

// Run when executed (the bundle), not when a test imports it.
if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`[premation-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
