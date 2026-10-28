/**
 * Which rows stay pinned while you scroll inside an expanded layer: the LAYER
 * row itself, and under it the group heading you are in.
 *
 * Expand a text layer with an animator, two layer styles and three effects and
 * its name is the first thing off the top of the panel. What is left is forty
 * rows called "Opacity" and "Size" with nothing saying which layer — or which
 * of its groups — they belong to. After Effects leaves you there; this pins
 * the two answers, the way a file browser pins the folder you are inside.
 *
 * The rows are ABSOLUTELY POSITIONED in a virtualized list, so `position:
 * sticky` cannot do this: sticky needs the element to be in flow inside a
 * scrolling ancestor, and a virtualized row is neither (it is also unmounted
 * the moment it leaves the window, which is precisely when it would need to
 * stick). The answer is to render one extra copy of each, pinned, and to
 * compute which rows they show — which is what this does.
 *
 * ## The stack
 *
 * Slot 0 is the layer, slot 1 the group. Never deeper: a third pinned row
 * would eat a tenth of a short panel, so a nested group (Effects ▸ Glow)
 * names its parent in the label instead of pinning it.
 *
 * ## The push-off
 *
 * When the next section arrives the pinned rows do not swap in place: they are
 * pushed up by the incoming row, the way a real sticky header behaves. The
 * next group pushes the group; the next LAYER pushes both, the group sliding
 * under the layer row first. `offset` is how far up (0 or negative).
 */

/** The minimum this module needs to know about a row. */
export interface StickyRow {
  type: 'track' | 'category' | 'prop';
  /** Only set for `category` rows. */
  categoryKey?: string;
}

export interface StickyPin {
  /** Index into the flattened row list of the row to pin. */
  index: number;
  /** Pixels to shift it up while the next section pushes it off. 0 or negative. */
  offset: number;
}

export interface StickyStack {
  /** Slot 0: the layer whose rows are at the top of the list. */
  track: StickyPin | null;
  /** Slot 1: the group heading of the first row under the pinned layer. */
  category: StickyPin | null;
}

const NONE: StickyStack = { track: null, category: null };

/**
 * Slack for fractional scroll positions. On a 2.18× display the browser snaps
 * `scrollTop = 202` to 201.83, which put the row ABOVE the intended one under
 * the pinned layer — and pinned that row's group over a heading sitting in
 * plain view. Under a pixel is never a row the user meant.
 */
const SUBPIXEL = 1;

/**
 * The rows to pin for a given scroll position.
 *
 * `scrollTop` is measured from the top of the row list (i.e. the caller has
 * already subtracted its top padding). `rowHeight` is uniform, which the
 * timeline guarantees — every row in this list is `trackHeight` tall.
 *
 * Nothing is pinned while a layer row is itself fully in view, and nothing for
 * a collapsed layer: its own row is all of its section, so a pinned copy would
 * only repeat it.
 */
export function stickyStackFor(
  rows: ReadonlyArray<StickyRow>,
  scrollTop: number,
  rowHeight: number,
): StickyStack {
  if (rowHeight <= 0 || rows.length === 0 || scrollTop <= 0) return NONE;
  const first = Math.floor(scrollTop / rowHeight);
  if (first >= rows.length) return NONE;

  // The layer whose section the top of the list is in.
  let t = first;
  while (t >= 0 && rows[t]!.type !== 'track') t--;
  if (t < 0) return NONE;
  let end = t + 1;
  while (end < rows.length && rows[end]!.type !== 'track') end++;
  if (end === t + 1) return NONE;

  // The next layer pushes this one off as it arrives.
  const sectionLeft = end * rowHeight - scrollTop;
  const track: StickyPin = { index: t, offset: Math.min(0, sectionLeft - rowHeight) };

  // The group of the first row the pinned layer does not cover.
  const below = scrollTop + rowHeight;
  const under = Math.floor((below + SUBPIXEL) / rowHeight);
  let category: StickyPin | null = null;
  if (under < end) {
    let c = under;
    while (c > t && rows[c]!.type !== 'category') c--;
    // `c * rowHeight < below`: the heading is under the pinned layer (or
    // above it). A heading fully in view on its own needs no copy.
    if (c > t && c * rowHeight < below) {
      let next = c + 1;
      while (next < end && rows[next]!.type !== 'category') next++;
      const offset = Math.min(0, next * rowHeight - below - rowHeight);
      // Pushed all the way under the layer row: nothing of it is left to show.
      if (offset > -rowHeight) category = { index: c, offset };
    }
  }
  return { track, category };
}
