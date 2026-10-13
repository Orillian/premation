/**
 * Cursor, Antigravity and ChatGPT each get Premation's entry in their own
 * file, and nothing else in that file moves.
 */

import path from 'node:path';
import { appConfigPath, codexCommand, listAppStatus, removeApp, writeApp, type McpAppId } from './appConfigs';
import type { ConfigFs, McpLaunchSpec, PlatformInfo } from './claudeConfig';

function memFs(files: Record<string, string> = {}, dirs: string[] = []): ConfigFs & { files: Map<string, string> } {
  const f = new Map(Object.entries(files));
  const d = new Set(dirs);
  const parentDirs = (p: string): void => {
    const dir = p.includes('\\') ? path.win32.dirname : path.posix.dirname;
    let cur = dir(p);
    while (cur && !d.has(cur) && cur !== dir(cur)) { d.add(cur); cur = dir(cur); }
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
    readdirSync: () => [],
    unlinkSync: (p) => { f.delete(p); },
  };
}

const WIN: PlatformInfo = { platform: 'win32', home: 'C:\\Users\\u', appData: 'C:\\Users\\u\\AppData\\Roaming', localAppData: 'C:\\Users\\u\\AppData\\Local' };
const SPEC: McpLaunchSpec = {
  command: 'C:\\Program Files\\Premation\\Premation.exe',
  args: ['C:\\Program Files\\Premation\\resources\\mcp\\premation-mcp.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', PREMATION_MCP_DIR: 'C:\\Users\\u\\AppData\\Roaming\\Premation\\mcp' },
};

describe('app config paths', () => {
  it('uses each app\'s own file', () => {
    expect(appConfigPath('cursor', WIN)).toBe('C:\\Users\\u\\.cursor\\mcp.json');
    expect(appConfigPath('antigravity', WIN)).toBe('C:\\Users\\u\\.gemini\\config\\mcp_config.json');
    expect(appConfigPath('chatgpt', WIN)).toBe('C:\\Users\\u\\.codex\\config.toml');
  });

  it('builds a codex mcp add command with the env before the program', () => {
    expect(codexCommand(SPEC, 'win32')).toMatch(/^codex mcp add premation --env ELECTRON_RUN_AS_NODE=1 --env PREMATION_MCP_DIR=/);
    expect(codexCommand(SPEC, 'win32')).toContain('-- "C:\\Program Files\\Premation\\Premation.exe"');
  });
});

describe('writeApp', () => {
  const ids: McpAppId[] = ['cursor', 'antigravity', 'chatgpt'];

  it.each(ids)('adds premation to %s and keeps the other server', (id) => {
    const file = appConfigPath(id, WIN);
    const prior = id === 'chatgpt'
      ? 'model = "gpt-5.5"\n\n[mcp_servers.context7]\ncommand = "npx"\n'
      : `${JSON.stringify({ mcpServers: { github: { command: 'gh' } }, theme: 'dark' }, null, 2)}\n`;
    const fs = memFs({ [file]: prior });
    const r = writeApp(id, SPEC, WIN, fs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.backup).toBe(`${file}.premation-backup`);
    const next = fs.files.get(file) ?? '';
    if (id === 'chatgpt') {
      expect(next).toContain('[mcp_servers.context7]');
      expect(next).toContain('[mcp_servers.premation]');
      expect(next).toContain('model = "gpt-5.5"');
    } else {
      const parsed = JSON.parse(next) as { theme: string; mcpServers: Record<string, { command: string }> };
      expect(parsed.theme).toBe('dark');
      expect(parsed.mcpServers.github?.command).toBe('gh');
      expect(parsed.mcpServers.premation?.command).toBe(SPEC.command);
    }
    const status = listAppStatus(SPEC, WIN, fs).find((a) => a.id === id);
    expect(status?.state).toBe('ok');
  });

  it('refuses a broken ChatGPT config', () => {
    const file = appConfigPath('chatgpt', WIN);
    const broken = 'poem = """\nnever closed\n';
    const fs = memFs({ [file]: broken });
    const r = writeApp('chatgpt', SPEC, WIN, fs);
    expect(r.ok).toBe(false);
    expect(fs.files.get(file)).toBe(broken);
  });

  it('removes only that app\'s entry', () => {
    const cursor = appConfigPath('cursor', WIN);
    const fs = memFs({
      [cursor]: `${JSON.stringify({ mcpServers: { github: { command: 'gh' }, premation: { command: 'old' } } })}\n`,
    });
    writeApp('chatgpt', SPEC, WIN, fs);
    const r = removeApp('cursor', WIN, fs);
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(fs.files.get(cursor) ?? '{}') as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.github).toEqual({ command: 'gh' });
    expect(parsed.mcpServers.premation).toBeUndefined();
    expect(listAppStatus(SPEC, WIN, fs).find((a) => a.id === 'chatgpt')?.state).toBe('ok');
    expect(listAppStatus(SPEC, WIN, fs).find((a) => a.id === 'cursor')?.state).toBe('absent');
  });
});
