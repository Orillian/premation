/**
 * Bugs hit while authoring the samurai comp through the MCP tools
 * (docs/PROGRAM_3D_PERF_UX.md B1, B3, B4), on the app's engine.
 */

import { secondsToFlicks, type Command } from '@motion/engine-api';
import { compileScript, type SceneScript } from '@motion/author';
import { activeCompRootId } from '@core/scene/activeComp';
import { setupAppEngine, settleEdits, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { defaultRangeSelector, rangeSelectorAt } from '@core/text/textSelectors';
import { documentMirror } from '@stores/documentMirror';
import { useCompositionStore } from '@stores/compositionStore';
import { runToolTurn } from './aiTurn';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeAll(async () => {
  h = await setupAppEngine({ gpu: process.env.PREMATION_GPU_TESTS === '1' });
  await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { duration: sec(6) } } as Command);
  await settleEdits();
}, 60_000);
afterAll(async () => { await h.dispose(); });

const idNamed = (name: string): string => {
  const m = documentMirror();
  return m.layerIds().find((c) => m.layer(c)?.name === name) ?? '';
};

const script = (over: Partial<SceneScript>): SceneScript => ({
  title: 't', intent: 'i', durationSec: 6, background: '$bg',
  palette: { bg: '#101014', ink: '#fafafa' },
  grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
  type: { h1: { family: 'Inter', weight: 700, size: 120 } },
  globals: [],
  beats: [],
  ...over,
});

async function value(layer: string, path: string): Promise<unknown> {
  const r = (await h.query({ type: 'getPropertyValues', props: [{ layer, path }], time: 0, evaluated: false } as never)) as {
    values: { value: { value: unknown } }[];
  };
  return r.values[0]?.value.value;
}

/**
 * The comp-space box a top-level layer's own quad covers at `t`: its width ×
 * height centred on its evaluated position (the quad is centred on the layer
 * origin; anchor 0). An adjustment layer has no content of its own, so
 * `getLayerBounds` answers nothing for it (and the headless engine's
 * `getLayerTransforms` gives it an identity matrix) — what covers the frame
 * is this quad.
 */
async function boundsOf(layer: string, t = 0): Promise<{ x: number; y: number; width: number; height: number }> {
  const r = (await h.query({
    type: 'getPropertyValues',
    props: [{ layer, path: 'transform/position' }, { layer, path: 'layer/width' }, { layer, path: 'layer/height' }],
    time: secondsToFlicks(t),
    evaluated: true,
  } as never)) as { values: { value: { value: unknown } }[] };
  const pos = r.values[0]!.value.value as { x: number; y: number };
  const w = Number(r.values[1]!.value.value);
  const ht = Number(r.values[2]!.value.value);
  return { x: pos.x - w / 2, y: pos.y - ht / 2, width: w, height: ht };
}

