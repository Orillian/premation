/**
 * Runs an MCP client's tool calls in the editor (docs/MCP_PLAN.md D2, §3.3).
 *
 * Main relays each call from the MCP pipe to this page; this runs it with the
 * SAME registry, ToolContext and engine transaction the in-app assistant uses
 * (`getAiRegistry`, `sessionToolContext`, `beginAiTransaction`). There is no
 * second implementation of any tool here — only what an outside client needs
 * on top: undo grouping across calls, render feedback as MCP images, the
 * author-mode entry point, and the paid-plan gate.
 *
 * ## Undo (D4)
 *
 *   • A changing call outside a group is ONE engine gesture = one undo entry,
 *     labelled `Claude: <tool>`, rolled back whole if the tool fails.
 *   • `begin_edit(label)` opens a gesture that every following call joins,
 *     until `end_edit` (commit or roll back). It also closes itself after
 *     GROUP_IDLE_MS without a call, when the client disconnects, and when the
 *     user starts editing (`userActivity`) — so the user's own edits do not
 *     land in Claude's undo step.
 *
 * Calls run one at a time (a queue), whichever client sent them.
 *
 * No React, no zustand: the editor's hook (src/hooks/useMcpHost.ts) wires this
 * to the preload bridge and renders the "Claude is editing" badge from
 * `subscribe`.
 */

import type { AiToolDef, ToolContext, ToolRegistry, ToolResult } from '@motion/ai-tools';
import { isMcpTool, mutates } from '@motion/ai-tools';
import {
  adviseScript,
  authorSystemPrompt,
  coerceScript,
  compileScript,
  formatAdvice,
  formatRepairs,
} from '@motion/author';
import type { AiTransaction } from '../aiTransaction';

/** An open `begin_edit` group closes itself after this long without a call. */
export const GROUP_IDLE_MS = 30_000;

/** MCP's CallToolResult. */
export interface McpResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface McpCall {
  clientId: number;
  name: string;
  args: unknown;
}

/** What the badge shows. */
export interface McpActivity {
  /** A call is running right now. */
  busy: boolean;
  /** The tool running, when busy. */
  tool: string | null;
  /** The open group's label, or null. */
  group: string | null;
}

/** May this account use Claude for Premation? */
export type AccessDecision = { ok: true } | { ok: false; message: string };

