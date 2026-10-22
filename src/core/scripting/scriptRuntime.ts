/**
 * The script runtime, WORKER side (imported only by `scriptWorker.ts` and by
 * the in-process test worker). It never runs in the editor's realm: the host
 * hands a script's source to a Worker as data (see scriptHost.ts and the
 * no-host-realm-eval guard in core/plugins).
 *
 * A script is the body of an async function. It sees two APIs:
 *
 *   `premation` — the engine API itself (ENGINE_API.md §12: scripts use
 *   exactly the API the UI, AI tools and plugins use), asynchronous:
 *
 *     // @permissions document.read, document.write
 *     const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
 *     const { layer } = await premation.execute({ type: 'createLayer', comp: doc.comps[0].id, kind: 'null', name: 'Rig', init: [] });
 *     return layer;          // the run's result
 *
 *   `app` — After Effects' object model (aeObjectModel.ts), SYNCHRONOUS, so
 *   ExtendScript runs unchanged:
 *
 *     var comp = app.project.activeItem;
 *     comp.layers.addSolid([1, 0, 0], 'Red', 1920, 1080, 1).property('Position').setValue([100, 100]);
 *
 * HOW `app` IS SYNCHRONOUS. A worker cannot block on the host without
 * SharedArrayBuffer + Atomics.wait, and the editor's page is not
 * cross-origin isolated (COOP/COEP would cut it off its own cross-origin
 * media and fonts). So the runtime REPLAYS instead: every engine call the
 * script makes gets the next slot of the run's TAPE. A call whose slot is
 * filled returns the recorded answer at once; a READ with no answer yet
 * SUSPENDS the pass (a sentinel is thrown, and every later call throws it
 * too), the runtime asks the engine, records the answer and runs the script
 * again from the top. Writes whose result nobody reads are QUEUED and sent in
 * order before the next read (or at the end of the pass); a refused one is
 * recorded as an error, and the next pass throws it at its own line. Each
 * engine call is therefore sent exactly once, in program order — the run is
 * still the one undo entry the host opened. A pass is deterministic: the
 * script sees a seeded `Math.random` and a frozen `Date.now()`.
 *
 * `execute`/`batch`/`query` THROW on a typed engine refusal (an uncaught one
 * fails the run, and a failed run leaves the document unchanged).
 */

import type { ScriptHostMessage, ScriptWorkerMessage, ScriptCallMethod, ScriptPermission, ScriptRunContext } from './protocol';
import { AE_GLOBAL_NAMES, createAeGlobals, TextDocument, type AeBridge } from './aeObjectModel';

export interface ScriptPort {
  post(msg: ScriptWorkerMessage): void;
  /** Install the handler for host messages. */
  listen(handler: (msg: ScriptHostMessage) => void): void;
}

export class ScriptEngineError extends Error {
  readonly code: string;
  readonly commandIndex: number | undefined;
  constructor(code: string, message: string, commandIndex?: number) {
    super(`${code}: ${message}`);
    this.name = 'ScriptEngineError';
    this.code = code;
    this.commandIndex = commandIndex;
  }
}

const show = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v instanceof TextDocument) return v.text;
  try { return JSON.stringify(v); } catch { return String(v); }
};

/** Thrown through the script when a pass must stop and wait for the engine. Not an Error: no stack to build. */
class Suspend {
  readonly premationSuspend = true;
}
const SUSPEND = new Suspend();

/** A run that needs more passes than this is not converging (or reads in a loop that never ends). */
const MAX_PASSES = 50_000;

type TapeEntry =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string; commandIndex?: number };

type Pending =
  | { index: number; kind: 'call'; method: ScriptCallMethod; args: unknown[] }
  | { index: number; kind: 'log'; level: 'log' | 'warn' | 'error'; text: string };

/** ExtendScript preprocessor lines (`#target aftereffects`, `#include`) become comments: line numbers stay. */
export function stripDirectives(source: string): string {
  return source.replace(/^([ \t]*)#(target|targetengine|include|includepath|script|strict|engine)\b/gm, '$1//#$2');
}

/** The function the script body becomes (sloppy mode, as ExtendScript; the body may `await`). */
const wrap = (body: string): string => `return (async () => {\n${body}\n}).call(this);`;
const PARAMS = ['premation', 'Math', 'Date', ...AE_GLOBAL_NAMES];

/** How many lines `new Function` puts before the body's first line (measured, not assumed). */
const LINE_OFFSET = ((): number => {
  try {
    (new Function(...PARAMS, 'return (() => {\nthrow new Error("probe")\n})();') as () => void)();
  } catch (err) {
    const line = stackLine(err);
    if (line !== null) return line - 1;
  }
  return 0;
})();

function stackLine(err: unknown): number | null {
  const stack = err && typeof err === 'object' && 'stack' in err ? String((err as { stack: unknown }).stack) : '';
  const m = /<anonymous>:(\d+):\d+/.exec(stack);
  return m ? Number(m[1]) : null;
}

/** mulberry32: the pass's `Math.random`, reseeded every pass so replays agree. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A `Date` whose "now" is the run's start: a replayed pass sees the same clock. */
function frozenDate(now: number): DateConstructor {
  const Real = Date;
  class RunDate extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now);
      else super(...(args as [string]));
    }
    static override now(): number { return now; }
  }
  return RunDate as unknown as DateConstructor;
}

