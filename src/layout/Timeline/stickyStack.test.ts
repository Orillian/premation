/**
 * Which rows stay pinned while you scroll inside a layer.
 *
 * The ways this goes wrong are all silent: pinning a row for rows that are NOT
 * on screen (a label describing something else), never handing over to the
 * next section (a heading that outstays the rows it names), and pinning a copy
 * of a row that is already in view. Each is one comparison away from correct
 * and none shows up in a screenshot of a stationary panel.
 */

import { stickyStackFor, type StickyRow } from './stickyStack';

const H = 20;

/** 0 track · 1 category · 2 prop · 3 prop · 4 category · 5 prop · 6 prop · 7 track */
const ROWS: StickyRow[] = [
  { type: 'track' },
  { type: 'category', categoryKey: 'transform' },
  { type: 'prop' },
  { type: 'prop' },
  { type: 'category', categoryKey: 'effects' },
  { type: 'prop' },
  { type: 'prop' },
  { type: 'track' },
];

describe('stickyStackFor', () => {
  it('pins nothing while the layer row itself is in view', () => {
    expect(stickyStackFor(ROWS, 0, H)).toEqual({ track: null, category: null });
  });

  it('pins the layer as soon as its row starts to scroll off', () => {
    const s = stickyStackFor(ROWS, 1, H);
    expect(s.track).toEqual({ index: 0, offset: 0 });
  });

  it('pins the group under the layer once that heading is covered', () => {
    // Heading 1 is fully in view under the pinned layer at scrollTop 0+…
    expect(stickyStackFor(ROWS, 0.5 * H, H).category).toEqual({ index: 1, offset: 0 });
    // …and stays pinned while its props are what is under the layer row.
    expect(stickyStackFor(ROWS, 2 * H, H).category?.index).toBe(1);
  });

  it('hands the group slot to the next heading', () => {
    expect(stickyStackFor(ROWS, 4 * H, H).category?.index).toBe(4);
  });

  it('pushes the outgoing group up as the next one arrives', () => {
    // A third of a row before heading 4 reaches slot 1.
    const s = stickyStackFor(ROWS, 3 * H - Math.round(H / 3), H);
    expect(s.category?.index).toBe(1);
    expect(s.category!.offset).toBeLessThan(0);
    expect(s.category!.offset).toBeGreaterThan(-H);
    expect(s.track!.offset).toBe(0);
  });

  it('lets the next layer push the whole stack off', () => {
    // Half a row before the next layer reaches the top.
    const s = stickyStackFor(ROWS, 6.5 * H, H);
    expect(s.track).toEqual({ index: 0, offset: -H / 2 });
    // The group has already slid all the way under the layer row.
    expect(s.category).toBeNull();
  });

  it('ignores a sub-pixel scroll short of a heading', () => {
    // The browser snapped a scroll to "heading 4 under the layer row" a
    // fraction of a pixel short (a 2.18x display). Heading 4 is in plain view
    // in slot 1 — pinning heading 1's copy over it would hide it.
    expect(stickyStackFor(ROWS, 3 * H - 0.17, H).category).toBeNull();
  });

  it('pins nothing for a collapsed layer', () => {
    const rows: StickyRow[] = [{ type: 'track' }, { type: 'track' }, { type: 'track' }];
    expect(stickyStackFor(rows, 1.5 * H, H)).toEqual({ track: null, category: null });
  });

  it('pins the layer alone when its rows have no group heading', () => {
    const rows: StickyRow[] = [{ type: 'track' }, { type: 'prop' }, { type: 'prop' }, { type: 'prop' }];
    expect(stickyStackFor(rows, 1.5 * H, H)).toEqual({ track: { index: 0, offset: 0 }, category: null });
  });

  it('never pins another layer’s group', () => {
    const rows: StickyRow[] = [
      { type: 'track' },
      { type: 'category', categoryKey: 'transform' },
      { type: 'prop' },
      { type: 'track' },
      { type: 'prop' },
      { type: 'prop' },
    ];
    // Row 4 belongs to the SECOND layer, which has no heading of its own.
    const s = stickyStackFor(rows, 3.5 * H, H);
    expect(s.track?.index).toBe(3);
    expect(s.category).toBeNull();
  });

  it('is defensive about degenerate input rather than dividing by zero', () => {
    const none = { track: null, category: null };
    expect(stickyStackFor([], 100, H)).toEqual(none);
    expect(stickyStackFor(ROWS, 100, 0)).toEqual(none);
    expect(stickyStackFor(ROWS, -50, H)).toEqual(none);
    expect(stickyStackFor(ROWS, 9999, H)).toEqual(none);
  });
});