export interface McpHostDeps {
  registry(): Pick<ToolRegistry, 'execute' | 'has' | 'get'>;
  beginTransaction(label: string): Promise<AiTransaction>;
  /** A context over `session` that keeps the run's style/scene window and the client's aliases. */
  context(session: AiTransaction['session'] | null, signal: AbortSignal, aliases: Map<string, string>): ToolContext;
  /** Start a run (resets the scene window, style, entrance seed); called once per client. */
  freshRun(signal: AbortSignal): void;
  /** PNG of the active composition at `seconds`, long side ≤ maxSize; null if it could not draw. */
  renderStill(seconds: number, maxSize: number): Promise<{ mimeType: string; data: string } | null>;
  /** A labelled contact sheet of `cells` frames between two times. */
  renderStrip(startSec: number, endSec: number, cells: number): Promise<{ mimeType: string; data: string } | null>;
  access(): Promise<AccessDecision>;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Group {
  tx: AiTransaction;
  label: string;
  clientId: number;
  timer: unknown;
}

const text = (t: string, isError = false): McpResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function fromToolResult(r: ToolResult): McpResult {
  const parts = [r.content];
  if (r.data !== undefined) {
    try {
      parts.push(JSON.stringify(r.data, null, 1));
    } catch { /* unserialisable data: the prose is enough */ }
  }
  return text(parts.filter(Boolean).join('\n'), !r.ok);
}

function obj(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export class McpCallHost {
  private queue: Promise<unknown> = Promise.resolve();
  private group: Group | null = null;
  private abort = new AbortController();
  /** Per-client alias maps (handles a client invented → real ids), kept across calls. */
  private readonly aliases = new Map<number, Map<string, string>>();
  private activity: McpActivity = { busy: false, tool: null, group: null };
  private readonly listeners = new Set<(a: McpActivity) => void>();

  constructor(private readonly deps: McpHostDeps) {}

  // ── Activity (the badge) ─────────────────────────────────────────────

  subscribe(fn: (a: McpActivity) => void): () => void {
    this.listeners.add(fn);
    fn(this.activity);
    return () => this.listeners.delete(fn);
  }

  getActivity(): McpActivity {
    return this.activity;
  }

  private setActivity(patch: Partial<McpActivity>): void {
    this.activity = { ...this.activity, ...patch };
    for (const fn of this.listeners) fn(this.activity);
  }

  // ── Entry points ─────────────────────────────────────────────────────

  /** Run one call; calls are queued so two clients never interleave edits. */
  handle(call: McpCall): Promise<McpResult> {
    const run = this.queue.then(() => this.run(call));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The connected clients changed; a group whose client left is committed. */
  clientsChanged(ids: readonly number[]): Promise<void> {
    for (const id of [...this.aliases.keys()]) if (!ids.includes(id)) this.aliases.delete(id);
    const g = this.group;
    return g && !ids.includes(g.clientId) ? this.closeQueued(g) : Promise.resolve();
  }

  /** The user started editing: commit Claude's open group first, so their edit is its own step. */
  userActivity(): Promise<void> {
    const g = this.group;
    return g && !this.activity.busy ? this.closeQueued(g) : Promise.resolve();
  }

  /**
   * Commit `g` through the call queue, so it is ordered with the calls around
   * it. Called while idle, the queue is empty and it runs at once.
   */
  private closeQueued(g: Group): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.group === g) await this.closeGroup(true);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The badge's Stop: abort what is running and throw the open group away. */
  async stop(): Promise<void> {
    this.abort.abort();
    this.abort = new AbortController();
    if (this.group) await this.closeGroup(false);
  }

  // ── Running a call ───────────────────────────────────────────────────

  private aliasesFor(clientId: number): Map<string, string> {
    let m = this.aliases.get(clientId);
    if (!m) {
      m = new Map();
      this.aliases.set(clientId, m);
      // A new client starts a new run: no style or scene window from before.
      this.deps.freshRun(this.abort.signal);
    }
    return m;
  }

  private async run(call: McpCall): Promise<McpResult> {
    const reg = this.deps.registry();
    if (!isMcpTool(call.name, (n) => reg.has(n))) {
      return text(`Premation does not offer '${call.name}' to Claude.`, true);
    }
    const access = await this.deps.access();
    if (!access.ok) return text(access.message, true);

    this.setActivity({ busy: true, tool: call.name });
    try {
      if (this.group) this.armIdle();
      switch (call.name) {
        case 'begin_edit': return await this.beginEdit(call);
        case 'end_edit': return await this.endEdit(call);
        case 'render_frame': return await this.renderFrame(call);
        case 'render_filmstrip': return await this.renderStrip(call);
        case 'get_author_guide': return this.authorGuide(call);
        case 'author_scene': return await this.inTransaction(call, 'Claude: build scene', (ctx) => this.authorScene(call, ctx));
        default: return await this.registryCall(call);
      }
    } catch (err) {
      return text(`${call.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.setActivity({ busy: false, tool: null });
      if (this.group) this.armIdle();
    }
  }

  private async registryCall(call: McpCall): Promise<McpResult> {
    const reg = this.deps.registry();
    const def: AiToolDef | undefined = reg.get(call.name);
    const aliases = this.aliasesFor(call.clientId);
    if (!def || !mutates(def.kind)) {
      const ctx = this.deps.context(this.group?.tx.session ?? null, this.abort.signal, aliases);
      return fromToolResult(await reg.execute(call.name, call.args, ctx));
    }
    return this.inTransaction(call, `Claude: ${call.name.replace(/_/g, ' ')}`, async (ctx) => {
      const r = await reg.execute(call.name, call.args, ctx);
      return { result: fromToolResult(r), ok: r.ok };
    });
  }

  /**
   * Run a changing call: inside the open group, or as its own undo entry that
   * is rolled back whole when the call fails.
   */
  private async inTransaction(
    call: McpCall,
    label: string,
    body: (ctx: ToolContext) => Promise<{ result: McpResult; ok: boolean }>,
  ): Promise<McpResult> {
    const aliases = this.aliasesFor(call.clientId);
    if (this.group) {
      const ctx = this.deps.context(this.group.tx.session, this.abort.signal, aliases);
      return (await body(ctx)).result;
    }
    const tx = await this.deps.beginTransaction(label);
    try {
      const ctx = this.deps.context(tx.session, this.abort.signal, aliases);
      const { result, ok } = await body(ctx);
      if (ok) await tx.commit();
      else await tx.rollback();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ── Groups ───────────────────────────────────────────────────────────

  private async beginEdit(call: McpCall): Promise<McpResult> {
    const label = String(obj(call.args).label ?? '').trim().slice(0, 80) || 'edit';
    if (this.group) {
      return text(`A group is already open ("${this.group.label}"). Call end_edit before starting another.`, true);
    }
    const tx = await this.deps.beginTransaction(`Claude: ${label}`);
    this.group = { tx, label, clientId: call.clientId, timer: null };
    this.armIdle();
    this.setActivity({ group: label });
    return text(`Group "${label}" open. Every change until end_edit is one undo step.`);
  }

  private async endEdit(call: McpCall): Promise<McpResult> {
    if (!this.group) return text('No group is open; nothing to close.');
    const commit = obj(call.args).commit !== false;
    const label = this.group.label;
    const outcome = await this.closeGroup(commit);
    if (!commit) return text(`Group "${label}" discarded: every change it made was undone.`);
    return text(outcome === 'empty' ? `Group "${label}" closed; it changed nothing.` : `Group "${label}" saved as one undo step.`);
  }

  private armIdle(): void {
    const g = this.group;
    if (!g) return;
    const clear = this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    if (g.timer !== null) clear(g.timer);
    g.timer = set(() => {
      if (this.group === g && !this.activity.busy) void this.closeQueued(g);
    }, GROUP_IDLE_MS);
  }

  private async closeGroup(commit: boolean): Promise<'engine' | 'empty'> {
    const g = this.group;
    if (!g) return 'empty';
    this.group = null;
    (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(g.timer);
    this.setActivity({ group: null });
    if (!commit) {
      await g.tx.rollback();
      return 'empty';
    }
    return (await g.tx.commit()).kind;
  }

  // ── Eyes ─────────────────────────────────────────────────────────────

  private async renderFrame(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const time = Math.max(0, num(a.time, 0));
    const maxSize = Math.max(128, Math.min(2048, Math.round(num(a.maxSize, 1024))));
    const img = await this.deps.renderStill(time, maxSize);
    if (!img) return text(`Premation could not render the frame at ${time}s.`, true);
    return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, { type: 'text', text: `Frame at ${time}s.` }] };
  }

  private async renderStrip(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const start = Math.max(0, num(a.startSec, 0));
    const end = num(a.endSec, start);
    if (!(end > start)) return text('endSec must be after startSec.', true);
    const cells = Math.max(2, Math.min(12, Math.round(num(a.cells, 8))));
    const img = await this.deps.renderStrip(start, end, cells);
    if (!img) return text(`Premation could not render frames between ${start}s and ${end}s.`, true);
    return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, { type: 'text', text: `${cells} frames from ${start}s to ${end}s, each labelled with its time.` }] };
  }

  // ── Author mode ──────────────────────────────────────────────────────

  private authorGuide(call: McpCall): McpResult {
    const brief = String(obj(call.args).brief ?? '');
    return text([
      authorSystemPrompt({ prompt: brief }),
      '',
      'Pass the script to author_scene as `script`: the header fields, `globals`, and `beats` — each beat with its `startSec`, `endSec` and `layers` — in one object. Premation fits it to the active composition (its size, fps and length).',
    ].join('\n'));
  }

  private async authorScene(call: McpCall, ctx: ToolContext): Promise<{ result: McpResult; ok: boolean }> {
    const raw = obj(call.args).script;
    if (!raw || typeof raw !== 'object') return { result: text('author_scene needs `script` (see get_author_guide).', true), ok: false };
    const comp = await ctx.comp.get();
    const coerced = coerceScript(raw, { durationSec: comp.durationSeconds, width: comp.width, height: comp.height });
    if (coerced.value.beats.length === 0 && coerced.value.globals.length === 0) {
      return { result: text(`The script has nothing to build.\n${formatRepairs(coerced.repairs)}`, true), ok: false };
    }
    const compiled = compileScript(coerced.value);
    const advice = adviseScript(coerced.value, compiled, { width: comp.width, height: comp.height, fps: comp.fps });
    const reg = this.deps.registry();
    const rejected: string[] = [];
    let applied = 0;
    for (const c of compiled.calls) {
      if (ctx.signal.aborted) break;
      const r = await reg.execute(c.name, c.args, ctx);
      if (r.ok) applied++;
      else rejected.push(`- ${c.name}: ${r.content.slice(0, 240)}`);
    }
    if (applied === 0) {
      return { result: text(`Nothing could be built; every compiled call was rejected.\n${rejected.slice(0, 20).join('\n')}`, true), ok: false };
    }
    const lines = [
      `Built "${coerced.value.title || 'scene'}": ${coerced.value.beats.length} beats, ${applied} of ${compiled.calls.length} operations applied, in ${comp.width}×${comp.height} at ${comp.fps} fps, ${comp.durationSeconds}s.`,
    ];
    if (coerced.repairs.length) lines.push('', 'Repaired in the script:', formatRepairs(coerced.repairs));
    if (rejected.length) lines.push('', 'Rejected by the engine:', ...rejected.slice(0, 20));
    if (advice.findings.length) lines.push('', 'Design advisors:', formatAdvice(advice.findings));
    lines.push('', 'Look at it with render_filmstrip, then refine with the individual tools.');
    return { result: text(lines.join('\n')), ok: true };
  }
}
