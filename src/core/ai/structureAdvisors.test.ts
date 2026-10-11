/**
 * The structural advisors (docs/PROGRAM_3D_PERF_UX.md M2), against the shape
 * of the owner's duplicated comp — and against the false positives that would
 * make the model dismantle a correct build: one copy of a script, cameras
 * cut back to back, a grade and a grain stacked on purpose.
 */

import { beatNameOfRoot, overlapRanges, structureWarnings, type StructureLayer } from './structureAdvisors';

let seq = 0;
const layer = (p: Partial<StructureLayer> & { name: string }): StructureLayer => ({
  id: p.id ?? `l${++seq}`,
  kind: 'shape',
  parent: null,
  visible: true,
  inSec: 0,
  outSec: 10,
  ...p,
});

describe('beatNameOfRoot', () => {
  it('reads the beat name compileScript puts on a root, and nothing else', () => {
    expect(beatNameOfRoot('Beat 1 — Cold open')).toBe('Cold open');
    expect(beatNameOfRoot('Beat 12 — The — dash')).toBe('The — dash');
    expect(beatNameOfRoot('Cold open')).toBeNull();
    expect(beatNameOfRoot('Beat 1')).toBeNull();
  });
});

describe('overlapRanges', () => {
  it('reports the maximal ranges with at least `min` bars live, half-open', () => {
    const r = overlapRanges([
      { id: 'a', inSec: 0, outSec: 4 },
      { id: 'b', inSec: 2, outSec: 6 },
      { id: 'c', inSec: 4, outSec: 8 },
    ], 2);
    expect(r).toEqual([
      { start: 2, end: 4, ids: ['a', 'b'] },
      { start: 4, end: 6, ids: ['b', 'c'] },
    ]);
    expect(overlapRanges([{ id: 'a', inSec: 0, outSec: 4 }, { id: 'b', inSec: 4, outSec: 8 }], 2)).toEqual([]);
  });

  it('merges adjacent segments of the same set', () => {
    const r = overlapRanges([
      { id: 'a', inSec: 0, outSec: 10 },
      { id: 'b', inSec: 0, outSec: 10 },
      { id: 'c', inSec: 3, outSec: 3 }, // zero-length: ignored
    ], 2);
    expect(r).toEqual([{ start: 0, end: 10, ids: ['a', 'b'] }]);
  });
});

describe('structureWarnings', () => {
  it('flags a script built twice: duplicate beat roots and two Front globals roots', () => {
    const w = structureWarnings([
      layer({ id: 'r1', name: 'Beat 1 — Cold open', kind: 'null' }),
      layer({ id: 'r2', name: 'Beat 2 — Reveal', kind: 'null' }),
      layer({ id: 'r3', name: 'Beat 1 — Cold open', kind: 'null' }),
      layer({ id: 'r4', name: 'Beat 2 — Reveal', kind: 'null' }),
      layer({ id: 'f1', name: 'Front globals', kind: 'null' }),
      layer({ id: 'f2', name: 'Front globals', kind: 'null' }),
      layer({ id: 'k1', name: 'Headline', kind: 'text', parent: 'r1' }),
      layer({ id: 'k2', name: 'Headline', kind: 'text', parent: 'r3' }),
    ]);
    const dupes = w.filter((x) => x.kind === 'duplicate-beat');
    expect(dupes.map((x) => x.nodeIds)).toEqual([['r1', 'r3'], ['r2', 'r4'], ['f1', 'f2']]);
    expect(dupes[0]!.message).toMatch(/Beat "Cold open" exists 2 times/);
    expect(dupes[2]!.message).toMatch(/Front globals/);
  });

  it('does not flag one copy of a script, however many beats it has', () => {
    const w = structureWarnings([
      layer({ name: 'Beat 1 — Cold open', kind: 'null' }),
      layer({ name: 'Beat 2 — Reveal', kind: 'null' }),
      layer({ name: 'Beat 3 — Cold open again', kind: 'null' }),
      layer({ name: 'Front globals', kind: 'null' }),
      layer({ name: 'Backdrop', kind: 'shape' }),
      layer({ name: 'Backdrop', kind: 'shape' }), // two plain layers with one name are not a beat
    ]);
    expect(w).toEqual([]);
  });

  it('flags cameras live at the same time, per range, and not cameras cut back to back', () => {
    const w = structureWarnings([
      layer({ id: 'c1', name: 'Cam 1', kind: 'camera', inSec: 0, outSec: 4 }),
      layer({ id: 'c2', name: 'Cam 2', kind: 'camera', inSec: 4, outSec: 8 }),
      layer({ id: 'c3', name: 'Cam 2 copy', kind: 'camera', inSec: 4, outSec: 8 }),
      layer({ id: 'c4', name: 'Hidden', kind: 'camera', inSec: 0, outSec: 8, visible: false }),
    ]);
    expect(w.map((x) => x.kind)).toEqual(['cameras-live']);
    expect(w[0]!.nodeIds).toEqual(['c2', 'c3']);
    expect(w[0]!.message).toMatch(/2 cameras are live at 4–8s/);
    expect(structureWarnings([
      layer({ name: 'Cam 1', kind: 'camera', inSec: 0, outSec: 4 }),
      layer({ name: 'Cam 2', kind: 'camera', inSec: 4, outSec: 8 }),
    ])).toEqual([]);
  });

  it('flags three adjustment layers stacked, and a duplicated one, with the count per range', () => {
    const three = structureWarnings([
      layer({ id: 'a1', name: 'Grade', kind: 'adjustment', inSec: 0, outSec: 20 }),
      layer({ id: 'a2', name: 'Grain', kind: 'adjustment', inSec: 0, outSec: 20 }),
      layer({ id: 'a3', name: 'Vignette', kind: 'adjustment', inSec: 5, outSec: 15 }),
    ]);
    expect(three.map((x) => x.kind)).toEqual(['adjustment-stack']);
    expect(three[0]!.message).toMatch(/3 adjustment layers are active at 5–15s \(3 full-frame passes stacked\)/);

    const dupe = structureWarnings([
      layer({ id: 'a1', name: 'Rainfall', kind: 'adjustment', inSec: 0, outSec: 20 }),
      layer({ id: 'a2', name: 'Rainfall', kind: 'adjustment', inSec: 0, outSec: 20 }),
    ]);
    expect(dupe.map((x) => x.kind)).toEqual(['adjustment-stack']);
    expect(dupe[0]!.message).toMatch(/"Rainfall" is applied more than once/);
  });

  it('does not flag two different adjustment layers at once (a grade and a grain), nor hidden ones', () => {
    expect(structureWarnings([
      layer({ name: 'Grade', kind: 'adjustment' }),
      layer({ name: 'Grain', kind: 'adjustment' }),
      layer({ name: 'Grain', kind: 'adjustment', visible: false }),
    ])).toEqual([]);
  });
});
