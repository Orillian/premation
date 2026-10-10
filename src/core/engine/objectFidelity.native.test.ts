/**
 * Objects render the way they were added (docs/PROGRAM_PERFORMANCE.md S4–S6),
 * found by the 2026-10-10 object probe:
 *   S4  a glow's faint tail was cut at a hard contour on a dark ground — every
 *       composite shader zeroed texels with alpha under 1/255, and the blur
 *       stopped at 2.5σ;
 *   S5  a `line` made by create_layer was a thin rectangle — stroked, two rails;
 *   S6  update_layer refused backdropBlur, a property it documents.
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

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 960;
const H = 540;

suite('objects render the way they were added', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(2) } } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  afterEach(async () => {
    const m = documentMirror();
    const ids = m.layerIds().filter((id) => m.layer(id)?.comp === activeCompRootId());
    if (ids.length) await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: ids } }]);
    await settleEdits();
  });

  async function frame(): Promise<PNG> {
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(0.5), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const blue = (p: PNG, x: number, y: number): number => p.data[(y * p.width + x) * 4 + 2]!;
  const bg = { name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#20232b' } };

  it('S4: a glow fades into a dark ground with no contour', async () => {
    const r = await runToolTurn('AI: glow', [bg,
      { name: 'create_layer', args: { id: 'bar', kind: 'shape', shape: 'rect', name: 'Bar', x: 690, y: 270, width: 360, height: 100, fill: '#4cc9f0' } },
      { name: 'apply_layer_style', args: { nodeId: 'bar', styleType: 'outer_glow', color: '#4cc9f0', size: 30, opacity: 0.9 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const p = await frame();
    // The faint tail (within 25 levels of the ground), outward to the frame's
    // edge: it falls off smoothly — the cut drew a 3-level jump at ~1% light.
    const ground = blue(p, 10, 10);
    for (const y of [120, 270]) {
      let x = 500;
      while (x > 20 && blue(p, x, y) > ground + 25) x--;
      let worst = 0;
      for (; x > 20; x--) worst = Math.max(worst, blue(p, x, y) - blue(p, x - 1, y));
      expect(worst).toBeLessThan(3);
    }
  }, 120_000);

  it('S5: a line is one stroke along its length, not a rectangle outline', async () => {
    const r = await runToolTurn('AI: line', [bg,
      { name: 'create_layer', args: { id: 'ln', kind: 'shape', shape: 'line', name: 'Line', x: 480, y: 270, width: 300, height: 20, fill: 'none' } },
      { name: 'update_layer', args: { nodeId: 'ln', stroke: '#ffffff', strokeWidth: 6 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const p = await frame();
    expect(blue(p, 480, 270)).toBeGreaterThan(200);   // the stroke runs through the middle
    expect(blue(p, 480, 280)).toBeLessThan(80);       // where the rectangle's bottom rail was
    expect(blue(p, 330, 270)).toBeGreaterThan(150);   // and reaches the end of the box
  }, 120_000);

  it('S6: update_layer takes backdropBlur', async () => {
    const r = await runToolTurn('AI: glass', [bg,
      { name: 'create_layer', args: { id: 'gl', kind: 'shape', shape: 'rect', name: 'Glass', x: 480, y: 270, width: 300, height: 200, fill: '#ffffff' } },
      { name: 'update_layer', args: { nodeId: 'gl', backdropBlur: 24, fillOpacity: 15 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const m = documentMirror();
    const id = m.layerIds().find((x) => m.layer(x)?.name === 'Glass')!;
    await m.loadTree(id);
    expect(m.tree(id)?.nodes.get('layer/backdropBlur')?.value).toMatchObject({ value: 24 });
  }, 120_000);
});
