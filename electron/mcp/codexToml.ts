/**
 * Premation's entry in Codex's `config.toml` — the file ChatGPT desktop, the
 * Codex CLI and the Codex IDE extension share (`~/.codex/config.toml`).
 *
 * The file is the user's. This edits only the `mcp_servers.premation` tables
 * and leaves every other key, server and comment alone. A file it cannot scan
 * (an unclosed multi-line string) is refused, never rewritten.
 */

import type { McpLaunchSpec } from './claudeConfig';
import { SERVER_KEY } from './claudeConfig';

/** Codex's default tool timeout is 60s; authoring and export run longer than that. */
export const CODEX_TOOL_TIMEOUT_SEC = 600;

export type TomlEdit =
  | { ok: true; changed: boolean; text: string }
  | { ok: false; message: string };

/** 'absent' when Premation is not in the file; 'ok' when it launches `spec`. */
export type CodexEntryState = 'absent' | 'ok' | 'stale';

function tomlLiteral(s: string): string {
  if (!s.includes("'") && !s.includes('\n') && !s.includes('\r')) return `'${s}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** The tables Connect writes. Stable, so an unchanged entry is not rewritten. */
export function codexBlock(spec: McpLaunchSpec, key: string = SERVER_KEY): string {
  const env = Object.entries(spec.env).map(([k, v]) => `${k} = ${tomlLiteral(v)}`);
  return [
    `[mcp_servers.${key}]`,
    `command = ${tomlLiteral(spec.command)}`,
    `args = [${spec.args.map(tomlLiteral).join(', ')}]`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    '',
    `[mcp_servers.${key}.env]`,
    ...env,
    '',
  ].join('\n');
}

function delimiterCount(line: string, delim: string): number {
  let n = 0;
  for (let i = 0; i <= line.length - delim.length; i += 1) {
    if (line.startsWith(delim, i)) {
      n += 1;
      i += delim.length - 1;
    }
  }
  return n;
}

interface Row {
  text: string;
  /** The table this line belongs to, including a header line itself. */
  header: string | null;
}

const TABLE = /^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/;

function analyse(text: string): { ok: true; rows: Row[] } | { ok: false; message: string } {
  const lines = text.split(/\r?\n/);
  const rows: Row[] = [];
  let multi: '"""' | "'''" | null = null;
  let header: string | null = null;
  for (const line of lines) {
    if (multi) {
      rows.push({ text: line, header });
      if (line.includes(multi)) multi = null;
      continue;
    }
    const table = TABLE.exec(line);
    if (table?.[1]) header = table[1].trim();
    rows.push({ text: line, header });
    const basic = delimiterCount(line, '"""');
    const literal = delimiterCount(line, "'''");
    if (basic % 2 === 1) multi = '"""';
    else if (literal % 2 === 1) multi = "'''";
  }
  if (multi) return { ok: false, message: 'config.toml has an unclosed multi-line string. Premation did not change it.' };
  return { ok: true, rows };
}

function owns(header: string | null, key: string): boolean {
  return header === `mcp_servers.${key}` || (header?.startsWith(`mcp_servers.${key}.`) ?? false);
}

function dotted(line: string, key: string): boolean {
  return new RegExp(`^\\s*mcp_servers\\.${key}(?:\\.|\\s*=)`).test(line);
}

function dropRow(row: Row, key: string): boolean {
  if (owns(row.header, key)) return true;
  return row.header === null && dotted(row.text, key);
}

function parseTomlString(raw: string): string | null {
  const s = raw.trim();
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    return end < 0 ? null : s.slice(1, end);
  }
  if (!s.startsWith('"')) return null;
  let out = '';
  for (let i = 1; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\') {
      i += 1;
      const n = s[i];
      out += n === 'n' ? '\n' : n === 'r' ? '\r' : (n ?? '');
      continue;
    }
    if (c === '"') return out;
    out += c ?? '';
  }
  return null;
}

function stringsIn(raw: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'" || c === '"') {
      const parsed = parseTomlString(raw.slice(i));
      if (parsed === null) return null;
      out.push(parsed);
      const quote = c;
      if (quote === "'") i += raw.slice(i + 1).indexOf("'") + 2;
      else {
        let j = i + 1;
        while (j < raw.length) {
          if (raw[j] === '\\') { j += 2; continue; }
          if (raw[j] === '"') { j += 1; break; }
          j += 1;
        }
        i = j;
      }
      continue;
    }
    i += 1;
  }
  return out;
}

interface ReadEntry {
  command: string | null;
  args: string[] | null;
  env: Record<string, string>;
  timeout: number | null;
  found: boolean;
}

function readEntry(rows: Row[], key: string): ReadEntry {
  const entry: ReadEntry = { command: null, args: null, env: {}, timeout: null, found: false };
  let env = false;
  for (const row of rows) {
    if (!owns(row.header, key) && !(row.header === null && dotted(row.text, key))) continue;
    entry.found = true;
    env = row.header === `mcp_servers.${key}.env`;
    const body = row.text.trim();
    if (body.startsWith('[')) continue;
    const eq = body.indexOf('=');
    if (eq < 0) continue;
    const name = body.slice(0, eq).trim().replace(/^mcp_servers\.[^.]+\./, '');
    const value = body.slice(eq + 1).trim();
    if (name === 'command' && !env) entry.command = parseTomlString(value);
    else if (name === 'args' && !env) entry.args = stringsIn(value);
    else if (name === 'tool_timeout_sec' && !env) {
      const n = Number(value);
      entry.timeout = Number.isFinite(n) ? n : null;
    } else if (env && /^[A-Za-z0-9_]+$/.test(name)) {
      const parsed = parseTomlString(value);
      if (parsed !== null) entry.env[name] = parsed;
    }
  }
  return entry;
}

function matches(entry: ReadEntry, spec: McpLaunchSpec): boolean {
  if (entry.command !== spec.command) return false;
  if (!entry.args || entry.args.length !== spec.args.length || entry.args.some((a, i) => a !== spec.args[i])) return false;
  if (entry.timeout !== CODEX_TOOL_TIMEOUT_SEC) return false;
  const keys = Object.keys(entry.env);
  const want = Object.keys(spec.env);
  if (keys.length !== want.length || want.some((k) => entry.env[k] !== spec.env[k])) return false;
  return true;
}

export function inspectCodex(text: string, spec: McpLaunchSpec, key: string = SERVER_KEY): CodexEntryState | 'malformed' {
  const scanned = analyse(text);
  if (!scanned.ok) return 'malformed';
  const entry = readEntry(scanned.rows, key);
  if (!entry.found) return 'absent';
  return matches(entry, spec) ? 'ok' : 'stale';
}

function rewrite(rows: Row[], key: string, block: string | null): string {
  const out: string[] = [];
  let inserted = false;
  const hasDrop = rows.some((row) => dropRow(row, key));
  for (const row of rows) {
    if (dropRow(row, key)) {
      if (!inserted && block !== null) {
        out.push(block.replace(/\s*$/, ''));
        inserted = true;
      }
      continue;
    }
    out.push(row.text);
  }
  if (block !== null && !inserted) {
    const base = out.join('\n').replace(/\s*$/, '');
    return `${base ? `${base}\n\n` : ''}${block.replace(/\s*$/, '')}\n`;
  }
  if (!hasDrop && block === null) return rows.map((r) => r.text).join('\n');
  return `${out.join('\n').replace(/\s*$/, '')}\n`;
}

/** Add or replace Premation's tables. `changed: false` when they already match. */
export function upsertCodex(text: string, spec: McpLaunchSpec, key: string = SERVER_KEY): TomlEdit {
  const state = inspectCodex(text, spec, key);
  if (state === 'malformed') return { ok: false, message: 'config.toml has an unclosed multi-line string. Premation did not change it.' };
  if (state === 'ok') return { ok: true, changed: false, text };
  const scanned = analyse(text);
  if (!scanned.ok) return { ok: false, message: scanned.message };
  return { ok: true, changed: true, text: rewrite(scanned.rows, key, codexBlock(spec, key)) };
}

/** Remove Premation's tables and nothing else. An empty result is `text: ''`. */
export function removeCodex(text: string, key: string = SERVER_KEY): TomlEdit {
  const scanned = analyse(text);
  if (!scanned.ok) return { ok: false, message: scanned.message };
  if (!scanned.rows.some((row) => dropRow(row, key))) return { ok: true, changed: false, text };
  const next = rewrite(scanned.rows, key, null);
  return { ok: true, changed: true, text: next.trim() === '' ? '' : next };
}
