/**
 * Claude's front desk: the part of Premation an MCP client reaches on EVERY
 * page — the home screen as much as the editor (docs/MCP_PLAN.md §13).
 *
 *   • It answers the project-level tools itself (`get_app_state`,
 *     `list_projects`, `create_project`, `open_project`), so Claude can start
 *     from nothing: "make me a promo" with no project open creates one.
 *   • Everything else needs an open project; it goes to the editor's
 *     `McpCallHost` once the editor has registered one, and otherwise gets a
 *     sentence that tells Claude what to call first.
 *   • It keeps what the indicators show: the activity (busy, which tool, the
 *     open group) and a feed of the last calls with their outcome.
 *
 * No React, no zustand: `src/hooks/useMcpFrontDesk.ts` creates the single
 * instance at the app root and supplies the navigation and project-library
 * operations, which live outside src/core.
 */

import { MCP_FRONT_DESK_TOOL_NAMES } from '@motion/ai-tools';
import type { AccessDecision, McpActivity, McpCall, McpCallHost, McpResult } from './mcpHost';

/** How long create/open waits for the editor to load the project. */
export const EDITOR_WAIT_MS = 30_000;
/** Entries the feed keeps. */
export const FEED_LIMIT = 60;

export interface FeedEntry {
  id: number;
  at: number;
  tool: string;
  ok: boolean;
  /** One line for people: the first line of the tool's answer. */
  summary: string;
  ms: number;
}

export interface FrontDeskState extends McpActivity {
  feed: readonly FeedEntry[];
}

export type DeskResult<T> = T | { error: string };

export interface ProjectSettingsRequest {
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  background: string;
}

