/**
 * Settings → AI → Claude → Test connection.
 *
 * Starts the server EXACTLY the way Claude's config does (same binary, same
 * arguments, same environment), speaks MCP to it over stdio, and makes one
 * harmless read call that has to travel the whole chain:
 *
 *   server ─ initialize ─ tools/list ─ tools/call get_selection
 *          ─ pipe ─ main ─ editor page ─ engine ─ and back
 *
 * Each link is its own step, so a failure names the link that broke instead
 * of "it doesn't work".
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { McpLaunchSpec } from './claudeConfig';

export interface TestStep {
  id: 'script' | 'start' | 'initialize' | 'tools' | 'app';
  label: string;
  ok: boolean;
  detail?: string;
}

const STEP_TIMEOUT_MS = 20_000;

export async function runSelfTest(spec: McpLaunchSpec, scriptPath: string): Promise<TestStep[]> {
  const steps: TestStep[] = [];
  const scriptOk = fs.existsSync(scriptPath);
  steps.push({ id: 'script', label: 'Premation\'s Claude connector is installed', ok: scriptOk, ...(scriptOk ? {} : { detail: `Missing: ${scriptPath}. Reinstall Premation.` }) });
  if (!scriptOk) return steps;

  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let spawnError: string | null = null;
  child.on('error', (err) => { spawnError = err.message; });

  const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = typeof msg.id === 'number' ? msg.id : -1;
        waiting.get(id)?.(msg);
        waiting.delete(id);
      } catch { /* not ours */ }
    }
  });
  child.stderr.resume();

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<Record<string, unknown> | null> => {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, STEP_TIMEOUT_MS);
      waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'Premation connection test', version: '1' },
    });
    steps.push({ id: 'start', label: 'The connector starts', ok: spawnError === null && init !== null, ...(spawnError ? { detail: spawnError } : init ? {} : { detail: 'It did not answer within 20 seconds.' }) });
    const initOk = !!init && !!init.result;
    steps.push({ id: 'initialize', label: 'It speaks MCP', ok: initOk, ...(initOk ? {} : { detail: JSON.stringify(init?.error ?? 'no answer') }) });
    if (!initOk) return steps;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const list = await request('tools/list', {});
    const tools = ((list?.result as { tools?: unknown[] } | undefined)?.tools ?? []).length;
    steps.push({ id: 'tools', label: 'It offers Premation\'s tools', ok: tools > 0, detail: `${tools} tools` });

    const call = await request('tools/call', { name: 'get_selection', arguments: {} });
    const result = call?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    const text = result?.content?.map((c) => c.text ?? '').join(' ').trim() ?? '';
    const appOk = !!result && result.isError !== true;
    steps.push({
      id: 'app',
      label: 'It reaches this Premation window and the engine',
      ok: appOk,
      detail: appOk ? 'Answered a read of the current selection.' : (text || 'No answer.'),
    });
  } finally {
    child.stdin.end();
    child.kill();
  }
  return steps;
}
