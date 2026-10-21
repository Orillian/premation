/**
 * Repro (2026-10-10): a 3D stacked-repeater "lattice" vanishes as the camera
 * moves in. GPU only: PREMATION_GPU_TESTS=1.
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;

const DEPTHS = [-2666, -2000, -1500, -1000, -500, 0, 500];

suite('a 3D layer as the camera moves in', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(20) } } as Command);
    await settleEdits();
  }, 60_000);
  afterEach(async () => { await h.dispose(); });

  async function lit(t: number): Promise<number> {
    const th = await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: 640 });
    const png = PNG.sync.read(Buffer.from(th.data));
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i]! > 80) n++;
    return n;
  }

  async function sweep(calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<number[]> {
    const r = await runToolTurn('AI: repro', [
      ...calls,
      { name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Camera' } },
      { name: 'set_keyframes', args: { keyframes: DEPTHS.map((z, i) => ({ nodeId: 'cam', prop: 'z', t: i, value: z, easing: 'hold' })) } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const out: number[] = [];
    for (let i = 0; i < DEPTHS.length; i++) out.push(await lit(i + 0.5));
    return out;
  }

  const cases: Array<[string, Array<{ name: string; args: Record<string, unknown> }>]> = [
    ['lattice off-centre origin', [
      { name: 'create_layer', args: { id: 'l', kind: 'shape', shape: 'ellipse', name: 'L', width: 5, height: 5, x: -1290, y: -810, fill: '#ece8df' } },
      { name: 'update_layer', args: { nodeId: 'l', threeD: true, z: 1400 } },
      { name: 'add_repeater', args: { nodeId: 'l', copies: 31, positionX: 150, rotation: 0 } },
      { name: 'add_repeater', args: { nodeId: 'l', copies: 19, positionY: 150, rotation: 0 } },
    ]],
    ['small lattice centred', [
      { name: 'create_layer', args: { id: 'l', kind: 'shape', shape: 'ellipse', name: 'L', width: 5, height: 5, x: 760, y: 440, fill: '#ece8df' } },
      { name: 'update_layer', args: { nodeId: 'l', threeD: true, z: 1400 } },
      { name: 'add_repeater', args: { nodeId: 'l', copies: 5, positionX: 100, rotation: 0 } },
      { name: 'add_repeater', args: { nodeId: 'l', copies: 3, positionY: 100, rotation: 0 } },
    ]],
    // The lattice's footprint as one layer. Filled: Fill Opacity 0 (AE Blending
    // Options) fades a shape's stroke with its fill, and this rect's edges
    // project outside the frame at every depth, so an outline alone shows nothing.
    ['big rect, no repeater', [
      { name: 'create_layer', args: { id: 'l', kind: 'shape', shape: 'rect', name: 'L', width: 4500, height: 2700, fill: '#ece8df' } },
      { name: 'update_layer', args: { nodeId: 'l', threeD: true, z: 1400, stroke: '#ffffff', strokeWidth: 6 } },
    ]],
  ];

  it.each(cases)('%s', async (_name, calls) => {
    const seen = await sweep(calls);
    // eslint-disable-next-line no-console
    console.log(_name, JSON.stringify(seen));
    for (const v of seen) expect(v).toBeGreaterThan(5);
  }, 240_000);
});