export interface FrontDeskDeps {
  /** Where the user is; JSON for Claude. */
  appState(): Promise<Record<string, unknown>>;
  listProjects(o: { query?: string; limit: number }): Promise<DeskResult<unknown[]>>;
  /** Create the project and start opening it; the desk then waits for the editor. */
  createProject(o: ProjectSettingsRequest): Promise<DeskResult<{ name: string; expect?: string }>>;
  openProject(id: string): Promise<DeskResult<{ name: string; expect?: string }>>;
  /**
   * A project is loaded in the editor — `expect`, when given, is the id/path
   * of the one being opened, so a project still open from before does not
   * count as the new one.
   */
  projectLoaded(expect?: string): boolean;
  access(): Promise<AccessDecision>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const text = (t: string, isError = false): McpResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function obj(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/** The feed's one line for a result. */
export function summarise(tool: string, r: McpResult): string {
  const line = r.content.find((c) => c.type === 'text');
  const first = line && line.type === 'text' ? (line.text.split('\n')[0] ?? '').trim() : '';
  if (r.content.some((c) => c.type === 'image')) return first || (tool === 'render_filmstrip' ? 'Rendered a filmstrip' : 'Rendered a frame');
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}

export const NO_PROJECT =
  'No project is open in Premation. Call get_app_state, then create_project (a new one) or open_project (one from list_projects) first.';

export class McpFrontDesk {
  private editor: McpCallHost | null = null;
  private offEditor: (() => void) | null = null;
  private activity: McpActivity = { busy: false, tool: null, group: null };
  private feed: FeedEntry[] = [];
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(s: FrontDeskState) => void>();

  constructor(private readonly deps: FrontDeskDeps) {}

  // ── The editor ───────────────────────────────────────────────────────

  /** The editor page mounted its host; it serves every project tool from now on. */
  registerEditor(host: McpCallHost): () => void {
    this.offEditor?.();
    this.editor = host;
    this.offEditor = host.subscribe((a) => this.set({ group: a.group }));
    return () => {
      if (this.editor !== host) return;
      this.offEditor?.();
      this.offEditor = null;
      this.editor = null;
      this.set({ group: null });
    };
  }

  hasEditor(): boolean {
    return this.editor !== null;
  }

  private editorReady(expect?: string): boolean {
    return this.editor !== null && this.deps.projectLoaded(expect);
  }

  /** Wait for the editor to have a project loaded (`expect`: that one); false after `ms`. */
  async waitForEditor(ms = EDITOR_WAIT_MS, expect?: string): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
    const now = this.deps.now ?? (() => Date.now());
    const until = now() + ms;
    while (!this.editorReady(expect)) {
      if (now() > until) return false;
      await sleep(150);
    }
    return true;
  }

  // ── State for the indicators ─────────────────────────────────────────

  subscribe(fn: (s: FrontDeskState) => void): () => void {
    this.listeners.add(fn);
    fn(this.getState());
    return () => this.listeners.delete(fn);
  }

  getState(): FrontDeskState {
    return { ...this.activity, feed: this.feed };
  }

  private set(patch: Partial<McpActivity>): void {
    this.activity = { ...this.activity, ...patch };
    const s = this.getState();
    for (const fn of this.listeners) fn(s);
  }

  private record(tool: string, r: McpResult, ms: number): void {
    const entry: FeedEntry = { id: this.nextId++, at: (this.deps.now ?? Date.now)(), tool, ok: r.isError !== true, summary: summarise(tool, r), ms };
    this.feed = [entry, ...this.feed].slice(0, FEED_LIMIT);
    this.set({});
  }

  // ── Calls ────────────────────────────────────────────────────────────

  /**
   * Every call from the pipe comes here, one at a time — except the desk's
   * own read-only questions. A create_project can sit for minutes behind
   * Premation's "save your changes?" dialog; "where is the user?" must still
   * get an answer meanwhile (it is how Claude learns it is waiting on them).
   */
  handle(call: McpCall): Promise<McpResult> {
    if (call.name === 'get_app_state' || call.name === 'list_projects') return this.run(call);
    const run = this.queue.then(() => this.run(call));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(call: McpCall): Promise<McpResult> {
    const started = (this.deps.now ?? Date.now)();
    this.set({ busy: true, tool: call.name });
    let r: McpResult;
    try {
      r = await this.dispatch(call);
    } catch (err) {
      r = text(`${call.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.set({ busy: false, tool: null });
    }
    this.record(call.name, r, (this.deps.now ?? Date.now)() - started);
    return r;
  }

  private async dispatch(call: McpCall): Promise<McpResult> {
    if (MCP_FRONT_DESK_TOOL_NAMES.has(call.name)) {
      const access = await this.deps.access();
      if (!access.ok) return text(access.message, true);
      return this.frontDesk(call);
    }
    if (!this.editor || !this.deps.projectLoaded()) return text(NO_PROJECT, true);
    return this.editor.handle(call);
  }

  private async frontDesk(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    switch (call.name) {
      case 'get_app_state':
        return text(JSON.stringify(await this.deps.appState(), null, 1));
      case 'list_projects': {
        const r = await this.deps.listProjects({
          ...(typeof a.query === 'string' && a.query.trim() ? { query: a.query.trim() } : {}),
          limit: Math.round(num(a.limit, 20, 1, 50)),
        });
        if ('error' in r) return text(r.error, true);
        return text(r.length ? JSON.stringify(r, null, 1) : 'No projects yet. Use create_project.');
      }
      case 'create_project': {
        const req: ProjectSettingsRequest = {
          name: (typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'Untitled project').slice(0, 120),
          width: Math.round(num(a.width, 1920, 16, 8192)),
          height: Math.round(num(a.height, 1080, 16, 8192)),
          fps: num(a.fps, 30, 1, 120),
          durationSeconds: num(a.durationSeconds, 10, 0.5, 3600),
          background: typeof a.background === 'string' && /^#[0-9a-f]{6}$/i.test(a.background) ? a.background : '#101014',
        };
        const r = await this.deps.createProject(req);
        if ('error' in r) return text(r.error, true);
        if (!(await this.waitForEditor(EDITOR_WAIT_MS, r.expect))) return text(`Premation started creating "${r.name}" but the editor did not finish opening it. Call get_app_state to check.`, true);
        return text(`Created and opened "${r.name}": ${req.width}×${req.height}, ${req.fps} fps, ${req.durationSeconds}s. Build in it now (describe_scene shows it is empty).`);
      }
      case 'open_project': {
        const id = typeof a.id === 'string' ? a.id.trim() : '';
        if (!id) return text('open_project needs the `id` list_projects gave.', true);
        const r = await this.deps.openProject(id);
        if ('error' in r) return text(r.error, true);
        if (!(await this.waitForEditor(EDITOR_WAIT_MS, r.expect))) return text(`Premation started opening "${r.name}" but the editor did not finish loading it. Call get_app_state to check.`, true);
        return text(`Opened "${r.name}". Call describe_scene or list_compositions to see what is in it.`);
      }
      default:
        return text(`Unknown front-desk tool ${call.name}.`, true);
    }
  }

  // ── Pass-throughs the hooks use ──────────────────────────────────────

  clientsChanged(ids: readonly number[]): void {
    void this.editor?.clientsChanged(ids);
  }

  stop(): Promise<void> {
    return this.editor ? this.editor.stop() : Promise.resolve();
  }
}

// ── The one instance (created by src/hooks/useMcpFrontDesk.ts) ──────────

let instance: McpFrontDesk | null = null;

export function setMcpFrontDesk(desk: McpFrontDesk | null): void {
  instance = desk;
}

export function mcpFrontDesk(): McpFrontDesk | null {
  return instance;
}

// ── The editor's project operations (local edition) ─────────────────────
//
// In the local edition a project is created or opened by the editor's own
// command system, which only exists while the editor is mounted. The editor
// registers these (src/hooks/useMcpHost.ts); the front desk's deps call them
// after navigating to the editor.

export interface EditorProjectOps {
  /** New project with this composition; resolves with the new project's id. */
  newProject(o: ProjectSettingsRequest): Promise<DeskResult<{ id: string }>>;
  /** Open a project file by path; resolves with its id. */
  openPath(path: string): Promise<DeskResult<{ id: string; name: string }>>;
}

let editorOps: EditorProjectOps | null = null;

export function setEditorProjectOps(ops: EditorProjectOps | null): void {
  editorOps = ops;
}

export function editorProjectOps(): EditorProjectOps | null {
  return editorOps;
}
