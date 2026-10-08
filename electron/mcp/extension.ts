/**
 * Premation as a Claude Desktop EXTENSION (`.mcpb`) — how Connect installs it
 * (docs/MCP_PLAN.md §13).
 *
 * Why an extension and not only a config-file entry: Claude Desktop shows a
 * server's own name and logo only for an installed extension; a
 * `claude_desktop_config.json` entry always gets a generic icon. The bundle is
 * a zip Claude installs through its own screen (logo, tool list, Install):
 *
 *   manifest.json            MCPB manifest 0.3 — name "premation", "Premation"
 *   icon.png                 the app icon (512×512, transparent)
 *   server/premation-mcp.cjs the same bundled server the config route runs
 *
 * Claude runs the server with ITS bundled Node (`server.type: node`), so the
 * user still installs nothing. The one per-user value is where this app keeps
 * the pipe address and token (`PREMATION_MCP_DIR`), so the bundle is generated
 * at Connect time, not at build time.
 *
 * Claude owns the installed extension: Premation can detect it (to show
 * Configured / Needs repair) but removing it is done in Claude, Settings →
 * Extensions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { SERVER_KEY } from './claudeConfig';

export const EXTENSION_FILE = 'Premation.mcpb';

export interface ExtensionInputs {
  appVersion: string;
  /** build/mcp/premation-mcp.cjs (dev) or <resources>/mcp/premation-mcp.cjs. */
  scriptPath: string;
  /** build/mcp/tools.json, written by scripts/buildMcp.cjs: [{ name, description }]. */
  toolsPath: string;
  iconPath: string;
  /** `<userData>/mcp` — the pipe address and token live here. */
  mcpDir: string;
}

/** A semver MCPB accepts: `0.9.0-dev.3` is fine, a bare `0.9` is not. */
function semver(v: string): string {
  return /^\d+\.\d+\.\d+/.test(v) ? v : '0.0.0';
}

/** The tool list shown on Claude's install screen; first sentence of each description. */
function toolList(toolsPath: string): Array<{ name: string; description: string }> {
  try {
    const raw = JSON.parse(fs.readFileSync(toolsPath, 'utf8')) as Array<{ name?: unknown; description?: unknown }>;
    return raw.flatMap((t) => (typeof t.name === 'string' && typeof t.description === 'string'
      ? [{ name: t.name, description: (t.description.split(/(?<=\.)\s/)[0] ?? t.description).slice(0, 200) }]
      : []));
  } catch {
    return [];
  }
}

export function extensionManifest(inputs: Pick<ExtensionInputs, 'appVersion' | 'toolsPath' | 'mcpDir'>): Record<string, unknown> {
  const tools = toolList(inputs.toolsPath);
  return {
    manifest_version: '0.3',
    name: SERVER_KEY,
    display_name: 'Premation',
    version: semver(inputs.appVersion),
    description: 'Create and edit motion graphics in Premation: compositions, layers, keyframes, effects, 3D, and rendered previews.',
    long_description:
      'Claude works in the project open in the Premation desktop app, live. It can build whole designed pieces, animate with keyframes and easing, add effects, cameras and lights, and render frames to check its work. Every request is one undo step in Premation. Requires Premation to be installed and open.',
    author: { name: 'Premation' },
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'server/premation-mcp.cjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/premation-mcp.cjs'],
        env: { PREMATION_MCP_DIR: inputs.mcpDir },
      },
    },
    ...(tools.length ? { tools } : {}),
    tools_generated: false,
    keywords: ['motion graphics', 'animation', 'video', 'after effects', 'design'],
    license: 'AGPL-3.0-only',
    compatibility: { platforms: ['win32', 'darwin'], runtimes: { node: '>=18.0.0' } },
  };
}

/** Build the `.mcpb` bytes. Throws with a sentence when an input is missing. */
export function buildExtension(inputs: ExtensionInputs): Uint8Array {
  for (const [what, p] of [['connector', inputs.scriptPath], ['icon', inputs.iconPath]] as const) {
    if (!fs.existsSync(p)) throw new Error(`Premation's ${what} is missing (${p}). Reinstall Premation.`);
  }
  const manifest = extensionManifest(inputs);
  return zipSync({
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    'icon.png': new Uint8Array(fs.readFileSync(inputs.iconPath)),
    server: { 'premation-mcp.cjs': new Uint8Array(fs.readFileSync(inputs.scriptPath)) },
  }, { level: 6 });
}

/** Write the bundle beside the token and return its path. */
export function writeExtension(inputs: ExtensionInputs): string {
  const out = path.join(inputs.mcpDir, EXTENSION_FILE);
  fs.mkdirSync(inputs.mcpDir, { recursive: true });
  fs.writeFileSync(out, buildExtension(inputs));
  return out;
}

/** Read a bundle back (tests, diagnostics). */
export function readExtensionManifest(bytes: Uint8Array): Record<string, unknown> {
  const files = unzipSync(bytes);
  const m = files['manifest.json'];
  if (!m) throw new Error('no manifest.json');
  return JSON.parse(new TextDecoder().decode(m)) as Record<string, unknown>;
}

// ── Detecting the installed extension ───────────────────────────────────

export type ExtensionState = 'absent' | 'ok' | 'stale';

/**
 * Is Premation installed as an extension in this Claude data folder, and does
 * it point at THIS app's pipe? Claude unpacks extensions under
 * `<Claude data>/Claude Extensions/<id>/` with the manifest beside them.
 */
export function inspectExtension(claudeDataDir: string, mcpDir: string, fsx: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'readFileSync'> = fs): ExtensionState {
  const root = path.join(claudeDataDir, 'Claude Extensions');
  if (!fsx.existsSync(root)) return 'absent';
  let found: ExtensionState = 'absent';
  for (const id of safeList(fsx, root)) {
    const manifestPath = path.join(root, id, 'manifest.json');
    if (!fsx.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(String(fsx.readFileSync(manifestPath, 'utf8'))) as { name?: unknown; server?: { mcp_config?: { env?: Record<string, unknown> } } };
      if (m.name !== SERVER_KEY) continue;
      const dir = m.server?.mcp_config?.env?.PREMATION_MCP_DIR;
      if (dir === mcpDir) return 'ok';
      found = 'stale';
    } catch { /* not ours / unreadable */ }
  }
  return found;
}

function safeList(fsx: Pick<typeof fs, 'readdirSync'>, dir: string): string[] {
  try {
    return (fsx.readdirSync(dir) as unknown as string[]).map(String);
  } catch {
    return [];
  }
}
