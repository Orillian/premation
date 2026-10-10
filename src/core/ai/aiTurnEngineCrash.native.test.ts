/**
 * An AI turn whose engine died under it must not hold the engine's one
 * gesture slot forever.
 *
 * The bug (Claude for Premation, an `author_scene` that killed the engine):
 * the turn's `endGesture` went out on the dead pipe and failed, then the
 * restarted engine was given the command log back — `beginGesture` included —
 * so the turn's gesture was open again with nobody left to close it. Every
 * later turn (and every drag) answered `gestureOpen` until the app restarted.
 *
 * Both recoveries are covered: the host's (F2, main replays its log — the app)
 * and the client's own (a bridge without a host log). A user's drag that was
 * still open when the engine died is NOT closed for them: a turn still waits
 * for it.
 */

import { ProcessEngineClient, unwrap, type EngineBridge, type EngineClient, type EngineRestartNotice, type ProcessEngineNotice } from '@motion/engine-api';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { EngineCommandLog } from '../../../electron/engineCommandLog';
import { beginAiTransaction } from './aiTransaction';

const describeNative = nativeEngineExe() ? describe : describe.skip;

const waitFor = async (pred: () => boolean, ms = 15_000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise<void>((r) => setTimeout(r, 20));
  }
};

/**
 * The app's bridge shape (F2): main records every applied request and replays
 * the log into a restarted engine BEFORE telling the page (`replayedByHost`),
 * as electron/engineHost.ts `recoverRestarted` does.
 */
function hostLoggedBridge(native: NativeEngine): EngineBridge {
  const inner = native.bridge;
  const log = new EngineCommandLog();
  let recovering: Promise<void> | null = null;
  return {
    ...inner,
    status: async () => ({ ...(await inner.status()), hostCommandLog: true }),
    request: async (bytes) => {
      while (recovering) await recovering;
      const res = await inner.request(bytes);
      if (res.ok) log.record(Uint8Array.from(bytes), res.bytes, 0);
      return res;
    },
    onRestarted: (h) => inner.onRestarted((info: EngineRestartNotice) => {
      let done!: () => void;
      recovering = new Promise<void>((r) => { done = r; });
      void (async () => {
        let replayed = 0;
        for (const rec of log.plan()) {
          if ((await inner.request(rec.bytes)).ok) replayed += 1;
        }
        recovering = null;
        done();
        h({ ...info, replayedByHost: true, replayed, mismatches: 0, ms: 0 });
      })();
    }),
  };
}

const modes: Array<[string, (n: NativeEngine) => EngineBridge]> = [
  ['the host replays its log (the app, F2)', hostLoggedBridge],
  ['the client replays its own log', (n) => n.bridge],
];

