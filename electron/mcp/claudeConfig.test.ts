/**
 * Claude Desktop's config is the user's file: Premation adds, replaces and
 * removes exactly `mcpServers.premation`, never anything else, never a file
 * it cannot parse, and backs up what it changes (docs/MCP_PLAN.md §10).
 */

import path from 'node:path';
import {
  backupPathFor,
  claudeCodeCommand,
  detectClaude,
  inspectEntry,
  manualSnippet,
  readConfig,
  removeEntry,
  upsertEntry,
  type ConfigFs,
  type McpLaunchSpec,
  type PlatformInfo,
} from './claudeConfig';

/** An in-memory file system: files map plus a directory set. */
function memFs(files: Record<string, string> = {}, dirs: string[] = []): ConfigFs & { files: Map<string, string> } {
  const f = new Map(Object.entries(files));
  const d = new Set(dirs);
  const parentDirs = (p: string): void => {
    let cur = path.win32.dirname(p);
    while (cur && !d.has(cur) && cur !== path.win32.dirname(cur)) { d.add(cur); cur = path.win32.dirname(cur); }
  };
  for (const k of [...f.keys(), ...d]) parentDirs(k);
  return {
    files: f,
    existsSync: (p) => f.has(p) || d.has(p),
    readFileSync: (p) => {
      const v = f.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return v;
    },
    writeFileSync: (p, data) => { f.set(p, data); parentDirs(p); },
    renameSync: (from, to) => {
      const v = f.get(from);
      if (v === undefined) throw new Error('ENOENT');
      f.delete(from);
      f.set(to, v);
    },
    mkdirSync: (p) => { d.add(p); parentDirs(p); },
    readdirSync: (p) => [...new Set([...f.keys(), ...d].filter((k) => path.win32.dirname(k) === p).map((k) => path.win32.basename(k)))],
    unlinkSync: (p) => { f.delete(p); },
  };
}

const WIN: PlatformInfo = { platform: 'win32', home: 'C:\\Users\\u', appData: 'C:\\Users\\u\\AppData\\Roaming', localAppData: 'C:\\Users\\u\\AppData\\Local' };
const CLAUDE_DIR = 'C:\\Users\\u\\AppData\\Roaming\\Claude';
const CONFIG = `${CLAUDE_DIR}\\claude_desktop_config.json`;
const SPEC: McpLaunchSpec = {
  command: 'C:\\Program Files\\Premation\\Premation.exe',
  args: ['C:\\Program Files\\Premation\\resources\\mcp\\premation-mcp.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', PREMATION_MCP_DIR: 'C:\\Users\\u\\AppData\\Roaming\\Premation\\mcp' },
};
const OTHERS = { github: { command: 'gh-mcp' }, notion: { command: 'npx', args: ['notion-mcp'] } };

describe('detectClaude', () => {
  it('finds nothing when Claude was never installed', () => {
    expect(detectClaude(WIN, memFs())).toEqual({ installed: false, configPaths: [] });
  });

  it('finds the data folder of an installed Claude, with or without a config file yet', () => {
    expect(detectClaude(WIN, memFs({}, [CLAUDE_DIR]))).toEqual({ installed: true, configPaths: [CONFIG] });
  });

  it('targets the default folder when only the app is on disk (never run)', () => {
    const fs = memFs({ 'C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\claude.exe': '' });
    expect(detectClaude(WIN, fs)).toEqual({ installed: true, configPaths: [CONFIG] });
  });

  it('includes the Microsoft Store build\'s virtualised folder', () => {
    const store = 'C:\\Users\\u\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude';
    const det = detectClaude(WIN, memFs({}, [CLAUDE_DIR, store]));
    expect(det.configPaths).toEqual([CONFIG, `${store}\\claude_desktop_config.json`]);
  });
});