describe('B1: full-frame layers cover the comp', () => {
  it('author_scene places an adjustment layer over the whole comp, not its top-left quarter', async () => {
    const s = script({
      beats: [{
        name: 'Rain', purpose: '', startSec: 0, endSec: 6,
        layers: [
          { id: 'hero', kind: 'shape', name: 'Hero', shape: 'rect', props: { x: 960, y: 540, width: 400, height: 400, fill: '$ink' } },
          { id: 'rain', kind: 'adjustment', name: 'Rain', effects: [{ id: 'fx', type: 'rainfall' }] },
        ],
      }],
    });
    const r = await runToolTurn('AI: rain', compileScript(s).calls);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const comp = useCompositionStore.getState().comp();
    const b = await boundsOf(idNamed('Rain'));
    expect(b.x).toBeLessThanOrEqual(0);
    expect(b.y).toBeLessThanOrEqual(0);
    expect(b.x + b.width).toBeGreaterThanOrEqual(comp.width);
    expect(b.y + b.height).toBeGreaterThanOrEqual(comp.height);
  });

  it('create_layer kind:adjustment and a size-less solid are centred on the comp', async () => {
    const r = await runToolTurn('AI: grade', [
      { name: 'create_layer', args: { id: 'g', kind: 'adjustment', name: 'Grade' } },
      { name: 'create_layer', args: { id: 's', kind: 'solid', name: 'Backdrop', fill: '#102030' } },
      { name: 'create_layer', args: { id: 'p', kind: 'adjustment', name: 'Placed', x: 300, y: 200, width: 400, height: 200 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const comp = useCompositionStore.getState().comp();
    for (const name of ['Grade', 'Backdrop']) {
      const b = await boundsOf(idNamed(name));
      expect([name, b.x, b.y, b.width, b.height]).toEqual([name, 0, 0, comp.width, comp.height]);
    }
    // A placed, sized adjustment layer keeps what the caller said.
    const p = await boundsOf(idNamed('Placed'));
    expect([p.x, p.y, p.width, p.height]).toEqual([100, 100, 400, 200]);
  });
});

describe('B1 (engine): an adjustment layer re-parents keep-world and has comp-sized bounds', () => {
  it('reparent_layer under an offset root keeps the grade centred; getLayerBounds answers the comp box', async () => {
    const r = await runToolTurn('AI: grade under root', [
      { name: 'create_layer', args: { id: 'root', kind: 'null', name: 'Root B1', x: 300, y: 200 } },
      { name: 'create_layer', args: { id: 'g', kind: 'adjustment', name: 'Grade B1' } },
      { name: 'reparent_layer', args: { nodeId: 'g', parentId: 'root' } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const comp = useCompositionStore.getState().comp();
    const id = idNamed('Grade B1');  // a name of its own: the suite keeps its earlier layers
    // The world transform the engine answers: still the comp centre.
    const t = (await h.query({ type: 'getLayerTransforms', layers: [id], time: 0 } as never)) as { transforms: { matrix: number[] }[] };
    expect(t.transforms[0]!.matrix[12]).toBeCloseTo(comp.width / 2, 3);
    expect(t.transforms[0]!.matrix[13]).toBeCloseTo(comp.height / 2, 3);
    // And the local position moved by the root's offset (keep-world compensation).
    const local = (await value(id, 'transform/position')) as { x: number; y: number };
    expect(local.x).toBeCloseTo(comp.width / 2 - 300, 3);
    expect(local.y).toBeCloseTo(comp.height / 2 - 200, 3);
    // getLayerBounds: the comp-sized box (an adjustment layer used to answer nothing).
    const b = (await h.query({ type: 'getLayerBounds', layers: [id], time: 0, space: 'comp', includeEffects: false } as never)) as { bounds: { bounds: { x: number; y: number; width: number; height: number } }[] };
    expect(b.bounds).toHaveLength(1);
    const box = b.bounds[0]!.bounds;
    expect([box.x, box.y, box.width, box.height].map((v) => Math.round(v))).toEqual([0, 0, comp.width, comp.height]);
  });
});

describe('B3: a text-animator sweep crosses the text once', () => {
  it('the compiled sweep takes every character from selected to unselected, monotonically', async () => {
    const s = script({
      beats: [{
        name: 'Title', purpose: '', startSec: 0, endSec: 6,
        layers: [{
          id: 't', kind: 'text', name: 'Sweep', text: 'SAMURAI', typeStyle: 'h1', props: { x: 960, y: 540 },
          textAnimators: [{ opacity: 0, sweep: { from: 1, to: 2 } }],
        }],
      }],
    });
    const r = await runToolTurn('AI: title', compileScript(s).calls);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const id = idNamed('Sweep');
    const count = 'SAMURAI'.length;
    const times = [0.5, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.5];
    const offsets: number[] = [];
    for (const t of times) {
      const e = await runToolTurn('AI: probe', [{ name: 'evaluate_at', args: { nodeId: id, t } }]);
      const values = (e.results[0]!.data as { values: Record<string, number> }).values;
      expect(typeof values['ta.0.offset']).toBe('number');
      offsets.push(values['ta.0.offset']!);
    }
    // Before the sweep every glyph is selected (covered: opacity 0); after it none is.
    const sel = { ...defaultRangeSelector(), start: 0, end: 100, shape: 'square' as const };
    const weights = offsets.map((offset) => Array.from({ length: count }, (_, u) => rangeSelectorAt({ ...sel, offset }, u, count)));
    expect(weights[0]).toEqual(Array(count).fill(1));
    expect(weights.at(-1)).toEqual(Array(count).fill(0));
    // Per character the weight never rises again: the window crosses it ONCE.
    for (let u = 0; u < count; u++) {
      for (let i = 1; i < weights.length; i++) expect(weights[i]![u]!).toBeLessThanOrEqual(weights[i - 1]![u]! + 1e-9);
    }
    // And the window actually moves across the string (the middle is a mix).
    const mid = weights[Math.floor(weights.length / 2)]!;
    expect(Math.min(...mid)).toBeLessThan(Math.max(...mid));
  });
});

describe('B4: out-of-range effect params say what was clamped; signed params keep their sign', () => {
  it('a negative evolution is kept (catalog range symmetric), an opacity over 100 is clamped and said', async () => {
    const r = await runToolTurn('AI: snow', [
      { name: 'create_layer', args: { id: 'a', kind: 'adjustment', name: 'Snow' } },
      { name: 'add_effect', args: { nodeId: 'a', type: 'snowfall', id: 'snow', params: { evolution: -90, wind: -40, opacity: 150 } } },
      { name: 'update_effect_param', args: { nodeId: 'a', effectId: 'snow', key: 'evolution', value: -50 } },
      { name: 'update_effect_param', args: { nodeId: 'a', effectId: 'snow', key: 'wind', value: 30 } },
      { name: 'update_effect_param', args: { nodeId: 'a', effectId: 'snow', key: 'opacity', value: 140 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const [, added, kept, plain, clamped] = r.results;
    expect(added!.content).toMatch(/opacity was clamped from 150 to 100/i);
    expect(added!.content).not.toMatch(/evolution was clamped/i);
    expect(added!.content).not.toMatch(/wind was clamped/i);
    expect(kept!.content).not.toMatch(/clamped/i);
    expect(plain!.content).not.toMatch(/clamped/i);
    expect(clamped!.content).toMatch(/clamped/i);
    expect(clamped!.content).toMatch(/140/);
    await settleEdits();
    const id = idNamed('Snow');
    expect(await value(id, 'effects/snow/evolution')).toBe(-50);
    expect(await value(id, 'effects/snow/wind')).toBe(30);
    expect(await value(id, 'effects/snow/opacity')).toBe(100);
  });
});
