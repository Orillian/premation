/**
 * Techniques move x/y as offsets from rest; the keyframe tools take absolute
 * positions. absolutizePositions is the bridge — without it every cast
 * entrance sent its text to the frame's top edge.
 */

import { absolutizePositions } from './emit';
import { technique } from './registry';
import { coerceParams } from './schema';
import { resolvePack } from '@motion/design-system';

describe('absolutizePositions', () => {
  it('anchors x/y keyframes and springs on the rest position, and leaves other props alone', () => {
    const out = absolutizePositions([
      { name: 'set_keyframes', args: { keyframes: [
        { nodeId: 'h', prop: 'y', t: 0, value: 26 },
        { nodeId: 'h', prop: 'y', t: 1, value: 0 },
        { nodeId: 'h', prop: 'opacity', t: 0, value: 0 },
        { nodeId: 'h', prop: 'scale', t: 0, value: 0.96 },
      ] } },
      { name: 'set_spring', args: { nodeId: 'h', prop: 'x', from: -40, to: 0 } },
    ], (id) => (id === 'h' ? { x: 960, y: 400 } : undefined));
    const kf = out[0]!.args.keyframes as Array<{ prop: string; value: number }>;
    expect(kf.map((k) => k.value)).toEqual([426, 400, 0, 0.96]);
    expect(out[1]!.args).toMatchObject({ from: 920, to: 960 });
  });

  it('rests a layer the technique creates where it created it, and skips unknown layers', () => {
    const out = absolutizePositions([
      { name: 'create_layer', args: { id: 'helper', kind: 'shape', x: 100, y: 200 } },
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: 'helper', prop: 'x', t: 0, value: 10 }, { nodeId: 'ghost', prop: 'y', t: 0, value: 5 }] } },
    ], () => undefined);
    expect((out[1]!.args.keyframes as Array<{ value: number }>).map((k) => k.value)).toEqual([110, 5]);
  });

  it('turns a real entrance into motion around the layer, not toward the frame edge', () => {
    const t = technique('entrance.rise_settle')!;
    const calls = absolutizePositions(
      t.emit({ startMs: 0, durationMs: 1200, frameMs: 1000 / 30, width: 1920, height: 1080, pack: resolvePack('apple_keynote') as never, targets: { headline: ['h'] }, idPrefix: 'x' }, coerceParams(t.params, {}).value, 0),
      () => ({ x: 960, y: 540 }),
    );
    const ys = calls.flatMap((c) => (c.name === 'set_keyframes' ? (c.args.keyframes as Array<{ prop: string; value: number }>) : []))
      .filter((k) => k.prop === 'y').map((k) => k.value);
    expect(ys.length).toBeGreaterThan(1);
    expect(ys.at(-1)).toBe(540);
    for (const y of ys) expect(Math.abs(y - 540)).toBeLessThan(120);
  });
});