/** Wire the port; the first `run` message evaluates the script. */
export function startScriptRuntime(port: ScriptPort): void {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventListeners = new Set<(batch: unknown) => void>();
  let subscribed = false;
  let started = false;

  const call = (method: ScriptCallMethod, args: unknown[]): Promise<unknown> => {
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.post({ k: 'call', id, method, args });
    });
  };

  // ---- the tape and the current pass ----
  const tape: TapeEntry[] = [];
  let cursor = 0;
  let suspended: Pending | 'replay' | null = null;
  let queue: Pending[] = [];
  /** Read through a function: the closures above set it while a pass runs (no narrowing). */
  const pendingNeed = (): Pending | 'replay' | null => suspended;

  const fromTape = (e: TapeEntry): unknown => {
    if (e.ok) return e.value;
    throw new ScriptEngineError(e.code, e.message, e.commandIndex);
  };
  const toTape = (err: unknown): TapeEntry => {
    if (err instanceof ScriptEngineError) return { ok: false, code: err.code, message: err.message.replace(`${err.code}: `, ''), ...(err.commandIndex !== undefined ? { commandIndex: err.commandIndex } : {}) };
    return { ok: false, code: 'internal', message: err instanceof Error ? err.message : String(err) };
  };
  const outOfOrder = (): Error =>
    new Error('premation calls overlapped app calls: await each premation call before the next engine call.');

  /** Send the queued writes and logs, in order. False when a write was refused (the pass must replay). */
  const flushQueue = async (): Promise<boolean> => {
    const q = queue;
    queue = [];
    for (const p of q) {
      if (p.index !== tape.length) throw outOfOrder();
      if (p.kind === 'log') {
        port.post({ k: 'log', level: p.level, text: p.text });
        tape.push({ ok: true, value: null });
        continue;
      }
      try {
        tape.push({ ok: true, value: await call(p.method, p.args) });
      } catch (err) {
        tape.push(toTape(err));
        return false;
      }
    }
    return true;
  };

  /** A call whose answer the script needs now. */
  const syncNeed = (method: ScriptCallMethod, args: unknown[]): unknown => {
    if (suspended) throw SUSPEND;
    const i = cursor++;
    if (i < tape.length) return fromTape(tape[i]!);
    suspended = { index: i, kind: 'call', method, args };
    throw SUSPEND;
  };
  /** A write whose answer nobody reads: queued. */
  const syncFire = (method: ScriptCallMethod, args: unknown[]): void => {
    if (suspended) throw SUSPEND;
    const i = cursor++;
    if (i < tape.length) { fromTape(tape[i]!); return; }
    queue.push({ index: i, kind: 'call', method, args });
  };
  const log = (level: 'log' | 'warn' | 'error', text: string): void => {
    if (suspended) throw SUSPEND;
    const i = cursor++;
    if (i < tape.length) return;
    if (queue.length === 0 && i === tape.length) {
      port.post({ k: 'log', level, text });
      tape.push({ ok: true, value: null });
      return;
    }
    queue.push({ index: i, kind: 'log', level, text });
  };
  /** The async `premation` API on the same tape (a replayed pass answers from it). */
  const asyncCall = (method: ScriptCallMethod, args: unknown[]): Promise<unknown> => {
    if (suspended) return Promise.reject(SUSPEND);
    const i = cursor++;
    if (i < tape.length) {
      try { return Promise.resolve(fromTape(tape[i]!)); } catch (err) { return Promise.reject(err as Error); }
    }
    return (async () => {
      if (!(await flushQueue())) {
        suspended = 'replay';
        throw SUSPEND;
      }
      if (i !== tape.length) throw outOfOrder();
      try {
        const value = await call(method, args);
        tape.push({ ok: true, value });
        return value;
      } catch (err) {
        tape.push(toTape(err));
        throw err;
      }
    })();
  };

  const run = async (name: string, source: string, permissions: ScriptPermission[], context: ScriptRunContext): Promise<void> => {
    const premation = Object.freeze({
      /** One edit command, inside the run's undo entry. Resolves to its result. */
      execute: (command: unknown) => asyncCall('execute', [command]),
      /** Several edit commands, all-or-nothing (still inside the run's one undo entry). */
      batch: (label: string, commands: unknown[]) => asyncCall('batch', [label, commands]),
      /** Any query (`getDocument`, `getLayers`, `getPropertyValues`, `getKeyframes`, …). */
      query: (query: unknown) => asyncCall('query', [query]),
      /** Change events while the script runs (`document.read`). Returns an unsubscribe. */
      onEvents: (fn: (batch: unknown) => void) => {
        eventListeners.add(fn);
        if (!subscribed) {
          subscribed = true;
          void call('subscribe', []);
        }
        return () => eventListeners.delete(fn);
      },
      log: (...xs: unknown[]) => log('log', xs.map(show).join(' ')),
      permissions: Object.freeze([...permissions]),
      /** Seconds → API time (flicks). */
      seconds: (s: number) => Math.round(s * 705_600_000),
    });
    const bridge: AeBridge = {
      query: <T>(q: Record<string, unknown>) => syncNeed('query', [q]) as T,
      execute: <T>(cmd: Record<string, unknown>) => {
        const r = syncNeed('execute', [cmd]);
        return r as T;
      },
      fire: (cmd) => syncFire('execute', [cmd]),
      log: (text) => log('log', text),
      activeItem: context.activeItem ?? null,
      time: context.time ?? 0,
    };
    const ae = createAeGlobals(bridge);
    const seed = (Math.random() * 2 ** 32) >>> 0;
    const startedAt = Date.now();

    let body: (...args: unknown[]) => Promise<unknown>;
    try {
      // The script is the body of an async function. `new Function` here runs
      // in the WORKER realm (this module is never imported by the editor).
      body = new Function(...PARAMS, wrap(stripDirectives(source))) as typeof body;
    } catch (err) {
      port.post({ k: 'done', ok: false, error: `${name}: ${err instanceof Error ? `${err.name}: ${err.message}` : show(err)}` });
      return;
    }

    for (let pass = 0; ; pass++) {
      if (pass >= MAX_PASSES) {
        port.post({ k: 'done', ok: false, error: `The script made more than ${MAX_PASSES} engine reads; it was stopped.` });
        return;
      }
      cursor = 0;
      suspended = null;
      queue = [];
      eventListeners.clear();
      const passMath = Object.create(Math) as Math;
      Object.defineProperty(passMath, 'random', { value: seededRandom(seed) });
      let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await body(premation, passMath, frozenDate(startedAt), ...AE_GLOBAL_NAMES.map((n) => ae[n])) };
      } catch (err) {
        outcome = { ok: false, error: err };
      }
      let replay = false;
      try {
        if (!(await flushQueue())) replay = true;
        else if (pendingNeed() === 'replay') replay = true;
        else if (pendingNeed()) {
          const need = pendingNeed() as Pending;
          if (need.index !== tape.length || need.kind !== 'call') throw outOfOrder();
          try {
            tape.push({ ok: true, value: await call(need.method, need.args) });
          } catch (err) {
            tape.push(toTape(err));
          }
          replay = true;
        }
      } catch (err) {
        outcome = { ok: false, error: err };
        replay = false;
      }
      if (replay) continue;

      if (outcome.ok) {
        let clean: unknown = null;
        const value = outcome.value instanceof TextDocument ? outcome.value.text : outcome.value;
        try { clean = value === undefined ? null : JSON.parse(JSON.stringify(value)); } catch { clean = show(value); }
        port.post({ k: 'done', ok: true, value: clean });
      } else {
        const err = outcome.error;
        const line = stackLine(err);
        port.post({
          k: 'done',
          ok: false,
          error: err instanceof Error ? err.message : show(err),
          ...(line !== null && line - LINE_OFFSET >= 1 ? { line: line - LINE_OFFSET } : {}),
        });
      }
      return;
    }
  };

  port.listen((msg) => {
    switch (msg.k) {
      case 'run':
        if (started) return;
        started = true;
        void run(msg.name, msg.source, msg.permissions, msg.context ?? {});
        return;
      case 'reply': {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new ScriptEngineError(msg.error.code, msg.error.message, msg.error.commandIndex));
        return;
      }
      case 'events':
        for (const l of [...eventListeners]) {
          try { l(msg.batch); } catch { /* a listener's failure is the script's own */ }
        }
        return;
    }
  });
}