describeNative.each(modes)('an AI turn the engine died under (%s)', (_mode, bridgeOf) => {
  let native: NativeEngine | null = null;
  let client: ProcessEngineClient | null = null;
  let notices: ProcessEngineNotice[] = [];

  beforeEach(async () => {
    setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
    native = await startNativeEngine();
    notices = [];
    client = new ProcessEngineClient(bridgeOf(native), { onNotice: (n) => notices.push(n) });
    await client.whenReady();
  });

  afterEach(async () => {
    await client?.close();
    await native?.stop();
    native = null;
    client = null;
  });

  async function solid(c: EngineClient): Promise<{ layer: string; opacity: () => Promise<unknown> }> {
    const { item: comp } = unwrap(await c.execute({ type: 'createComposition', settings: { name: 'Crash', width: 640, height: 360 }, fromItems: [] }));
    const { layer } = unwrap(await c.execute({ type: 'createLayer', comp, kind: 'solid', name: 'Lattice', init: [] }));
    const opacity = async (): Promise<unknown> =>
      unwrap(await c.query({ type: 'getPropertyValues', props: [{ layer, path: 'transform/opacity' }], time: 0, evaluated: false })).values[0]!.value;
    return { layer, opacity };
  }

  const gestureOpen = async (c: EngineClient): Promise<boolean> => unwrap(await c.query({ type: 'getHistory' })).gestureOpen;

  it('does not leave its gesture open: the next turn starts, and the dead turn is rolled back', async () => {
    const c = client!;
    const { layer, opacity } = await solid(c);
    const before = await opacity();

    const turn = await beginAiTransaction('AI: lattice', { client: c });
    await turn.session.apply([{ type: 'setProperty', prop: { layer, path: 'transform/opacity' }, value: { kind: 'scalar', value: 25 } }]);
    expect(await opacity()).toEqual({ kind: 'scalar', value: 25 });

    // The engine dies mid-turn; the turn gives up on the dead pipe.
    native!.kill();
    const end = c.endGesture;
    const ends: Array<{ ok: boolean; code?: string }> = [];
    c.endGesture = async (...args) => {
      const r = await end.apply(c, args);
      ends.push(r.ok ? { ok: true } : { ok: false, code: r.error.code });
      return r;
    };
    await turn.rollback();
    c.endGesture = end;
    // The scenario: the turn's own endGesture never reached an engine.
    expect(ends).toEqual([{ ok: false, code: 'busy' }]);

    await waitFor(() => notices.length > 0);
    expect(notices[0]).toMatchObject({ kind: 'restarted', cause: 'crash' });

    // The restarted engine was given `beginGesture` back by the replay; the
    // client closed it for the turn that had already let go.
    expect(await gestureOpen(c)).toBe(false);
    expect(await opacity()).toEqual(before);

    const next = await beginAiTransaction('AI: again', { client: c });
    await next.session.apply([{ type: 'setProperty', prop: { layer, path: 'transform/opacity' }, value: { kind: 'scalar', value: 60 } }]);
    expect(await next.commit()).toEqual({ kind: 'engine', gaps: [] });
    expect(await opacity()).toEqual({ kind: 'scalar', value: 60 });
    expect(unwrap(await c.query({ type: 'getHistory' })).entries.map((e) => e.label)).toContain('AI: again');
  }, 60_000);

  it('a committed turn whose commit hit the dead engine lands as its one entry after the restart', async () => {
    const c = client!;
    const { layer, opacity } = await solid(c);

    const turn = await beginAiTransaction('AI: fade', { client: c });
    await turn.session.apply([{ type: 'setProperty', prop: { layer, path: 'transform/opacity' }, value: { kind: 'scalar', value: 40 } }]);
    native!.kill();
    const outcome = await turn.commit();
    expect(outcome.gaps.join(' ')).toMatch(/engine/);

    await waitFor(() => notices.length > 0);
    expect(await gestureOpen(c)).toBe(false);
    expect(await opacity()).toEqual({ kind: 'scalar', value: 40 });
    expect(unwrap(await c.query({ type: 'getHistory' })).entries.map((e) => e.label)).toContain('AI: fade');
  }, 60_000);

  it("a user's drag still open when the engine died stays theirs: a turn waits for it, the drag finishes", async () => {
    const c = client!;
    const { layer, opacity } = await solid(c);
    const { gesture } = unwrap(await c.execute({ type: 'beginGesture', label: 'Drag' }));
    unwrap(await c.execute({ type: 'setProperty', prop: { layer, path: 'transform/opacity' }, value: { kind: 'scalar', value: 70 } }));

    native!.kill();
    await waitFor(() => notices.length > 0);

    // The drag is replayed open and nothing closes it but its owner.
    expect(await gestureOpen(c)).toBe(true);
    await expect(beginAiTransaction('AI: meanwhile', { client: c })).rejects.toThrow(/still in progress/);

    unwrap(await c.execute({ type: 'endGesture', gesture, commit: true }));
    expect(await gestureOpen(c)).toBe(false);
    expect(await opacity()).toEqual({ kind: 'scalar', value: 70 });
    const turn = await beginAiTransaction('AI: after the drag', { client: c });
    await turn.rollback();
  }, 60_000);
});
