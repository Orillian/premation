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
  sameFrameKeys,
  formatAdvice,
  formatRepairs,
} from '@motion/author';
import type { AiTransaction } from '../aiTransaction';
import { beatNameOfRoot, FRONT_GLOBALS_ROOT_NAME } from '../structureAdvisors';
import { SFX_ITEMS, getSfxItem } from '@core/library/sfxLibrary';
import {
  applyLook,
  applyTechnique,
  castPiece,
  designGuide,
  listLooks,
  listTechniques,
  reviewDesign,
  type SessionLook,
} from './designTools';

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

/** Something only the user may allow (a file in, a render out). */
export interface ApprovalRequest {
  kind: 'import' | 'export';
  /** One line: "Import 3 files", "Render Main Comp to MP4". */
  title: string;
  /** What exactly: the paths, the format. */
  detail: string[];
}

/**
 * Project-level editor operations an MCP client needs beyond the tool
 * registry. Injected (src/hooks/mcpEditorOps.ts) because they live in the
 * editor's layout code, which src/core may not import.
 */
export interface McpEditorOps {
  listCompositions(): Promise<unknown>;
  /** The new composition's id, or a sentence saying why not. */
  createComposition(o: { name: string; width: number; height: number; fps: number; durationSeconds: number; background: string }): Promise<{ id: string } | { error: string }>;
  setActiveComposition(compId: string): Promise<{ ok: true; name: string } | { error: string }>;
  save(): Promise<{ ok: true; message: string } | { error: string }>;
  importMedia(paths: readonly string[], placeOnTimeline: boolean): Promise<{ ok: true; message: string } | { error: string }>;
  /** A built-in sound effect as an audio layer starting at `atSec`; its layer id. */
  addSfx(id: string, atSec: number, levelDb: number | null): Promise<{ id: string } | { error: string }>;
  setAudioLevels(nodeId: string, o: { levelDb?: number; fadeInSec?: number; fadeOutSec?: number }): Promise<{ ok: true; message: string } | { error: string }>;
  duck(musicId: string, voiceId: string, duckDb: number): Promise<{ ok: true; message: string } | { error: string }>;
}

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
  editor?: McpEditorOps;
  /** Ask the user in Premation; resolves false on Deny or timeout. Absent = always refused. */
  approve?(request: ApprovalRequest): Promise<boolean>;
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

/**
 * Remove what an earlier build of `script` left in the composition: the beat
 * roots whose beat name the script has again (`compileScript` names each root
 * `Beat N — <name>`, so a beat's identity is its name), the `Front globals`
 * root when the script has front globals, and — only when a beat root
 * matched, i.e. this IS a re-run — the top-level layers that carry a back
 * global's name. Children go with their roots. Returns what was removed.
 */
async function removeScriptLayers(ctx: ToolContext, script: { beats: readonly { name: string }[]; globals: readonly { name: string; stack?: string }[] }): Promise<string[]> {
  const all = await ctx.scene.all();
  const top = all.filter((n) => n.parent === null);
  const beatNames = new Set(script.beats.map((b) => b.name));
  const roots = top.filter((n) => {
    const beat = beatNameOfRoot(n.name);
    return beat !== null && beatNames.has(beat);
  });
  const victims = [...roots];
  if (script.globals.some((g) => g.stack === 'front')) victims.push(...top.filter((n) => n.name === FRONT_GLOBALS_ROOT_NAME));
  if (roots.length > 0) {
    const backNames = new Set(script.globals.filter((g) => g.stack !== 'front').map((g) => g.name));
    victims.push(...top.filter((n) => backNames.has(n.name) && !victims.includes(n)));
  }
  const removed: string[] = [];
  for (const v of victims) {
    if (!(await ctx.scene.has(v.id))) continue;
    await ctx.scene.remove(v.id);
    removed.push(v.name);
  }
  return removed;
}