describe('upsertEntry', () => {
  it('creates the file when there is none, with no backup', () => {
    const fs = memFs({}, [CLAUDE_DIR]);
    const r = upsertEntry(CONFIG, SPEC, fs);
    expect(r).toEqual({ ok: true, changed: true, backup: null });
    expect(JSON.parse(fs.files.get(CONFIG)!)).toEqual({ mcpServers: { premation: SPEC } });
  });

  it('keeps every other server and top-level key, and backs the original up', () => {
    const original = { globalShortcut: 'Ctrl+Space', mcpServers: OTHERS };
    const fs = memFs({ [CONFIG]: JSON.stringify(original) });
    const r = upsertEntry(CONFIG, SPEC, fs);
    expect(r).toEqual({ ok: true, changed: true, backup: backupPathFor(CONFIG) });
    expect(JSON.parse(fs.files.get(CONFIG)!)).toEqual({ globalShortcut: 'Ctrl+Space', mcpServers: { ...OTHERS, premation: SPEC } });
    expect(JSON.parse(fs.files.get(backupPathFor(CONFIG))!)).toEqual(original);
  });

  it('replaces a duplicate/stale Premation entry instead of adding a second', () => {
    const fs = memFs({ [CONFIG]: JSON.stringify({ mcpServers: { ...OTHERS, premation: { command: 'C:\\old\\Premation.exe' } } }) });
    expect(inspectEntry(CONFIG, SPEC, fs)).toBe('stale');
    upsertEntry(CONFIG, SPEC, fs);
    const servers = JSON.parse(fs.files.get(CONFIG)!).mcpServers;
    expect(Object.keys(servers)).toEqual(['github', 'notion', 'premation']);
    expect(servers.premation).toEqual(SPEC);
    expect(inspectEntry(CONFIG, SPEC, fs)).toBe('ok');
  });

  it('does not rewrite a file that already launches this install', () => {
    const fs = memFs({ [CONFIG]: JSON.stringify({ mcpServers: { premation: SPEC } }) });
    expect(upsertEntry(CONFIG, SPEC, fs)).toEqual({ ok: true, changed: false, backup: null });
    expect(fs.files.has(backupPathFor(CONFIG))).toBe(false);
  });

  it('refuses a malformed file and leaves it byte for byte', () => {
    const broken = '{ "mcpServers": { "github": { "command": "gh" }, }';
    const fs = memFs({ [CONFIG]: broken });
    const r = upsertEntry(CONFIG, SPEC, fs);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.code).toBe('malformed');
    expect(fs.files.get(CONFIG)).toBe(broken);
    expect(inspectEntry(CONFIG, SPEC, fs)).toBe('malformed');
  });

  it('refuses mcpServers that is not an object', () => {
    const fs = memFs({ [CONFIG]: JSON.stringify({ mcpServers: [] }) });
    expect(upsertEntry(CONFIG, SPEC, fs).ok).toBe(false);
  });

  it('reads a UTF-8 BOM and an empty file as Claude does', () => {
    expect(readConfig(CONFIG, memFs({ [CONFIG]: `\uFEFF${JSON.stringify({ a: 1 })}` }))).toMatchObject({ ok: true, config: { a: 1 } });
    expect(readConfig(CONFIG, memFs({ [CONFIG]: '  \n' }))).toMatchObject({ ok: true, config: {} });
  });
});

describe('removeEntry', () => {
  it('removes only Premation, keeping the other servers', () => {
    const fs = memFs({ [CONFIG]: JSON.stringify({ x: 1, mcpServers: { ...OTHERS, premation: SPEC } }) });
    expect(removeEntry(CONFIG, fs)).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(fs.files.get(CONFIG)!)).toEqual({ x: 1, mcpServers: OTHERS });
  });

  it('is a no-op without the file or without our entry', () => {
    expect(removeEntry(CONFIG, memFs())).toEqual({ ok: true, changed: false, backup: null });
    const fs = memFs({ [CONFIG]: JSON.stringify({ mcpServers: OTHERS }) });
    expect(removeEntry(CONFIG, fs)).toEqual({ ok: true, changed: false, backup: null });
    expect(fs.files.has(backupPathFor(CONFIG))).toBe(false);
  });

  it('never touches a malformed file', () => {
    const fs = memFs({ [CONFIG]: 'not json' });
    expect(removeEntry(CONFIG, fs).ok).toBe(false);
    expect(fs.files.get(CONFIG)).toBe('not json');
  });
});

describe('the hand-setup text', () => {
  it('gives a snippet that is exactly the entry Connect would write', () => {
    expect(JSON.parse(manualSnippet(SPEC))).toEqual({ mcpServers: { premation: SPEC } });
  });

  it('puts the server name before the env options in the Claude Code command', () => {
    const cmd = claudeCodeCommand(SPEC, 'win32');
    expect(cmd.startsWith('claude mcp add premation --scope user --env ELECTRON_RUN_AS_NODE=1')).toBe(true);
    expect(cmd).toContain('-- "C:\\Program Files\\Premation\\Premation.exe"');
  });
});
