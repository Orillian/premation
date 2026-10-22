#!/usr/bin/env node
/**
 * Bundle the renderer half of `premation render-item`
 * (src/core/library/premium/renderItem.ts — the Library's own pack
 * interpreters) into ONE CommonJS file, build/cli/render-item.cjs, that
 * electron/cliRenderItem.ts requires at run time. electron/ is its own
 * TypeScript project and cannot import src/, so the code travels as a bundle,
 * the way the MCP server does (scripts/buildMcp.cjs).
 *
 *   node scripts/buildRenderItem.cjs
 */

const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outfile = path.join(root, 'build', 'cli', 'render-item.cjs');

esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'core', 'library', 'premium', 'renderItem.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
  tsconfig: path.join(root, 'tsconfig.json'),
  // Vite's import.meta.env reads in shared modules: a CLI build is the local edition.
  define: { 'import.meta.env': JSON.stringify({ MODE: 'production', DEV: false, PROD: true, VITE_EDITION: 'local' }) },
  // CSS / asset imports some shared modules pull in mean nothing in main.
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff2': 'empty' },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`[buildRenderItem] wrote ${path.relative(root, outfile)}`);
