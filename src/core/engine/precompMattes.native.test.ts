/**
 * Precomps inside track mattes and map-layer effects, rendered on the app's
 * engine with the full renderer. Found rebuilding an After Effects "pixel scan"
 * logo reveal, which is built from exactly these pieces: a precomp matted by a
 * precomp that has a matte of its own, and effects reading a precomp as a map.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1).
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 480;
const H = 270;

suite('precomps in mattes and map effects', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(4) } } as Command);
    await h.run({ type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  async function clear(): Promise<void> {
    const m = documentMirror();
    const ids = m.layerIds().filter((id) => m.layer(id)?.comp === activeCompRootId());
    if (ids.length) await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: ids } }]);
    await settleEdits();
  }
  async function frame(t = 1): Promise<PNG> {
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const px = (p: PNG, x: number, y: number): [number, number, number] => {
    const i = (Math.round(y) * p.width + Math.round(x)) * 4;
    return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
  };
  /** PREMATION_DUMP_DIR: every checked frame is written there as <name>.png (to look at them). */
  const dump = (name: string, p: PNG): void => {
    const dir = process.env.PREMATION_DUMP_DIR;
    if (dir) require('fs').writeFileSync(require('path').join(dir, `${name}.png`), PNG.sync.write(p));
  };
  async function turn(label: string, calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<void> {
    const r = await runToolTurn(label, calls);
    for (const x of r.results) expect(x.ok ? 'ok' : JSON.stringify(x)).toBe('ok');
    await settleEdits();
  }
  /** A precomp of one red full-frame rectangle with a green Fill on the composition layer. */
  const target = [
    { name: 'create_layer', args: { id: 'red', kind: 'shape', shape: 'rect', name: 'Red', x: W / 2, y: H / 2, width: W, height: H, fill: '#ff0000' } },
    { name: 'create_precomp', args: { id: 'T', nodeIds: ['red'], name: 'Target' } },
    { name: 'add_effect', args: { nodeId: 'T', type: 'fill', id: 'green', params: { color: '#00ff00', opacity: 100 } } },
  ];
  /** A precomp whose content is matted inside it: the left 200 px of the top half (x 40..240, y 0..135). */
  const sourceWithInnerMatte = [
    { name: 'create_layer', args: { id: 'win', kind: 'shape', shape: 'rect', name: 'Win', x: 140, y: H / 2, width: 200, height: H, fill: '#ffffff' } },
    { name: 'create_layer', args: { id: 'stencil', kind: 'shape', shape: 'rect', name: 'Stencil', x: W / 2, y: H / 4, width: W, height: H / 2, fill: '#ffffff' } },
    { name: 'update_layer', args: { nodeId: 'win', matte: { mode: 'alpha', sourceId: 'stencil' } } },
    { name: 'create_precomp', args: { id: 'S', nodeIds: ['stencil', 'win'], name: 'Source' } },
    { name: 'update_layer', args: { nodeId: 'T', matte: { mode: 'alpha', sourceId: 'S' } } },
  ];

  it('a precomp matte target keeps its effects when its source precomp has a matte inside', async () => {
    await clear();
    const empty = await frame();
    await turn('AI: matted precomp', [...target, ...sourceWithInnerMatte]);
    const f = await frame();
    dump('precomp-matte-target', f);
    const inside = px(f, 140, 60);
    expect(inside[1]).toBeGreaterThan(200); // the target's Fill ran
    expect(inside[0]).toBeLessThan(40); //    …over its red
    expect(px(f, 140, 200)).toEqual(px(empty, 140, 200)); // outside the source's inner matte: background
    expect(px(f, 400, 60)).toEqual(px(empty, 400, 60));
  });

  it('a scaled layer matted inside a matte-source precomp keeps its matte at any render size', async () => {
    await clear();
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1920, height: 1080 } } as Command);
    try {
      await turn('AI: scaled source', [
        // Target: white over the whole frame. Source: a card scaled 1.2× (wider
        // than the target's) matted inside its precomp to the frame's left half.
        { name: 'create_layer', args: { id: 'all', kind: 'shape', shape: 'rect', name: 'All', x: 960, y: 540, width: 1920, height: 1080, fill: '#ffffff' } },
        { name: 'create_precomp', args: { id: 'T', nodeIds: ['all'], name: 'Target' } },
        { name: 'create_layer', args: { id: 'card', kind: 'shape', shape: 'rect', name: 'Card', x: 960, y: 540, width: 1040, height: 440, fill: '#ffffff' } },
        { name: 'update_layer', args: { nodeId: 'card', scaleX: 1.2 } },
        { name: 'create_layer', args: { id: 'half', kind: 'shape', shape: 'rect', name: 'Half', x: 480, y: 540, width: 960, height: 1080, fill: '#ffffff' } },
        { name: 'update_layer', args: { nodeId: 'card', matte: { mode: 'alpha', sourceId: 'half' } } },
        { name: 'create_precomp', args: { id: 'S', nodeIds: ['half', 'card'], name: 'Source' } },
        // The pixel scan's shrink: eroded 18 px horizontally, so the cut stops 18 px short of x 960.
        { name: 'add_effect', args: { nodeId: 'S', type: 'minimax', id: 'shrink', params: { operation: 1, radius: 18, channel: 0, direction: 1 } } },
        { name: 'update_layer', args: { nodeId: 'T', matte: { mode: 'alpha-inv', sourceId: 'S' } } },
      ]);
      for (const size of [800, 960, 1920]) {
        await settleEdits();
        const th = (await h.query({ type: 'getThumbnail', item: comp, time: sec(1), maxSize: size } as never)) as { data: Uint8Array };
        const f = PNG.sync.read(Buffer.from(th.data));
        dump(`scaled-source-${size}`, f);
        const k = f.width / 1920;
        // Inside the card's right half the source's inner matte removed it: the target shows (white).
        expect([size, px(f, 1300 * k, 540 * k)[0]]).toEqual([size, 255]);
        // Inside the card's left half the source cuts the target out…
        expect([size, px(f, 600 * k, 540 * k)[0]]).not.toEqual([size, 255]);
        // …except the eroded strip by the edge.
        expect([size, px(f, 952 * k, 540 * k)[0]]).toEqual([size, 255]);
      }
    } finally {
      await h.run({ type: 'setCompositionSettings', comp, patch: { width: W, height: H } } as Command);
    }
  });

  it('the pixel-scan shrink (SVG card scaled, torn mosaic wipe, Minimax) keeps its matte at any render size', async () => {
    await clear();
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1920, height: 1080 } } as Command);
    const card = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 440" width="1040" height="440"><rect width="1040" height="440" rx="12" fill="#15171d"/></svg>';
    const wipe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3000 1400" width="3000" height="1400"><rect width="2400" height="1400" fill="#ffffff"/></svg>';
    try {
      await turn('AI: pixel scan shrink', [
        { name: 'create_layer', args: { id: 'all', kind: 'shape', shape: 'rect', name: 'All', x: 960, y: 540, width: 1920, height: 1080, fill: '#ffffff' } },
        { name: 'create_precomp', args: { id: 'T', nodeIds: ['all'], name: 'Target' } },
        { name: 'import_svg', args: { id: 'card', name: 'Card', x: 960, y: 540, markup: card } },
        { name: 'update_layer', args: { nodeId: 'card', scaleX: 1.49, x: 735 } },
        { name: 'import_svg', args: { id: 'wipe', name: 'Wipe', x: 60, y: 540, markup: wipe } },
        { name: 'add_effect', args: { nodeId: 'wipe', type: 'turbulent-displace', id: 'turb', params: { amount: 360, size: 80, complexity: 6 } } },
        { name: 'add_effect', args: { nodeId: 'wipe', type: 'mosaic', id: 'mosaic', params: { horizontalBlocks: 80, verticalBlocks: 33 } } },
        { name: 'update_layer', args: { nodeId: 'card', matte: { mode: 'alpha', sourceId: 'wipe' } } },
        { name: 'create_precomp', args: { id: 'S', nodeIds: ['wipe', 'card'], name: 'Source' } },
        { name: 'add_effect', args: { nodeId: 'S', type: 'minimax', id: 'shrink', params: { operation: 1, radius: 18, channel: 0, direction: 1 } } },
        { name: 'update_layer', args: { nodeId: 'T', matte: { mode: 'alpha-inv', sourceId: 'S' } } },
      ]);
      const covered: number[] = [];
      for (const size of [800, 960, 1920]) {
        await settleEdits();
        const th = (await h.query({ type: 'getThumbnail', item: comp, time: sec(1), maxSize: size } as never)) as { data: Uint8Array };
        const f = PNG.sync.read(Buffer.from(th.data));
        dump(`pixel-scan-shrink-${size}`, f);
        const k = f.width / 1920;
        // Deep inside the card's revealed part the source cuts the target out; far right it does not.
        expect([size, px(f, 300 * k, 540 * k)[0]]).not.toEqual([size, 255]);
        expect([size, px(f, 1800 * k, 540 * k)[0]]).toEqual([size, 255]);
        // How much of the card's row the source covers, as a fraction of the width: the same at every size.
        let n = 0;
        for (let x = 0; x < f.width; x++) if (px(f, x, 540 * k)[0] !== 255) n++;
        covered.push(n / f.width);
      }
      expect(Math.max(...covered) - Math.min(...covered)).toBeLessThan(0.03);
    } finally {
      await h.run({ type: 'setCompositionSettings', comp, patch: { width: W, height: H } } as Command);
    }
  });

  it('the whole pixel-scan band (matted base minus the scaled, eroded shrink) survives at every render size', async () => {
    await clear();
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1920, height: 1080 } } as Command);
    const card = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 440" width="1040" height="440"><rect width="1040" height="440" rx="12" fill="#15171d"/></svg>';
    const wipe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3000 1400" width="3000" height="1400"><rect width="2400" height="1400" fill="#ffffff"/></svg>';
    const half = (p: string, scale: Record<string, unknown>) => [
      // The same SVG document in both precomps, drawn at two sizes: the larger
      // raster used to drop the smaller one the other layer had just drawn from.
      { name: 'import_svg', args: { id: `${p}card`, name: `${p} card`, x: 960, y: 540, markup: card } },
      { name: 'update_layer', args: { nodeId: `${p}card`, ...scale } },
      { name: 'import_svg', args: { id: `${p}wipe`, name: `${p} wipe`, x: 60, y: 540, markup: wipe } },
      { name: 'add_effect', args: { nodeId: `${p}wipe`, type: 'turbulent-displace', id: 'turb', params: { amount: 360, size: 80, complexity: 6 } } },
      { name: 'add_effect', args: { nodeId: `${p}wipe`, type: 'mosaic', id: 'mosaic', params: { horizontalBlocks: 80, verticalBlocks: 33 } } },
      { name: 'update_layer', args: { nodeId: `${p}card`, matte: { mode: 'alpha', sourceId: `${p}wipe` } } },
      { name: 'create_precomp', args: { id: p, nodeIds: [`${p}wipe`, `${p}card`], name: p } },
      { name: 'add_effect', args: { nodeId: p, type: 'fill', id: 'white', params: { color: '#ffffff', opacity: 100 } } },
    ];
    try {
      await turn('AI: pixel scan band', [
        ...half('Base', { scaleX: 1 }),
        ...half('Shrink', { scaleX: 1.49, x: 735 }),
        { name: 'add_effect', args: { nodeId: 'Shrink', type: 'minimax', id: 'shrink', params: { operation: 1, radius: 18, channel: 0, direction: 1 } } },
        { name: 'update_layer', args: { nodeId: 'Base', matte: { mode: 'alpha-inv', sourceId: 'Shrink' } } },
      ]);
      const band: number[] = [];
      for (const size of [800, 960, 1920]) {
        await settleEdits();
        const th = (await h.query({ type: 'getThumbnail', item: comp, time: sec(1), maxSize: size } as never)) as { data: Uint8Array };
        const f = PNG.sync.read(Buffer.from(th.data));
        dump(`pixel-scan-band-${size}`, f);
        const k = f.width / 1920;
        let n = 0;
        for (let y = Math.round(330 * k); y < Math.round(750 * k); y += 2) {
          for (let x = 0; x < f.width; x++) if (px(f, x, y)[0] > 128) n++;
        }
        band.push(n / (k * k));
      }
      // The band is there at every size, and about the same size (in composition pixels) at each.
      for (const b of band) expect(b).toBeGreaterThan(2000);
      expect(Math.max(...band) / Math.min(...band)).toBeLessThan(1.3);
    } finally {
      await h.run({ type: 'setCompositionSettings', comp, patch: { width: W, height: H } } as Command);
    }
  });

  it.each([false, true])('a mask on a precomp layer clips it (with an effect: %s)', async (withEffect) => {
    await clear();
    const empty = await frame();
    await turn('AI: masked precomp', [
      { name: 'create_layer', args: { id: 'red', kind: 'shape', shape: 'rect', name: 'Red', x: W / 2, y: H / 2, width: W, height: H, fill: '#ff0000' } },
      { name: 'create_precomp', args: { id: 'P', nodeIds: ['red'], name: 'Masked' } },
      ...(withEffect ? [{ name: 'add_effect', args: { nodeId: 'P', type: 'fill', id: 'green', params: { color: '#00ff00', opacity: 100 } } }] : []),
      // Keep the left half (layer px, from the layer centre).
      { name: 'create_mask', args: { nodeId: 'P', shape: 'rectangle', width: W / 2, height: H, x: -W / 4, y: 0 } },
    ]);
    const f = await frame();
    dump(`precomp-mask-${withEffect}`, f);
    expect(px(f, W / 4, H / 2)).not.toEqual(px(empty, W / 4, H / 2));
    expect(px(f, (3 * W) / 4, H / 2)).toEqual(px(empty, (3 * W) / 4, H / 2));
  });

  it.each(['fill', 'solid', 'fills'])('an effect whose id is the layer field name "%s" still renders, before and after pre-composing', async (id) => {
    await clear();
    await turn('AI: effect id', [
      { name: 'create_layer', args: { id: 'red', kind: 'shape', shape: 'rect', name: 'Red', x: W / 2, y: H / 2, width: W / 2, height: H / 2, fill: '#ff0000' } },
      { name: 'add_effect', args: { nodeId: 'red', type: 'fill', id, params: { color: '#00ff00', opacity: 100 } } },
    ]);
    expect(px(await frame(), W / 2, H / 2)[1]).toBeGreaterThan(200);
    const m = documentMirror();
    const red = m.layerIds().find((l) => m.layer(l)?.name === 'Red' && m.layer(l)?.comp === activeCompRootId());
    await turn('AI: precompose it', [{ name: 'create_precomp', args: { nodeIds: [red], name: 'Wrapped' } }]);
    expect(px(await frame(), W / 2, H / 2)[1]).toBeGreaterThan(200);
  });

  it('a Displacement Map reading a precomp leaves the displaced precomp intact', async () => {
    await clear();
    const empty = await frame();
    await turn('AI: displaced precomp', [
      // The displaced layer: red, matted inside its precomp to the top half.
      { name: 'create_layer', args: { id: 'red', kind: 'shape', shape: 'rect', name: 'Red', x: W / 2, y: H / 2, width: W, height: H, fill: '#ff0000' } },
      { name: 'create_layer', args: { id: 'top', kind: 'shape', shape: 'rect', name: 'Top', x: W / 2, y: H / 4, width: W, height: H / 2, fill: '#ffffff' } },
      { name: 'update_layer', args: { nodeId: 'red', matte: { mode: 'alpha', sourceId: 'top' } } },
      { name: 'create_precomp', args: { id: 'D', nodeIds: ['top', 'red'], name: 'Displaced' } },
      // The map: also a precomp with a matte inside, at 0% so only the effect sees it.
      { name: 'create_layer', args: { id: 'white', kind: 'shape', shape: 'rect', name: 'White', x: W / 2, y: H / 2, width: W, height: H, fill: '#ffffff' } },
      { name: 'create_layer', args: { id: 'left', kind: 'shape', shape: 'rect', name: 'Left', x: W / 4, y: H / 2, width: W / 2, height: H, fill: '#ffffff' } },
      { name: 'update_layer', args: { nodeId: 'white', matte: { mode: 'alpha', sourceId: 'left' } } },
      { name: 'create_precomp', args: { id: 'M', nodeIds: ['left', 'white'], name: 'Map' } },
      { name: 'update_layer', args: { nodeId: 'M', opacity: 0 } },
      { name: 'add_effect', args: { nodeId: 'D', type: 'displacement-map', id: 'disp', params: { amount: 6, mapLayerId: 'M' } } },
    ]);
    const f = await frame();
    dump('precomp-displaced', f);
    for (const x of [120, 360]) {
      const top = px(f, x, 60);
      expect(top[0]).toBeGreaterThan(200); // still the red top half…
      expect(top[1]).toBeLessThan(40);
      expect(px(f, x, 210)).toEqual(px(empty, x, 210)); // …and nothing below it
    }
  });
});
