/**
 * Codex config.toml: Premation's tables are added, replaced and removed
 * without touching the rest of the file.
 */

import type { McpLaunchSpec } from './claudeConfig';
import { CODEX_TOOL_TIMEOUT_SEC, codexBlock, inspectCodex, removeCodex, upsertCodex } from './codexToml';

const SPEC: McpLaunchSpec = {
  command: 'C:\\Program Files\\Premation\\Premation.exe',
  args: ['C:\\Program Files\\Premation\\resources\\mcp\\premation-mcp.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', PREMATION_MCP_DIR: 'C:\\Users\\u\\AppData\\Roaming\\Premation\\mcp' },
};

const OTHER = `
# keep me
model = "gpt-5.5"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`;

describe('codex toml', () => {
  it('appends Premation and keeps every other server and comment', () => {
    const r = upsertCodex(OTHER, SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.text).toContain('# keep me');
    expect(r.text).toContain('[mcp_servers.context7]');
    expect(r.text).toContain(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`);
    expect(r.text).toContain("command = 'C:\\Program Files\\Premation\\Premation.exe'");
    expect(inspectCodex(r.text, SPEC)).toBe('ok');
  });

  it('does not rewrite an entry that already matches', () => {
    const once = upsertCodex(OTHER, SPEC);
    if (!once.ok) throw new Error(once.message);
    const twice = upsertCodex(once.text, SPEC);
    expect(twice).toEqual({ ok: true, changed: false, text: once.text });
  });

  it('replaces a stale Premation entry and leaves the neighbour', () => {
    const stale = `${OTHER}\n[mcp_servers.premation]\ncommand = 'old'\nargs = ['old']\n`;
    const r = upsertCodex(stale, SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toContain("command = 'old'");
    expect(r.text).toContain('[mcp_servers.context7]');
    expect(inspectCodex(r.text, SPEC)).toBe('ok');
  });

  it('calls a short timeout stale so Connect can raise it', () => {
    const block = codexBlock(SPEC).replace(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`, 'tool_timeout_sec = 60');
    expect(inspectCodex(block, SPEC)).toBe('stale');
  });

  it('removes only Premation', () => {
    const once = upsertCodex(OTHER, SPEC);
    if (!once.ok) throw new Error(once.message);
    const r = removeCodex(once.text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('[mcp_servers.context7]');
    expect(r.text).toContain('# keep me');
    expect(r.text).not.toContain('premation');
    expect(inspectCodex(r.text, SPEC)).toBe('absent');
  });

  it('deletes a file that held only Premation', () => {
    const r = removeCodex(codexBlock(SPEC));
    expect(r).toEqual({ ok: true, changed: true, text: '' });
  });

  it('does not treat a header inside a string as a table', () => {
    const text = 'note = "[mcp_servers.premation]"\n';
    expect(inspectCodex(text, SPEC)).toBe('absent');
    const multi = 'poem = """\n[mcp_servers.premation]\ncommand = \'nope\'\n"""\n';
    const r = upsertCodex(multi, SPEC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('poem = """');
    expect(r.text).toContain("command = 'nope'");
    expect(inspectCodex(r.text, SPEC)).toBe('ok');
  });

  it('refuses an unclosed multi-line string', () => {
    const text = 'poem = """\n[mcp_servers.premation]\n';
    expect(inspectCodex(text, SPEC)).toBe('malformed');
    const r = upsertCodex(text, SPEC);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/did not change it/);
  });
});
