/**
 * B5 (docs/PROGRAM_3D_PERF_UX.md): Light Sweep on a text layer lights the
 * GLYPHS, as AE's CC Light Sweep does, not the whole text box — a texel the
 * bare layer leaves empty stays empty with the sweep on it, on every layer
 * shape the samurai comp used (2D / 3D text, text with an animator, a
 * paragraph box, an SVG, a scripted h1). The other overlay generators are
 * documented too: Light Rays (rays shoot out of the content, as CC Light
 * Rays') and Beam (a laser drawn over the layer) are MEANT to leave the alpha.
 * And the samurai "band over the whole text box": a Drop Shadow placed BEFORE
 * the sweep puts a soft 85 % alpha halo around the glyphs, which the sweep
 * lights like AE does — effect order; the sweep first leaves the shadow dark.
 * Full renderer, needs a GPU adapter (PREMATION_GPU_TESTS=1).
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { compileScript } from '@motion/author';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 960;
const H = 540;

type Call = { name: string; args: Record<string, unknown> };

suite('overlay generator effects and the layer alpha', () => {
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
  const px = (p: PNG, x: number, y: number): [number, number, number] => {
    const i = (Math.round(y * p.height / H) * p.width + Math.round(x * p.width / W)) * 4;
    return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
  };
  /** The comp background in the thumbnail (nothing of the layer there). */
  const isBg = (r: number, g: number, b: number): boolean => Math.abs(r - 16) <= 2 && Math.abs(g - 16) <= 2 && Math.abs(b - 20) <= 2;
  const idNamed = (name: string): string => documentMirror().layerIds().find((x) => documentMirror().layer(x)?.name === name)!;

  /** Texels inside the layer's box the bare layer leaves empty, and texels it inks solidly. */
  async function classify(id: string): Promise<{ empty: Array<[number, number]>; inked: Array<[number, number]> }> {
    const b = (await h.query({ type: 'getLayerBounds', layers: [id], time: sec(1), space: 'comp', includeEffects: false } as never)) as { bounds: Array<{ bounds: { x: number; y: number; width: number; height: number } }> };
    const box = b.bounds[0]!.bounds;
    const p = await frame();
    const empty: Array<[number, number]> = [];
    const inked: Array<[number, number]> = [];
    for (let y = Math.ceil(box.y) + 2; y < box.y + box.height - 2; y += 3) {
      for (let x = Math.ceil(box.x) + 2; x < box.x + box.width - 2; x += 3) {
        const [r, g, bl] = px(p, x, y);
        if (isBg(r, g, bl)) empty.push([x, y]);
        else if (Math.max(r, g, bl) > 40) inked.push([x, y]);  // the layer's own paint, whatever its colour
      }
    }
    return { empty, inked };
  }
  const nearInk = (inked: Array<[number, number]>, x: number, y: number): boolean => inked.some(([ix, iy]) => Math.abs(ix - x) <= 4 && Math.abs(iy - y) <= 4);
  /** Of `empty`, the texels now lit that are not within 4 px of an inked texel (glyph edges light up legitimately). */
  const litAway = (p: PNG, empty: Array<[number, number]>, inked: Array<[number, number]>): number => {
    let n = 0;
    for (const [x, y] of empty) {
      const [r, g, b] = px(p, x, y);
      if (!isBg(r, g, b) && !nearInk(inked, x, y)) n++;
    }
    return n;
  };
  const brighter = (p: PNG, inked: Array<[number, number]>): number => inked.filter(([x, y]) => px(p, x, y).reduce((a, v) => a + v, 0) > 64 * 3 + 30).length;

  const sweep = { position: 50, sweepWidth: 400, angle: 30, intensity: 100, softness: 50, color: '#ffffff' };
  const text = (extra: Record<string, unknown> = {}): Call[] => [
    { name: 'create_layer', args: { id: 't', kind: 'text', name: 'Sweep', text: 'SAMURAI', fill: '#404040', x: W / 2, y: H / 2 } },
    { name: 'update_layer', args: { nodeId: 't', fontSize: 160, ...extra } },
  ];
  const svg = '<svg viewBox="0 0 700 220" xmlns="http://www.w3.org/2000/svg"><path d="M 20 200 C 200 160 420 110 680 20 L 690 40 C 430 130 210 180 30 215 Z" fill="#8090a0"/></svg>';
  const setups: Array<{ name: string; calls: Call[] }> = [
    { name: 'text', calls: text() },
    { name: '3D text', calls: text({ threeD: true }) },
    { name: 'text with an animator', calls: [...text(), { name: 'text_animator', args: { nodeId: 't', color: '#ff8040', sweep: { fromSec: 0, toSec: 2 } } }] },
    { name: 'boxed text', calls: [
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'Sweep', text: 'SAMURAI', fill: '#404040', x: W / 2, y: H / 2, width: 900, height: 400 } },
      { name: 'update_layer', args: { nodeId: 't', fontSize: 160 } } ] },
    { name: 'scripted h1 text', calls: compileScript({
      title: 't', intent: 'i', durationSec: 4, background: '$bg', palette: { bg: '#101014', ink: '#fafafa' },
      grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 }, type: { h1: { family: 'Inter', weight: 700, size: 160 } }, globals: [],
      beats: [{ name: 'Title', purpose: '', startSec: 0, endSec: 4, layers: [{ id: 't', kind: 'text', name: 'Sweep', text: 'SAMURAI', typeStyle: 'h1', props: { x: W / 2, y: H / 2 } }] }],
    }).calls as Call[] },
    { name: 'svg', calls: [
      { name: 'import_svg', args: { id: 's', markup: svg, name: 'Sweep', x: W / 2, y: H / 2 } },
      { name: 'update_layer', args: { nodeId: 's', threeD: true } } ] },
  ];

  for (const setup of setups) {
    it(`light-sweep over ${setup.name} lights the content and leaves the box's empty texels empty`, async () => {
      const r = await runToolTurn('AI: layer', setup.calls);
      expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
      await settleEdits();
      const id = idNamed('Sweep');
      const { empty, inked } = await classify(id);
      expect(empty.length).toBeGreaterThan(50);
      expect(inked.length).toBeGreaterThan(50);
      const r2 = await runToolTurn('AI: fx', [{ name: 'add_effect', args: { nodeId: id, type: 'light-sweep', params: sweep } }]);
      expect(r2.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
      await settleEdits();
      const p = await frame();
      expect([setup.name, litAway(p, empty, inked)]).toEqual([setup.name, 0]);
      expect(brighter(p, inked)).toBeGreaterThan(0);
    }, 120_000);
  }

  it('light-sweep before a drop shadow leaves the shadow dark; the shadow first is lit by the sweep (effect order, as AE)', async () => {
    const shadow = { angle: 90, color: '#180814', spread: 10, opacity: 85, distance: 8, softness: 24 };
    const build = async (order: Array<'sweep' | 'shadow'>): Promise<PNG> => {
      const r = await runToolTurn('AI: layer', text());
      expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
      await settleEdits();
      const id = idNamed('Sweep');
      const fx = await runToolTurn('AI: fx', order.map((o) => (o === 'sweep'
        ? { name: 'add_effect', args: { nodeId: id, type: 'light-sweep', params: sweep } }
        : { name: 'add_effect', args: { nodeId: id, type: 'drop-shadow', params: shadow } })));
      expect(fx.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
      await settleEdits();
      const p = await frame();
      await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: [id] } }]);
      await settleEdits();
      return p;
    };
    const bare = await runToolTurn('AI: layer', text());
    expect(bare.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const { empty, inked } = await classify(idNamed('Sweep'));
    await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: [idNamed('Sweep')] } }]);
    await settleEdits();
    // Bright texels away from the glyphs: a lit shadow halo.
    const brightHalo = (p: PNG): number => empty.filter(([x, y]) => px(p, x, y).reduce((a, v) => a + v, 0) > 3 * 90 && !nearInk(inked, x, y)).length;
    const sweepFirst = await build(['sweep', 'shadow']);
    expect(brightHalo(sweepFirst)).toBe(0);
    expect(brighter(sweepFirst, inked)).toBeGreaterThan(0);
    const shadowFirst = await build(['shadow', 'sweep']);
    expect(brightHalo(shadowFirst)).toBeGreaterThan(50);
  }, 180_000);

  it('light-rays and beam are generators: their light leaves the glyph alpha by design', async () => {
    for (const fx of [
      { type: 'light-rays', params: { centerX: 0, centerY: 0, rayCount: 24, rayLength: 600, opacity: 100, color: '#ffffff' } },
      { type: 'beam', params: { startX: 0, startY: 50, endX: 100, endY: 50, length: 100, thickness: 200, softness: 100, color: '#ffffff' } },
    ]) {
      const r = await runToolTurn('AI: layer', text());
      expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
      await settleEdits();
      const id = idNamed('Sweep');
      const { empty, inked } = await classify(id);
      await runToolTurn('AI: fx', [{ name: 'add_effect', args: { nodeId: id, type: fx.type, params: fx.params } }]);
      await settleEdits();
      expect([fx.type, litAway(await frame(), empty, inked) > 100]).toEqual([fx.type, true]);
      await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: [id] } }]);
      await settleEdits();
    }
  }, 180_000);
});
