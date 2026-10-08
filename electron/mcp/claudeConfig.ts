/**
 * Claude Desktop's MCP configuration: find it, add Premation to it, take
 * Premation out of it — and touch NOTHING else (docs/MCP_PLAN.md D7, §10).
 *
 * The file belongs to Claude Desktop and usually holds the user's other MCP
 * servers. So every write here is:
 *
 *   • a read-modify-write of exactly `mcpServers.premation`, every other key
 *     and server carried over as parsed;
 *   • refused outright when the file does not parse — a malformed config is
 *     reported with its path and the manual snippet, never "repaired" by
 *     overwriting it;
 *   • preceded by a backup of the parsed original (`…json.premation-backup`);
 *   • a temp-file + rename, so Claude never reads half a file.
 *
 * Synchronous on purpose: the files are a few KB, and the uninstall path
 * (`--premation-mcp-uninstall`, run by the Windows uninstaller before the
 * app's files are removed) runs before Electron is ready and must finish
 * before the process exits.
 *
 * Pure apart from the injected file system, so the decision table is tested
 * against an in-memory one (claudeConfig.test.ts).
 */

import path from 'node:path';

/** The `mcpServers` key Premation owns. Nothing else is ever written. */
export const SERVER_KEY = 'premation';

/** What a Claude config entry launches. */
export interface McpLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The slice of `fs` this module uses — injectable for tests. */
export interface ConfigFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, data: string, enc: 'utf8'): void;
  renameSync(from: string, to: string): void;
  mkdirSync(p: string, opts: { recursive: true }): void;
  readdirSync(p: string): string[];
  unlinkSync(p: string): void;
}

export interface PlatformInfo {
  platform: NodeJS.Platform;
  home: string;
  /** %APPDATA% on Windows. */
  appData?: string;
  /** %LOCALAPPDATA% on Windows. */
  localAppData?: string;
}

export interface ClaudeDetection {
  /** Claude Desktop appears to be installed (the app, or its data folder). */
  installed: boolean;
  /** Every config file Premation would write — one per Claude data folder found. */
  configPaths: string[];
}

const CONFIG_NAME = 'claude_desktop_config.json';

/** Claude Desktop's data folders that exist on this machine (Store and classic installs on Windows). */
function claudeDataDirs(p: PlatformInfo, fs: ConfigFs): string[] {
  const dirs: string[] = [];
  const add = (d: string | undefined): void => {
    if (d && fs.existsSync(d) && !dirs.includes(d)) dirs.push(d);
  };
  if (p.platform === 'win32') {
    add(p.appData ? path.win32.join(p.appData, 'Claude') : undefined);
    // The Microsoft Store (MSIX) build virtualises %APPDATA% into its package.
    if (p.localAppData) {
      const pkgs = path.win32.join(p.localAppData, 'Packages');
      if (fs.existsSync(pkgs)) {
        for (const name of safeReaddir(fs, pkgs)) {
          if (/^Claude_/i.test(name)) add(path.win32.join(pkgs, name, 'LocalCache', 'Roaming', 'Claude'));
        }
      }
    }
  } else if (p.platform === 'darwin') {
    add(path.posix.join(p.home, 'Library', 'Application Support', 'Claude'));
  } else {
    add(path.posix.join(p.home, '.config', 'Claude'));
  }
  return dirs;
}

function safeReaddir(fs: ConfigFs, dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Where a fresh install keeps its data folder, for an app that has never run. */
function defaultDataDir(p: PlatformInfo): string | null {
  if (p.platform === 'win32') return p.appData ? path.win32.join(p.appData, 'Claude') : null;
  if (p.platform === 'darwin') return path.posix.join(p.home, 'Library', 'Application Support', 'Claude');
  return path.posix.join(p.home, '.config', 'Claude');
}

/** Is the Claude Desktop app itself on disk? (Its data folder may not exist until first run.) */
function claudeAppInstalled(p: PlatformInfo, fs: ConfigFs): boolean {
  const candidates: string[] = [];
  if (p.platform === 'win32') {
    if (p.localAppData) {
      candidates.push(path.win32.join(p.localAppData, 'AnthropicClaude', 'claude.exe'));
      candidates.push(path.win32.join(p.localAppData, 'Programs', 'Claude', 'Claude.exe'));
    }
  } else if (p.platform === 'darwin') {
    candidates.push('/Applications/Claude.app', path.posix.join(p.home, 'Applications', 'Claude.app'));
  }
  return candidates.some((c) => fs.existsSync(c));
}

export function detectClaude(p: PlatformInfo, fs: ConfigFs): ClaudeDetection {
  const dirs = claudeDataDirs(p, fs);
  const appInstalled = claudeAppInstalled(p, fs);
  const installed = dirs.length > 0 || appInstalled;
  const pathJoin = p.platform === 'win32' ? path.win32.join : path.posix.join;
  let configDirs = dirs;
  if (configDirs.length === 0 && appInstalled) {
    const d = defaultDataDir(p);
    configDirs = d ? [d] : [];
  }
  return { installed, configPaths: configDirs.map((d) => pathJoin(d, CONFIG_NAME)) };
}

// ── Reading ────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type ReadResult =
  | { ok: true; config: JsonObject; existed: boolean }
  | { ok: false; code: 'malformed' | 'unreadable'; message: string };

export function readConfig(file: string, fs: ConfigFs): ReadResult {
  if (!fs.existsSync(file)) return { ok: true, config: {}, existed: false };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, code: 'unreadable', message: `Could not read ${file}: ${errMessage(err)}` };
  }
  // An empty file is what some editors leave behind; Claude treats it as no config.
  if (text.trim() === '') return { ok: true, config: {}, existed: true };
  try {
    const parsed: unknown = JSON.parse(stripBom(text));
    if (!isObject(parsed)) return { ok: false, code: 'malformed', message: `${file} is not a JSON object.` };
    if (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers)) {
      return { ok: false, code: 'malformed', message: `${file}: "mcpServers" is not an object.` };
    }
    return { ok: true, config: parsed, existed: true };
  } catch (err) {
    return { ok: false, code: 'malformed', message: `${file} is not valid JSON (${errMessage(err)}).` };
  }
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Inspecting ─────────────────────────────────────────────────────────

