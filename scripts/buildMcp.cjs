#!/usr/bin/env node
/**
 * Bundle the MCP server (packages/mcp-server) into ONE self-contained file,
 * build/mcp/premation-mcp.cjs, which electron-builder ships at
 * <resources>/mcp/ (electron-builder.yml extraResources).
 *
 * One file, no node_modules: the installed app runs it with its own binary as
 * Node (ELECTRON_RUN_AS_NODE=1), so the MCP SDK and the tool definitions have
 * to travel inside it (docs/MCP_PLAN.md D6).
 *
 *   node scripts/buildMcp.cjs           build
 *   node scripts/buildMcp.cjs --check   build, then start it and list its tools
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outfile = path.join(root, 'build', 'mcp', 'premation-mcp.cjs');
const { version } = require(path.join(root, 'package.json'));

esbuild.buildSync({
  entryPoints: [path.join(root, 'packages', 'mcp-server', 'src', 'server.ts')],
  bundle: true,
  platform: 'node',
  // Electron 44's Node; the bundle never runs anywhere older.
  target: 'node20',
  format: 'cjs',
  outfile,
  tsconfig: path.join(root, 'packages', 'mcp-server', 'tsconfig.json'),
  define: { __PREMATION_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`[buildMcp] wrote ${path.relative(root, outfile)}`);

// The tool list Claude Desktop shows on the extension's install screen
// (electron/mcp/extension.ts reads it). Taken from the bundle itself, so it is
// exactly what the server announces.
const toolsFile = path.join(path.dirname(outfile), 'tools.json');
delete require.cache[outfile];
process.env.PREMATION_MCP_NO_MAIN = '1'; // import for listTools only; do not start stdio
const { listTools } = require(outfile);
delete process.env.PREMATION_MCP_NO_MAIN;
require('node:fs').writeFileSync(toolsFile, JSON.stringify(listTools().tools.map((t) => ({ name: t.name, description: t.description }))));
console.log(`[buildMcp] wrote ${path.relative(root, toolsFile)}`);

if (process.argv.includes('--check')) {
  // initialize + tools/list over stdio, the way Claude starts it.
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'buildMcp-check', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  // Run directly, and loaded through a wrapper the way Claude Desktop's
  // built-in Node loads an extension entry (require.main is not the bundle).
  const launches = { direct: [outfile], wrapper: ['-e', `require(${JSON.stringify(outfile)})`] };
  let count = 0;
  for (const [how, args] of Object.entries(launches)) {
    const r = spawnSync(process.execPath, args, { input: lines, encoding: 'utf8', timeout: 15000 });
    const replies = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    count = replies.find((m) => m.id === 2)?.result?.tools?.length ?? 0;
    if (!count) {
      console.error(`[buildMcp] check failed (${how} launch):`, r.stderr || r.stdout);
      process.exit(1);
    }
  }
  console.log(`[buildMcp] check ok: ${count} tools`);
}
