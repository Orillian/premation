/**
 * Premation in Cursor, Antigravity and ChatGPT desktop — the same local MCP
 * server Claude uses (docs/MCP_PLAN.md), written into each app's own config.
 *
 *   Cursor        ~/.cursor/mcp.json                         mcpServers.premation
 *   Antigravity   ~/.gemini/config/mcp_config.json           mcpServers.premation
 *   ChatGPT       ~/.codex/config.toml                       [mcp_servers.premation]
 *
 * ChatGPT on the web cannot start a local process; the Codex file is what
 * ChatGPT desktop, the Codex CLI and the Codex IDE extension read. Each file
 * is the user's: only Premation's entry is added or removed, a file that does
 * not parse is left untouched, and a backup is written first.
 */

import path from 'node:path';
import {
  SERVER_KEY,
  backupPathFor,
  inspectEntry,
  manualSnippet,
  removeEntry,
  upsertEntry,
  type ConfigFs,
  type McpLaunchSpec,
  type PlatformInfo,
  type WriteResult,
} from './claudeConfig';
import { codexBlock, inspectCodex, removeCodex, upsertCodex } from './codexToml';

export type McpAppId = 'cursor' | 'antigravity' | 'chatgpt';

export interface McpAppStatus {
  id: McpAppId;
  name: string;
  /** The app's config folder already exists (the app has been run). */
  present: boolean;
  state: 'absent' | 'ok' | 'stale' | 'malformed';
  configPath: string;
  /** What the user does after Connect. */
  restart: string;
  blurb: string;
  /** A CLI the user can run instead. Empty when the app has no such command. */
  command: string;
  snippet: string;
}

interface AppDef {
  id: McpAppId;
  name: string;
  format: 'json' | 'toml';
  /** Path segments under the home directory. */
  rel: readonly string[];
  presentRel: readonly string[];
  restart: string;
  blurb: string;
}

const APPS: readonly AppDef[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    format: 'json',
    rel: ['.cursor', 'mcp.json'],
    presentRel: ['.cursor'],
    restart: 'Quit Cursor completely and open it again.',
    blurb: 'Cursor’s agent edits the Premation project you have open.',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    format: 'json',
    rel: ['.gemini', 'config', 'mcp_config.json'],
    presentRel: ['.gemini'],
    restart: 'Restart Antigravity so it reloads its MCP servers.',
    blurb: 'Antigravity IDE, the Antigravity app and the CLI share this config.',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    format: 'toml',
    rel: ['.codex', 'config.toml'],
    presentRel: ['.codex'],
    restart: 'Restart ChatGPT desktop or Codex. ChatGPT in the browser only reaches remote servers, so Premation is not added there.',
    blurb: 'ChatGPT desktop, Codex and the Codex IDE extension share this config. A single edit can run for up to 10 minutes.',
  },
];

export function isMcpAppId(id: unknown): id is McpAppId {
  return APPS.some((a) => a.id === id);
}

function defFor(id: McpAppId): AppDef {
  const d = APPS.find((a) => a.id === id);
  if (!d) throw new Error(`unknown app ${id}`);
  return d;
}

function homeJoin(platform: NodeJS.Platform, home: string, parts: readonly string[]): string {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(home, ...parts);
}

function dirOf(file: string): string {
  return file.includes('\\') ? path.win32.dirname(file) : path.posix.dirname(file);
}

export function appConfigPath(id: McpAppId, p: PlatformInfo): string {
  return homeJoin(p.platform, p.home, defFor(id).rel);
}

function shellQuote(s: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./\\-]+$/.test(s)) return s;
  return platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `codex mcp add`, for someone who would rather not have the file edited. */
export function codexCommand(spec: McpLaunchSpec, platform: NodeJS.Platform, key: string = SERVER_KEY): string {
  const env = Object.entries(spec.env).map(([k, v]) => `--env ${shellQuote(`${k}=${v}`, platform)}`);
  return [`codex mcp add ${key}`, ...env, '--', shellQuote(spec.command, platform), ...spec.args.map((a) => shellQuote(a, platform))].join(' ');
}