/**
 *   absent     no Premation entry
 *   ok         an entry that launches exactly `spec`
 *   stale      an entry, but it launches something else (an old install path,
 *              a moved user-data folder) — Repair rewrites it
 *   malformed  the file does not parse; nothing can be said or written
 */
export type EntryState = 'absent' | 'ok' | 'stale' | 'malformed';

export function sameLaunch(entry: unknown, spec: McpLaunchSpec): boolean {
  if (!isObject(entry)) return false;
  if (entry.command !== spec.command) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (args.length !== spec.args.length || args.some((a, i) => a !== spec.args[i])) return false;
  const env = isObject(entry.env) ? entry.env : {};
  return Object.entries(spec.env).every(([k, v]) => env[k] === v);
}

export function inspectEntry(file: string, spec: McpLaunchSpec, fs: ConfigFs): EntryState {
  const r = readConfig(file, fs);
  if (!r.ok) return 'malformed';
  const servers = isObject(r.config.mcpServers) ? r.config.mcpServers : {};
  if (!(SERVER_KEY in servers)) return 'absent';
  return sameLaunch(servers[SERVER_KEY], spec) ? 'ok' : 'stale';
}

// ── Writing ────────────────────────────────────────────────────────────

export type WriteResult =
  | { ok: true; changed: boolean; backup: string | null }
  | { ok: false; code: 'malformed' | 'unreadable' | 'io'; message: string };

export function backupPathFor(file: string): string {
  return `${file}.premation-backup`;
}

function writeAtomicSync(file: string, text: string, fs: ConfigFs): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

function commit(file: string, before: { config: JsonObject; existed: boolean }, after: JsonObject, fs: ConfigFs): WriteResult {
  try {
    let backup: string | null = null;
    if (before.existed) {
      backup = backupPathFor(file);
      // The PARSED original, re-serialised: a valid file is all a backup is for.
      writeAtomicSync(backup, `${JSON.stringify(before.config, null, 2)}\n`, fs);
    }
    writeAtomicSync(file, `${JSON.stringify(after, null, 2)}\n`, fs);
    return { ok: true, changed: true, backup };
  } catch (err) {
    return { ok: false, code: 'io', message: `Could not write ${file}: ${errMessage(err)}` };
  }
}

/** Add or replace `mcpServers.premation`, keeping every other key and server. */
export function upsertEntry(file: string, spec: McpLaunchSpec, fs: ConfigFs): WriteResult {
  const r = readConfig(file, fs);
  if (!r.ok) return r;
  const servers = isObject(r.config.mcpServers) ? r.config.mcpServers : {};
  if (sameLaunch(servers[SERVER_KEY], spec)) return { ok: true, changed: false, backup: null };
  const next: JsonObject = {
    ...r.config,
    mcpServers: { ...servers, [SERVER_KEY]: { command: spec.command, args: [...spec.args], env: { ...spec.env } } },
  };
  return commit(file, r, next, fs);
}

/** Remove `mcpServers.premation` and nothing else. A missing file or entry is a no-op. */
export function removeEntry(file: string, fs: ConfigFs): WriteResult {
  if (!fs.existsSync(file)) return { ok: true, changed: false, backup: null };
  const r = readConfig(file, fs);
  if (!r.ok) return r;
  const servers = isObject(r.config.mcpServers) ? r.config.mcpServers : null;
  if (!servers || !(SERVER_KEY in servers)) return { ok: true, changed: false, backup: null };
  const rest: JsonObject = { ...servers };
  delete rest[SERVER_KEY];
  return commit(file, r, { ...r.config, mcpServers: rest }, fs);
}

/** The JSON a user pastes by hand when the file cannot be edited for them. */
export function manualSnippet(spec: McpLaunchSpec): string {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: spec.command, args: spec.args, env: spec.env } } }, null, 2);
}

/** Quote one argument for a shell command line the user copies. */
function shellQuote(s: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./\\-]+$/.test(s)) return s;
  return platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The one-line `claude mcp add` command for Claude Code (user scope). */
export function claudeCodeCommand(spec: McpLaunchSpec, platform: NodeJS.Platform): string {
  const env = Object.entries(spec.env).map(([k, v]) => `--env ${shellQuote(`${k}=${v}`, platform)}`);
  // The name goes FIRST: `--env` takes several values, and a name after it
  // would be read as one more KEY=value.
  return [`claude mcp add ${SERVER_KEY} --scope user`, ...env, '--', shellQuote(spec.command, platform), ...spec.args.map((a) => shellQuote(a, platform))].join(' ');
}
