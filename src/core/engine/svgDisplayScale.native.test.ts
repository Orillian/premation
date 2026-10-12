/**
 * E4 (docs/PROGRAM_3D_PERF_UX.md): SVG layers rasterise at the size they are
 * DISPLAYED (DPR × layer scale × camera magnification, quantised to √2 steps,
 * capped at 4096), not at rasterizeSvg's intrinsic size (≥ 2048 px, ≤ 2048 for
 * a large document). On the app's engine with the full renderer:
 *
 *  - a 1500 px document shown at 250 % in a 4K comp is sharper than the same
 *    frame from an engine started with PREMATION_SVG_INTRINSIC=1 (the old
 *    raster, kept as the A/B reference);
 *  - a still is deterministic: the same frame twice, and again after a scale
 *    animation has filled the cache with other steps, is byte-identical;
 *  - a scale animation plays without a first-appearance spike: the raster
 *    happens on the SVG worker, a stand-in step draws meanwhile.
 *
 * The exact re-raster count under an animated scale (steps 17 → 19 only, never
 * once per frame) is asserted on the texture feed itself in
 * native/engine/tests/test_oversize_texture.cpp (`E4:` cases).
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1).
 */

import { PNG } from 'pngjs';
import { ProcessEngineClient, unwrap, type Command } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../electron/engineFraming';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { onSharedEngineFrames, sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';
import { startNativeEngine } from './__testHelpers__/nativeEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate', 'hrtime', 'performance', 'Date'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const W = 3840;
const H = 2160;
const DOC = 1500;
/** A white square with a 1 px diagonal and a disc: an edge to measure, clear of the row through the centre. */
const MARKUP =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DOC} ${DOC}" width="${DOC}" height="${DOC}">` +
  `<rect width="${DOC}" height="${DOC}" fill="#ffffff"/>` +
  `<line x1="0" y1="0" x2="${DOC}" y2="${DOC}" stroke="#000000" stroke-width="1"/>` +
  `<circle cx="${DOC * 0.7}" cy="${DOC * 0.3}" r="${DOC * 0.1}" fill="#000000"/></svg>`;

/** Max |Δred| between horizontal neighbours on row `y`, within ±`half` px of `cx` (the diagonal's crossing). */
function edgeContrast(p: PNG, y: number, cx: number, half: number): number {
  const red = (x: number): number => p.data[(y * p.width + x) * 4]!;
  let best = 0;
  for (let x = Math.max(1, cx - half); x < Math.min(p.width, cx + half); x++) best = Math.max(best, Math.abs(red(x) - red(x - 1)));
  return best;
}

suite('E4: SVG layers rasterise at the displayed size', () => {
  let h: Harness;
  /** The card's engine layer id (the `card` alias binds inside its own tool turn only). */
  let cardId = 'layer_1';
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { width: W, height: H, frameRate: { num: 30, den: 1 }, duration: sec(4) } } as Command);
    await settleEdits();
    const r = await runToolTurn('AI: svg card', [
      { name: 'import_svg', args: { id: 'card', markup: MARKUP, name: 'Card', x: W / 2, y: H / 2 } },
      { name: 'update_layer', args: { nodeId: 'card', scaleX: 2.5, scaleY: 2.5 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    cardId = /id '([^']+)'/.exec(r.results[0]!.content)?.[1] ?? cardId;
    await settleEdits();
  }, 90_000);
  afterAll(async () => { await h.dispose(); });

  async function still(t = 0): Promise<PNG> {
    const th = await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W });
    expect(th.format).toBe('png');
    return PNG.sync.read(Buffer.from(th.data));
  }

  it('a 1500 px document at 250 % in a 4K comp is sharper than the intrinsic raster', async () => {
    const shown = await still();
    expect(shown.width).toBe(W);
    // The same document on an engine that rasterises SVGs at rasterizeSvg's own size (the reference).
    const { document } = await h.query({ type: 'exportDocument' });
    const ref = await startNativeEngine({ extraArgs: ['--test-ports', '--log-level', 'warn'] }, { PREMATION_SVG_INTRINSIC: '1' });
    let intrinsic: PNG;
    try {
      const client = new ProcessEngineClient(ref.bridge);
      unwrap(await client.execute({ type: 'restoreDocument', document, label: 'E4 reference' }));
      const th = unwrap(await client.query({ type: 'getThumbnail', item: 'comp_root', time: 0, maxSize: W }));
      intrinsic = PNG.sync.read(Buffer.from(th.data));
    } finally {
      await ref.stop();
    }
    const cShown = edgeContrast(shown, H / 2, W / 2, 200);
    const cIntrinsic = edgeContrast(intrinsic, H / 2, W / 2, 200);
    // The 1 px line (2.5 display px) at 4096 texels keeps a black core and a
    // one-pixel step; the 2048 px raster magnified 1.83× smears it over two.
    expect({ shown: cShown, intrinsic: cIntrinsic, sharper: cShown > cIntrinsic * 1.2 })
      .toEqual({ shown: cShown, intrinsic: cIntrinsic, sharper: true });
    expect(cShown).toBeGreaterThan(60);
  }, 180_000);

  it('a still is deterministic, before and after a scale animation fills the cache with other steps', async () => {
    const a = await still(0);
    const b = await still(0);
    expect(Buffer.compare(a.data, b.data)).toBe(0);

    const r = await runToolTurn('AI: scale', [
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: cardId, prop: 'scale', t: 1, value: 2.5 }, { nodeId: cardId, prop: 'scale', t: 3, value: 0.6 }] } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const frames: { ms: number }[] = [];
    let phase = 'idle';
    const off = onSharedEngineFrames((f: EngineFrameMessage) => {
      if (f.type === 'frameReady' && phase === 'playing') frames.push({ ms: (f.renderDoneUs - f.renderStartUs) / 1000 });
    });
    const unsub = h.client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    try {
      await h.run({ type: 'setLoop', mode: 'once' } as Command);
      await h.run({ type: 'seek', time: 0, mode: 'exact' } as Command);
      await h.run({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: sec(3.5) }, audio: false, cacheFirst: false, cacheOnly: false } as Command);
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        await sleep(50);
        if (phase !== 'playing' && frames.length > 30) break;
      }
    } finally {
      off();
      unsub();
    }
    expect(frames.length).toBeGreaterThan(30);
    // Off the prepare path: once the pipelines are warm (the first frames), no
    // frame waits on an SVG raster — the worker draws it, a stand-in step shows.
    const warm = frames.slice(5).map((f) => f.ms);
    const worst = Math.max(...warm);
    expect({ frames: frames.length, worstMs: Number(worst.toFixed(1)), under80: worst < 80 }).toEqual({ frames: frames.length, worstMs: Number(worst.toFixed(1)), under80: true });

    // Exact mode (a still) draws the exact step whatever the viewport cached.
    const c = await still(0);
    expect(Buffer.compare(a.data, c.data)).toBe(0);
  }, 180_000);
});
