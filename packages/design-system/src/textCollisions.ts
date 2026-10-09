/**
 * Text that collides is the loudest amateur signal there is, and the layout
 * templates produced it: they space an overline above a headline by a fixed
 * number of baseline rows, and text is positioned by its CENTRE — so once type
 * was sized for video (baseSizeFor), a 135px display line swallowed the
 * overline four rows above it ("INTRODUCING" printed across "Nova", found
 * 2026-10-08 rendering a cast piece). Re-tuning ~30 hand-picked offsets would
 * break again the next time a size changes; this pass fixes the outcome.
 *
 * After a template composes, every text box is measured from its own type
 * (size × line height). Lines a template broke itself (`headline_0`,
 * `headline_1`, …) are one BLOCK: they never collide with each other and move
 * together. Any two blocks that overlap — or sit closer than a breathing gap —
 * in the same horizontal span are separated: the block with the SMALLER type
 * moves away (an overline lifts off its headline, a caption drops below its
 * title), so the hero keeps the position the layout chose. Moves snap to the
 * baseline grid in the moving direction.
 *
 * Pure: calls in, calls out. Measurement is an estimate (no font metrics
 * here), deliberately generous so the result errs toward air, never overlap.
 */

import type { ToolCall } from './toolcall';
import type { GridSpec } from './grid';

/** Average glyph advance as a fraction of the font size (generous for display caps). */
const ADVANCE = 0.56;

export interface TextBox {
  id: string;
  /** Lines a template broke itself share a block: `t0_headline_0`, `t0_headline_1` → `t0_headline`. */
  block: string;
  /** Index of the create_layer call, to rewrite its y. */
  call: number;
  left: number;
  right: number;
  /** Centre y. */
  y: number;
  height: number;
  size: number;
}

const blockOf = (id: string): string => id.replace(/_\d+$/, '');

/** Measure every text layer the calls create. */
export function textBoxes(calls: readonly ToolCall[]): TextBox[] {
  const made = new Map<string, { call: number; x: number; y: number; text: string }>();
  const style = new Map<string, { size?: number; lineHeight?: number; width?: number; align?: string }>();
  calls.forEach((c, i) => {
    const a = c.args;
    if (c.name === 'create_layer' && a.kind === 'text' && typeof a.id === 'string') {
      made.set(a.id, { call: i, x: Number(a.x ?? 0), y: Number(a.y ?? 0), text: String(a.text ?? '') });
    } else if (c.name === 'update_layer' && typeof a.nodeId === 'string') {
      const s = style.get(a.nodeId) ?? {};
      if (typeof a.fontSize === 'number') s.size = a.fontSize;
      if (typeof a.lineHeight === 'number') s.lineHeight = a.lineHeight;
      if (typeof a.width === 'number') s.width = a.width;
      if (typeof a.align === 'string') s.align = a.align;
      style.set(a.nodeId, s);
    }
  });
  const blockSizes = new Map<string, number>();
  for (const id of made.keys()) blockSizes.set(blockOf(id), (blockSizes.get(blockOf(id)) ?? 0) + 1);
  const out: TextBox[] = [];
  for (const [id, m] of made) {
    const s = style.get(id) ?? {};
    const size = s.size ?? 32;
    const natural = Math.max(size, m.text.length * size * ADVANCE);
    const boxW = s.width ?? natural;
    // A line the template already broke is one line; free text may wrap.
    const preBroken = /_\d+$/.test(id) && (blockSizes.get(blockOf(id)) ?? 0) > 1;
    // A template that broke the text itself (layers per line, or `\n`) knows
    // its lines; only unbroken text is estimated for wrapping.
    const lines = preBroken
      ? 1
      : m.text.includes('\n')
        ? m.text.split('\n').length
        : Math.max(1, Math.ceil(natural / Math.max(1, boxW)));
    const inkW = Math.min(boxW, natural);
    const height = lines * size * (s.lineHeight ?? 1.2);
    const half = boxW / 2;
    const [left, right] = s.align === 'left'
      ? [m.x - half, m.x - half + inkW]
      : s.align === 'right'
        ? [m.x + half - inkW, m.x + half]
        : [m.x - inkW / 2, m.x + inkW / 2];
    out.push({ id, block: id, call: m.call, left, right, y: m.y, height, size });
  }
  // A block is lines of ONE broken text: same prefix, same column, each about a
  // line apart. Same-prefix boxes far apart are separate items (the titles of
  // three stacked cards), not one headline.
  const sorted = [...out].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = sorted.slice(0, i).reverse().find((p) =>
      blockOf(p.id) === blockOf(cur.id) && p.id !== cur.id && /_\d+$/.test(cur.id) &&
      Math.abs(p.left - cur.left) <= 2 + Math.abs(p.right - p.left - (cur.right - cur.left)) &&
      cur.y - p.y <= Math.max(p.size, cur.size) * 1.7);
    if (prev) {
      const from = cur.block;
      for (const x of out) if (x.block === from) x.block = prev.block;
    }
  }
  return out;
}

