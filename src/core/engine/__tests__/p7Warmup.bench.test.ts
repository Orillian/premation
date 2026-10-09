/**
 * P7 (docs/PROGRAM_PLAYBACK_TEXT_INK.md): effects that first appear mid-play.
 * A layer carrying effect types no earlier frame used starts at 1 s; before
 * the warm-up, its first frame paid every pipeline compile on the spot (a
 * hitch of hundreds of ms in the middle of playback). The comp is built, the
 * engine left idle (the render thread compiles the document's effect
 * pipelines then), and the play is measured: the frame times at the layer's
 * in-point against the rest.
 *
 * Run with the bench jest config (`npm run bench`). Needs the full engine (GPU).
 */

import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { onSharedEngineFrames, openMainViewport, sec, settleEdits, setupAppEngine, type Harness } from '../__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '../__testHelpers__/nativeEngine';

// hrtime / performance / Date real: the bench measures wall time.
jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate', 'hrtime', 'performance', 'Date'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('effects first appearing mid-play', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('reports the frame time at the in-point of a layer with new effect types', async () => {
    if (nativeEngineIsHeadless()) return;
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, duration: sec(3) } } as Command);
    const r = await runToolTurn('bench: p7', [
      { name: 'create_gradient', args: { id: 'bg', name: 'BG', stops: ['#101018', '#302040'], angle: 0 } },
      { name: 'create_layer', args: { id: 'late', kind: 'shape', name: 'Late', x: 960, y: 540, width: 900, height: 500, fill: '#c08040' } },
      { name: 'add_effect', args: { nodeId: 'late', type: 'turbulent-displace' } },
      { name: 'add_effect', args: { nodeId: 'late', type: 'chromatic-aberration' } },
      { name: 'add_effect', args: { nodeId: 'late', type: 'deep-glow' } },
      { name: 'set_layer_timing', args: { items: [{ nodeId: 'late', inSec: 1 }] } },
    ]);
    const failed = r.results.filter((x) => !x.ok).map((x) => x.content);
    if (failed.length) console.log('[p7] tool failures', failed.slice(0, 5));
    await settleEdits();
    await openMainViewport(h.client);
    await sleep(3000);  // idle: the warm-up's time

    const frames: { frame: number; ms: number }[] = [];
    let phase = 'idle';
    const off = onSharedEngineFrames((f) => {
      if (f.type === 'frameReady' && phase === 'playing') frames.push({ frame: f.frame, ms: (f.renderDoneUs - f.renderStartUs) / 1000 });
    });
    const unsub = h.client.subscribe((b) => {
      for (const e of b.events) if (e.type === 'transportChanged') phase = e.state;
    });
    await h.run({ type: 'setLoop', mode: 'once' } as Command);
    await h.run({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: sec(2) }, audio: false, cacheFirst: false, cacheOnly: false } as Command);
    await sleep(200);
    while (phase !== 'stopped') await sleep(50);
    off();
    unsub();
    const at = frames.filter((f) => f.frame >= 30 && f.frame <= 32).map((f) => f.ms);
    const rest = frames.filter((f) => f.frame < 28 || f.frame > 34).map((f) => f.ms).sort((a, b) => a - b);
    console.log(`[p7] ${JSON.stringify({
      frames: frames.length,
      inPointWorstMs: Number(Math.max(0, ...at).toFixed(1)),
      otherP50Ms: Number((rest[Math.floor(rest.length / 2)] ?? 0).toFixed(2)),
      otherWorstMs: Number(Math.max(0, ...rest).toFixed(1)),
    })}`);
    expect(frames.length).toBeGreaterThan(0);
  }, 120_000);
});