function snippetFor(app: AppDef, spec: McpLaunchSpec): string {
  return app.format === 'toml' ? codexBlock(spec) : manualSnippet(spec, SERVER_KEY);
}

function commandFor(app: AppDef, spec: McpLaunchSpec, platform: NodeJS.Platform): string {
  return app.id === 'chatgpt' ? codexCommand(spec, platform) : '';
}

export function listAppStatus(spec: McpLaunchSpec, p: PlatformInfo, fs: ConfigFs): McpAppStatus[] {
  return APPS.map((app) => {
    const configPath = homeJoin(p.platform, p.home, app.rel);
    const folder = homeJoin(p.platform, p.home, app.presentRel);
    const state = app.format === 'toml'
      ? inspectTomlFile(configPath, spec, fs)
      : inspectEntry(configPath, spec, fs, SERVER_KEY);
    return {
      id: app.id,
      name: app.name,
      present: fs.existsSync(folder) || fs.existsSync(configPath),
      state,
      configPath,
      restart: app.restart,
      blurb: app.blurb,
      command: commandFor(app, spec, p.platform),
      snippet: snippetFor(app, spec),
    };
  });
}

function inspectTomlFile(file: string, spec: McpLaunchSpec, fs: ConfigFs): McpAppStatus['state'] {
  if (!fs.existsSync(file)) return 'absent';
  try {
    return inspectCodex(fs.readFileSync(file, 'utf8'), spec);
  } catch {
    return 'malformed';
  }
}

function writeAtomic(file: string, text: string, fs: ConfigFs): void {
  fs.mkdirSync(dirOf(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

function writeToml(file: string, spec: McpLaunchSpec, fs: ConfigFs): WriteResult {
  let existed = false;
  let text = '';
  if (fs.existsSync(file)) {
    existed = true;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'unreadable', message: `Could not read ${file}: ${message}` };
    }
  }
  const edited = upsertCodex(text, spec);
  if (!edited.ok) return { ok: false, code: 'malformed', message: `${file}: ${edited.message}` };
  if (!edited.changed) return { ok: true, changed: false, backup: null };
  try {
    let backup: string | null = null;
    if (existed) {
      backup = backupPathFor(file);
      writeAtomic(backup, text.endsWith('\n') ? text : `${text}\n`, fs);
    }
    writeAtomic(file, edited.text, fs);
    return { ok: true, changed: true, backup };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'io', message: `Could not write ${file}: ${message}` };
  }
}

/** Add or replace Premation in that app's config, and turn nothing else over. */
export function writeApp(id: McpAppId, spec: McpLaunchSpec, p: PlatformInfo, fs: ConfigFs): WriteResult {
  const app = defFor(id);
  const file = homeJoin(p.platform, p.home, app.rel);
  if (app.format === 'toml') return writeToml(file, spec, fs);
  return upsertEntry(file, spec, fs, SERVER_KEY);
}

/** Remove Premation from that app's config. A missing file is a no-op. */
export function removeApp(id: McpAppId, p: PlatformInfo, fs: ConfigFs): WriteResult {
  const app = defFor(id);
  const file = homeJoin(p.platform, p.home, app.rel);
  if (app.format === 'json') return removeEntry(file, fs, SERVER_KEY);
  if (!fs.existsSync(file)) return { ok: true, changed: false, backup: null };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'unreadable', message: `Could not read ${file}: ${message}` };
  }
  const edited = removeCodex(text);
  if (!edited.ok) return { ok: false, code: 'malformed', message: `${file}: ${edited.message}` };
  if (!edited.changed) return { ok: true, changed: false, backup: null };
  try {
    const backup = backupPathFor(file);
    writeAtomic(backup, text.endsWith('\n') ? text : `${text}\n`, fs);
    if (edited.text === '') fs.unlinkSync(file);
    else writeAtomic(file, edited.text, fs);
    return { ok: true, changed: true, backup };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'io', message: `Could not write ${file}: ${message}` };
  }
}
