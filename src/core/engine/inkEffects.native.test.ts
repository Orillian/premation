/**
 * Phase I (docs/PROGRAM_PLAYBACK_TEXT_INK.md): the ink / stylize effects the
 * samurai session found broken, rendered on the app's engine with the full
 * renderer. Needs a GPU adapter (PREMATION_GPU_TESTS=1).
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 960;
const H = 540;

suite('ink effects on the full renderer', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(4) } } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  afterEach(async () => {
    const m = documentMirror();
    const ids = m.layerIds().filter((id) => m.layer(id)?.comp === activeCompRootId());
    if (ids.length) await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: ids } }]);
    await settleEdits();
  });

  async function frame(t = 1): Promise<PNG> {
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const luma = (p: PNG, x: number, y: number): number => {
    const i = (Math.round(y * p.height / H) * p.width + Math.round(x * p.width / W)) * 4;
    return 0.2126 * p.data[i]! + 0.7152 * p.data[i + 1]! + 0.0722 * p.data[i + 2]!;
  };

  async function paper(): Promise<void> {
    await runToolTurn('AI: paper', [{ name: 'create_layer', args: { id: 'p', kind: 'shape', name: 'Paper', x: W / 2, y: H / 2, width: W, height: H, fill: '#e8e0d0' } }]);
  }

  it('I4: Vignette on an adjustment layer darkens the edges and leaves the centre', async () => {
    await paper();
    const r = await runToolTurn('AI: vignette adj', [
      { name: 'create_layer', args: { id: 'a', kind: 'adjustment', name: 'Adj', x: W / 2, y: H / 2 } },
      { name: 'add_effect', args: { nodeId: 'a', type: 'vignette', params: { amount: 80 } } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const p = await frame();
    const centre = luma(p, W / 2, H / 2);
    const corner = luma(p, 8, 8);
    expect(centre).toBeGreaterThan(200);            // the paper, untouched
    expect(corner).toBeLessThan(centre - 60);       // the falloff
  }, 120_000);

  it('I5: a dark gradient is dithered at 8 bits instead of banding in long flat steps', async () => {
    const r = await runToolTurn('AI: dark sky', [{ name: 'create_gradient', args: { id: 'sky', name: 'Sky', stops: ['#050303', '#2a1410'], angle: 0 } }]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const p = await frame();
    // The longest run of one red value along the middle row.
    const y = Math.round(p.height / 2);
    let longest = 0;
    let run = 0;
    let prev = -1;
    let changes = 0;
    for (let x = 0; x < p.width; x++) {
      const v = p.data[(y * p.width + x) * 4]!;
      if (prev >= 0 && v !== prev) changes++;
      run = v === prev ? run + 1 : 1;
      prev = v;
      longest = Math.max(longest, run);
    }
    // ~37 levels over the row: undithered, each level is one ~26 px slab (~37
    // value changes). Dithered (±½ step, so flat colours stay exact), every
    // step's edge breaks into grain: many times the changes, shorter slabs.
    expect(changes).toBeGreaterThan(37 * 4);
    expect(longest).toBeLessThan(22);
  }, 120_000);

  it('I2: Write-on draws where its centre-relative brush went, tapering with keyed size', async () => {
    await paper();
    const id = documentMirror().layerIds().find((x) => documentMirror().layer(x)?.name === 'Paper')!;
    const r = await runToolTurn('AI: write-on', [
      { name: 'add_effect', args: { nodeId: id, type: 'write-on', id: 'wo', params: { writeOnMode: 0, brushColor: '#111111', brushTimeProps: 1 } } },
      { name: 'set_keyframes', args: { keyframes: [
        { nodeId: id, prop: 'effect.wo.brushPositionX', t: 0, value: -300 }, { nodeId: id, prop: 'effect.wo.brushPositionX', t: 1.5, value: 300 },
        { nodeId: id, prop: 'effect.wo.brushPositionY', t: 0, value: 0 }, { nodeId: id, prop: 'effect.wo.brushPositionY', t: 1.5, value: 0 },
        { nodeId: id, prop: 'effect.wo.brushSize', t: 0, value: 40 }, { nodeId: id, prop: 'effect.wo.brushSize', t: 1.5, value: 4 },
      ] } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    expect(String(r.results[0]!.content)).toContain('LAYER CENTRE');
    await settleEdits();
    const p = await frame(1.6);
    const thickness = (x: number): number => {
      let n = 0;
      for (let y = 0; y < H; y++) if (luma(p, x, y) < 80) n++;
      return n;
    };
    // From the centre (480, 270): x −300 → 180, +300 → 780.
    expect(thickness(150)).toBe(0);
    expect(thickness(200)).toBeGreaterThan(20);
    expect(thickness(760)).toBeGreaterThan(0);
    expect(thickness(760)).toBeLessThan(thickness(200) / 2);
    expect(thickness(820)).toBe(0);
  }, 120_000);

  it('F4: paint_strokes paints a pressure-tapered stroke where its points say, and reveals it', async () => {
    await paper();
    const id = documentMirror().layerIds().find((x) => documentMirror().layer(x)?.name === 'Paper')!;
    const pts: number[][] = [];
    for (let k = 0; k <= 30; k++) {
      const u = k / 30;
      pts.push([180 + 600 * u, 270, Math.sin(Math.PI * u)]);  // light at the ends, full in the belly
    }
    const r = await runToolTurn('AI: brush', [
      { name: 'paint_strokes', args: { nodeId: id, strokes: [{ points: pts, color: '#111111', size: 60, minSize: 5, hardness: 90, reveal: { from: 0, to: 2 } }] } },
    ]);
    expect(r.results.map((x) => (x.ok ? 'ok' : x.content))).toEqual(['ok']);
    await settleEdits();
    const thickness = (p: PNG, x: number): number => {
      let n = 0;
      for (let y = 0; y < H; y++) if (luma(p, x, y) < 80) n++;
      return n;
    };
    const done = await frame(2.5);
    expect(thickness(done, 120)).toBe(0);                        // before the first point
    expect(thickness(done, 480)).toBeGreaterThan(40);              // the belly: near full size
    expect(thickness(done, 200)).toBeLessThan(thickness(done, 480) / 2);  // the lifted start
    expect(thickness(done, 840)).toBe(0);                          // past the last point
    const half = await frame(1);
    expect(thickness(half, 300)).toBeGreaterThan(0);               // drawn by the halfway time
    expect(thickness(half, 700)).toBe(0);                          // not yet
  }, 120_000);

  /** Dark pixels inside a box (cx, cy ± half). */
  const inkIn = (p: PNG, cx: number, cy: number, half: number): number => {
    let n = 0;
    for (let y = cy - half; y < cy + half; y++) for (let x = cx - half; x < cx + half; x++) if (luma(p, x, y) < 120) n++;
    return n;
  };

  it('I3: Roughen Edges roughens the rim of a small seal and keeps its body', async () => {
    await paper();
    const r = await runToolTurn('AI: seal', [
      { name: 'create_layer', args: { id: 's', kind: 'shape', name: 'Seal', x: 480, y: 270, width: 56, height: 56, fill: '#7a1410' } },
      { name: 'add_effect', args: { nodeId: 's', type: 'roughen-edges', params: { border: 6 } } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const p = await frame();
    // The inner 28 × 28 core is untouched by a 6 px border.
    expect(inkIn(p, 480, 270, 14)).toBe(28 * 28);
    // The rim is broken: fewer than all of the 56 × 56 box, more than the core.
    const all = inkIn(p, 480, 270, 28);
    expect(all).toBeGreaterThan(28 * 28 + 200);
    expect(all).toBeLessThan(56 * 56 - 40);
  }, 120_000);

  it('F1: Ink Bleed spreads a mark into the paper beyond its edge', async () => {
    await paper();
    const r = await runToolTurn('AI: bleed', [
      { name: 'create_layer', args: { id: 'm', kind: 'shape', name: 'Mark', x: 480, y: 270, width: 200, height: 60, fill: '#111111' } },
    ]);
    expect(r.results.every((x) => x.ok)).toBe(true);
    await settleEdits();
    const before = inkIn(await frame(), 480, 270, 140);
    const mark = documentMirror().layerIds().find((x) => documentMirror().layer(x)?.name === 'Mark')!;
    const b = await runToolTurn('AI: bleed fx', [{ name: 'add_effect', args: { nodeId: mark, type: 'ink-bleed', params: { spread: 24, roughness: 70 } } }]);
    expect(b.results.map((x) => (x.ok ? 'ok' : x.content))).toEqual(['ok']);
    await settleEdits();
    const after = inkIn(await frame(), 480, 270, 140);
    expect(after).toBeGreaterThan(before * 1.1);
  }, 120_000);

  it('F2: Paper fills a solid with a textured tone, not a flat colour', async () => {
    await paper();
    const id = documentMirror().layerIds().find((x) => documentMirror().layer(x)?.name === 'Paper')!;
    const r = await runToolTurn('AI: paper fx', [{ name: 'add_effect', args: { nodeId: id, type: 'paper', params: { color: '#e8dcc4', fibre: 100, grain: 100, mottle: 100 } } }]);
    expect(r.results.map((x) => (x.ok ? 'ok' : x.content))).toEqual(['ok']);
    await settleEdits();
    const p = await frame();
    const values = new Set<number>();
    let sum = 0;
    let n = 0;
    for (let y = 100; y < 440; y += 3) for (let x = 100; x < 860; x += 3) { const l = Math.round(luma(p, x, y)); values.add(l); sum += l; n++; }
    expect(values.size).toBeGreaterThan(12);        // texture: many tones
    expect(sum / n).toBeGreaterThan(170);           // still a light paper
  }, 120_000);

  it('F3: Ink Splatter draws seeded splats that grow with Reveal', async () => {
    await paper();
    const id = documentMirror().layerIds().find((x) => documentMirror().layer(x)?.name === 'Paper')!;
    const r = await runToolTurn('AI: splatter', [
      { name: 'add_effect', args: { nodeId: id, type: 'ink-splatter', id: 'sp', params: { amount: 20, size: 22, spread: 200 } } },
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: id, prop: 'effect.sp.reveal', t: 0, value: 0 }, { nodeId: id, prop: 'effect.sp.reveal', t: 1, value: 100 }] } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const count = (p: PNG): number => inkIn(p, 480, 270, 260);
    expect(count(await frame(0))).toBe(0);
    const mid = count(await frame(0.5));
    const full = count(await frame(1.5));
    expect(mid).toBeGreaterThan(50);
    expect(full).toBeGreaterThan(mid * 2);
    expect(count(await frame(1.5))).toBe(full);    // deterministic
  }, 120_000);

  it('I4: Snowfall on an adjustment layer draws flakes', async () => {
    await runToolTurn('AI: dark', [{ name: 'create_layer', args: { id: 'p', kind: 'shape', name: 'Night', x: W / 2, y: H / 2, width: W, height: H, fill: '#101418' } }]);
    const r = await runToolTurn('AI: snow adj', [
      { name: 'create_layer', args: { id: 'a', kind: 'adjustment', name: 'Snow', x: W / 2, y: H / 2 } },
      { name: 'add_effect', args: { nodeId: 'a', type: 'snowfall', params: { amount: 100, size: 3 } } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const p = await frame(2);
    let bright = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (luma(p, x, y) > 120) bright++;
    expect(bright).toBeGreaterThan(50);
  }, 120_000);
});