// Air between blocks: enough that an overline reads as ITS headline's label,
// not so much that a list title and its body come apart.
const gapFor = (a: TextBox, b: TextBox, g: GridSpec): number => Math.max(Math.round(g.baseline / 2), Math.round(Math.min(a.size, b.size) * 0.15));

/** Pairs of text boxes from different blocks that overlap (or crowd) in the same span; upper first. */
export function textCollisions(boxes: readonly TextBox[], g: GridSpec): Array<[TextBox, TextBox]> {
  const out: Array<[TextBox, TextBox]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i]!.block === boxes[j]!.block) continue;
      const [a, b] = boxes[i]!.y <= boxes[j]!.y ? [boxes[i]!, boxes[j]!] : [boxes[j]!, boxes[i]!];
      const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (horizontal <= 0) continue;
      const aBottom = a.y + a.height / 2;
      const bTop = b.y - b.height / 2;
      if (bTop - aBottom < gapFor(a, b, g) - 0.5) out.push([a, b]);
    }
  }
  return out;
}

const snapUp = (g: GridSpec, y: number): number => g.margin + Math.ceil((y - g.margin) / g.baseline - 1e-9) * g.baseline;
const snapDown = (g: GridSpec, y: number): number => g.margin + Math.floor((y - g.margin) / g.baseline + 1e-9) * g.baseline;

/** Separate colliding text; the block with the smaller type moves, whole. */
export function resolveTextCollisions(calls: readonly ToolCall[], g: GridSpec): ToolCall[] {
  const boxes = textBoxes(calls);
  if (boxes.length < 2) return [...calls];
  const blockSize = (block: string): number => Math.max(...boxes.filter((x) => x.block === block).map((x) => x.size));
  for (let pass = 0; pass < 200; pass++) {
    const hits = textCollisions(boxes, g);
    if (hits.length === 0) break;
    const [a, b] = hits[0]!;
    const need = a.y + a.height / 2 + gapFor(a, b, g) - (b.y - b.height / 2);
    // The smaller block moves; on a tie the lower one does.
    const moveUp = blockSize(a.block) < blockSize(b.block);
    const mover = moveUp ? a : b;
    const target = moveUp ? snapDown(g, mover.y - need) : snapUp(g, mover.y + need);
    const delta = target - mover.y;
    if (moveUp) {
      for (const x of boxes) if (x.block === mover.block) x.y += delta;
    } else {
      // Pushing down carries everything under it that shares its column, so a
      // stack (title over caption, card over card) keeps its order instead of
      // the title jumping below its own caption.
      const from = mover.y - mover.height / 2;
      const span = { left: Math.min(...boxes.filter((x) => x.block === mover.block).map((x) => x.left)), right: Math.max(...boxes.filter((x) => x.block === mover.block).map((x) => x.right)) };
      for (const x of boxes) {
        const below = x.block === mover.block || (x.y - x.height / 2 >= from - 0.5 && Math.min(x.right, span.right) - Math.max(x.left, span.left) > 0);
        if (below && x.block !== a.block) x.y += delta;
      }
    }
  }
  const moved = new Map(boxes.map((b) => [b.call, b.y]));
  return calls.map((c, i) => {
    const y = moved.get(i);
    if (y === undefined || c.args.y === y) return c;
    return { ...c, args: { ...c.args, y } };
  });
}