export class McpCallHost {
  private queue: Promise<unknown> = Promise.resolve();
  private group: Group | null = null;
  private abort = new AbortController();
  /** Per-client alias maps (handles a client invented → real ids), kept across calls. */
  private readonly aliases = new Map<number, Map<string, string>>();
  private activity: McpActivity = { busy: false, tool: null, group: null };
  /** The look apply_look chose; casts and techniques use it. */
  private look: SessionLook | null = null;
  /**
   * Per client: the layers its last cast_piece created. A second cast_piece
   * REPLACES them (docs/PROGRAM_3D_PERF_UX.md M1) unless `append: true` —
   * the owner's comp held a whole script twice because every re-run stacked.
   */
  private readonly casts = new Map<number, string[]>();
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
    for (const id of [...this.casts.keys()]) if (!ids.includes(id)) this.casts.delete(id);
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
        case 'list_compositions': return await this.editorOp(async (ed) => text(JSON.stringify(await ed.listCompositions(), null, 1)));
        case 'create_composition': return await this.createComposition(call);
        case 'set_active_composition': return await this.setActiveComposition(call);
        case 'save_project': return await this.editorOp(async (ed) => {
          const r = await ed.save();
          return 'error' in r ? text(r.error, true) : text(r.message);
        });
        case 'import_media': return await this.importMedia(call);
        case 'export_video': return await this.exportVideo(call);
        case 'generate_speech': return await this.generateSpeech(call);
        case 'get_design_guide': return text(designGuide(typeof obj(call.args).topic === 'string' ? String(obj(call.args).topic) : undefined));
        case 'list_looks': return text(listLooks());
        case 'apply_look': {
          const r = applyLook(call.args);
          if ('error' in r) return text(r.error, true);
          this.look = r.look;
          return text(r.summary);
        }
        case 'list_techniques': return text(listTechniques(call.args, this.look));
        case 'apply_technique': return await this.inTransaction(call, 'Claude: apply technique', async (ctx) => {
          const r = await applyTechnique(call.args, this.look, this.deps.registry(), ctx);
          return { result: text(r.text, !r.ok), ok: r.ok };
        });
        case 'cast_piece': {
          const menusOnly = obj(call.args).menusOnly === true;
          if (menusOnly) {
            const ctx = this.deps.context(null, this.abort.signal, this.aliasesFor(call.clientId));
            const r = await castPiece(call.args, this.look, { execute: async () => ({ ok: false, content: 'menus only' }) }, ctx);
            return text(r.text, !r.ok);
          }
          return await this.inTransaction(call, 'Claude: cast piece', async (ctx) => {
            const append = obj(call.args).append === true;
            const previous = this.casts.get(call.clientId) ?? [];
            let replaced = 0;
            if (!append) {
              // Inside this call's transaction: the removal and the new piece
              // are one undo entry, and a failed cast rolls the removal back.
              for (const id of previous) {
                if (!(await ctx.scene.has(id))) continue;
                await ctx.scene.remove(id);
                replaced++;
              }
            }
            const r = await castPiece(call.args, this.look, this.deps.registry(), ctx);
            if (r.ok) this.casts.set(call.clientId, append ? [...previous, ...r.created] : r.created);
            const note = replaced > 0
              ? `\nReplaced the piece cast earlier in this session (${replaced} layer(s) removed). Pass append: true to keep an earlier cast and add to it.`
              : '';
            return { result: text(r.text + note, !r.ok), ok: r.ok };
          });
        }
        case 'review_design': {
          const ctx = this.deps.context(this.group?.tx.session ?? null, this.abort.signal, this.aliasesFor(call.clientId));
          const r = await reviewDesign(ctx);
          return { content: [...r.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })), { type: 'text', text: r.text }] };
        }
        case 'list_sfx': return text(SFX_ITEMS.map((x) => `${x.id} — ${x.name} (${x.cat}, ${x.duration.toFixed(2)}s)`).join('\n'));
        case 'add_sfx': return await this.addSfx(call);
        case 'set_audio_levels': return await this.editorOp(async (ed) => {
          const a = obj(call.args);
          const nodeId = String(a.nodeId ?? '');
          const r = await ed.setAudioLevels(nodeId, {
            ...(typeof a.levelDb === 'number' ? { levelDb: Math.max(-96, Math.min(12, a.levelDb)) } : {}),
            ...(typeof a.fadeInSec === 'number' && a.fadeInSec > 0 ? { fadeInSec: Math.min(30, a.fadeInSec) } : {}),
            ...(typeof a.fadeOutSec === 'number' && a.fadeOutSec > 0 ? { fadeOutSec: Math.min(30, a.fadeOutSec) } : {}),
          });
          return 'error' in r ? text(r.error, true) : text(r.message);
        });
        case 'duck_audio': return await this.editorOp(async (ed) => {
          const a = obj(call.args);
          const r = await ed.duck(String(a.musicId ?? ''), String(a.voiceId ?? ''), Math.max(-40, Math.min(0, num(a.duckDb, -12))));
          return 'error' in r ? text(r.error, true) : text(r.message);
        });
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

  // ── Project-level operations ─────────────────────────────────────────

  private async editorOp(fn: (ed: McpEditorOps) => Promise<McpResult>): Promise<McpResult> {
    const ed = this.deps.editor;
    if (!ed) return text('This Premation build cannot do that from Claude.', true);
    return fn(ed);
  }

  private createComposition(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const name = String(a.name ?? '').trim().slice(0, 120) || 'Composition';
    return this.editorOp(async (ed) => {
      const r = await ed.createComposition({
        name,
        width: Math.round(Math.max(16, Math.min(8192, num(a.width, 1920)))),
        height: Math.round(Math.max(16, Math.min(8192, num(a.height, 1080)))),
        fps: Math.max(1, Math.min(120, num(a.fps, 30))),
        durationSeconds: Math.max(0.1, Math.min(3600, num(a.durationSeconds, 10))),
        background: typeof a.background === 'string' && /^#[0-9a-f]{6}$/i.test(a.background) ? a.background : '#101014',
      });
      return 'error' in r ? text(r.error, true) : text(`Created composition "${name}" (id ${r.id}); it is now the active composition.`);
    });
  }

  private setActiveComposition(call: McpCall): Promise<McpResult> {
    const compId = String(obj(call.args).compId ?? '');
    return this.editorOp(async (ed) => {
      const r = await ed.setActiveComposition(compId);
      return 'error' in r ? text(r.error, true) : text(`"${r.name}" is now the active composition.`);
    });
  }

  /** Ask the user; a refusal is final for this request and says so. */
  private async approved(req: ApprovalRequest): Promise<boolean> {
    return this.deps.approve ? this.deps.approve(req) : false;
  }

  private async importMedia(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const paths = (Array.isArray(a.paths) ? a.paths : []).filter((p): p is string => typeof p === 'string' && p.trim() !== '').slice(0, 20);
    if (paths.length === 0) return text('import_media needs `paths`: absolute file paths.', true);
    const ok = await this.approved({ kind: 'import', title: `Import ${paths.length} file${paths.length === 1 ? '' : 's'} into this project`, detail: paths });
    if (!ok) return text('The user did not allow this import. Do not retry it unless they ask; work with the media already in the project (list_assets).', true);
    return this.editorOp(async (ed) => {
      const r = await ed.importMedia(paths, a.placeOnTimeline !== false);
      return 'error' in r ? text(r.error, true) : text(r.message);
    });
  }

  private async exportVideo(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const format = typeof a.format === 'string' ? a.format : 'mp4';
    const ok = await this.approved({ kind: 'export', title: `Render the active composition to ${format.toUpperCase()}`, detail: [`Format: ${format}`, a.mode === 'immediate' ? 'Starts now' : 'Added to the Render Queue'] });
    if (!ok) return text('The user did not allow this render. Do not retry it unless they ask.', true);
    return this.registryCall(call);
  }

  private async addSfx(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const id = String(a.id ?? '');
    const item = getSfxItem(id);
    if (!item) return text(`Unknown sound effect '${id}'. See list_sfx.`, true);
    return this.editorOp(async (ed) => {
      const r = await ed.addSfx(id, Math.max(0, num(a.atSec, 0)), typeof a.levelDb === 'number' ? Math.max(-48, Math.min(12, a.levelDb)) : null);
      return 'error' in r ? text(r.error, true) : text(`Added "${item.name}" at ${num(a.atSec, 0)}s as audio layer ${r.id} (${item.duration.toFixed(2)}s).`);
    });
  }

  private async generateSpeech(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const words = typeof a.text === 'string' ? a.text : '';
    const ok = await this.approved({
      kind: 'export',
      title: 'Generate a voice-over (uses generation credit)',
      detail: [words.length > 160 ? `${words.slice(0, 157)}…` : words || '(no text)'],
    });
    if (!ok) return text('The user did not allow generating a voice-over. Do not retry it unless they ask.', true);
    return this.registryCall(call);
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
      '',
      'A beat may also carry `precompose`: [{ id, name, layers: [layer ids of that beat sharing a parent], props?: { x, y, scale, rotation, opacity }, keys?: { prop: [[t, v], …] } }] — the layers become ONE composition layer that moves, fades and takes effects as a unit (a camera rig, a crowd). Its keys are beat seconds.',
      'Key times snap to frames: two keys of one property closer than a frame (1/fps s) merge and only the later one survives — author_scene reports any it finds.',
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
    // A beat that is already in the composition is REPLACED, not built again
    // next to itself (M1): the owner's comp carried every beat twice with
    // identical clip times — two cameras per beat, three adjustment layers at
    // once — because each author_scene re-run appended. Same transaction, so
    // the removal undoes with the rebuild.
    const replaced = obj(call.args).append === true ? [] : await removeScriptLayers(ctx, coerced.value);
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
    if (replaced.length) lines.push('', `Replaced ${replaced.length} layer group(s) the composition already had from an earlier build: ${replaced.join(', ')}. Pass append: true to keep an earlier build next to this one.`);
    if (coerced.repairs.length) lines.push('', 'Repaired in the script:', formatRepairs(coerced.repairs));
    const collisions = sameFrameKeys(compiled, comp.fps);
    if (collisions.length) lines.push('', 'Keys merged by frame snapping:', ...collisions.slice(0, 20).map((c) => `- ${c}`));
    if (rejected.length) lines.push('', 'Rejected by the engine:', ...rejected.slice(0, 20));
    if (advice.findings.length) lines.push('', 'Design advisors:', formatAdvice(advice.findings));
    lines.push('', 'Look at it with render_filmstrip, then refine with the individual tools.');
    return { result: text(lines.join('\n')), ok: true };
  }
}
