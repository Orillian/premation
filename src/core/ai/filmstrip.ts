/**
 * The filmstrip — Phase 4.2.
 *
 * ## Why three stills cannot work
 *
 * The old critique pass rendered frames at 35%, 70% and the last frame. Timing,
 * spacing, easing, overshoot, flicker and pacing are all *differences between
 * adjacent frames*, and three samples an average of five seconds apart contain
 * none of that information. The most expensive stage of the loop was
 * structurally blind to the only dimension that mattered, and no amount of
 * prompt tuning fixes a missing signal.
 *
 * ## Two changes
 *
 * **Sample where things happen.** Keyframe times, not fixed percentages. A
 * 0.9-second light sweep on a 15-second composition falls entirely between a
 * 35% and a 70% sample; sampling at the keyframes means an event cannot be
 * missed, because its own endpoints are in the set.
 *
 * **Composite into one image.** 16–24 frames in a labelled grid. Frame spacing
 * in a strip *is* velocity, visually — a vision model can see acceleration in a
 * contact sheet that it cannot infer from three separate images, and one image
 * costs a fraction of what twenty attachments would.
 *
 * The velocity graphs are the other half: a critic can read "this curve is
 * linear" off a plotted line instantly and cannot read it off a still at all.
 */

import type { AiImage } from '@motion/ai-tools';
import type { ToolContext } from '@motion/ai-tools';
import { useCompositionStore } from '@stores/compositionStore';
import { engineCompStill } from '@core/engine/engineStill';
import type { RigView } from './rigTools';

/** Target frames in a strip. Enough to show a curve; few enough to stay legible. */
export const STRIP_MIN = 16;
export const STRIP_MAX = 24;

/** A render can hang in a backgrounded tab — never let it stall the run. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * Composition times to sample, clustered around keyframe events.
 *
 * Three sources, merged and thinned:
 *  1. **Every keyframe time**, so no event is missed;
 *  2. **The midpoint of every keyframe pair**, which is where the easing shows —
 *     the endpoints of an eased segment look the same whatever curve joins them;
 *  3. **A sparse uniform grid**, so long still passages are still represented and
 *     the reader can see that nothing is happening there.
 *
 * Thinned to `STRIP_MAX` by dropping the most closely-spaced samples first, so
 * a dense cluster loses members before an isolated event does.
 */
export async function filmstripTimes(ctx: ToolContext, durationSec: number): Promise<number[]> {
  const times = new Set<number>();
  const clamp = (t: number): number => Math.max(0, Math.min(durationSec, t));

  for (const node of await ctx.scene.all()) {
    for (const track of await ctx.anim.tracks(node.id)) {
      const kfs = track.keyframes;
      for (let i = 0; i < kfs.length; i++) {
        const t = kfs[i]!.t; // composition seconds
        times.add(Number(clamp(t).toFixed(3)));
        if (i > 0) {
          const prev = kfs[i - 1]!.t;
          times.add(Number(clamp((prev + t) / 2).toFixed(3)));
        }
      }
    }
  }

  // The sparse grid, plus the final held frame — a piece is judged partly on
  // where it comes to rest.
  const gridCount = 6;
  for (let i = 0; i < gridCount; i++) {
    times.add(Number(clamp((durationSec * i) / (gridCount - 1)).toFixed(3)));
  }

  const sorted = [...times].sort((a, b) => a - b);
  if (sorted.length <= STRIP_MAX) return sorted;

  // Thin by dropping whichever sample has the smallest gap to its neighbours.
  // Uniform decimation would drop half of a tight cluster AND half of an
  // isolated event; this drops from the cluster, where the redundancy is.
  const kept = [...sorted];
  while (kept.length > STRIP_MAX) {
    let worstIdx = 1;
    let worstGap = Infinity;
    for (let i = 1; i < kept.length - 1; i++) {
      const gap = kept[i + 1]! - kept[i - 1]!;
      if (gap < worstGap) {
        worstGap = gap;
        worstIdx = i;
      }
    }
    kept.splice(worstIdx, 1);
  }
  return kept;
}

// ── Compositing ───────────────────────────────────────────────────────

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; c2d: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c2d = canvas.getContext('2d');
  return c2d ? { canvas, c2d } : null;
}

function toImage(canvas: HTMLCanvasElement): AiImage | null {
  try {
    const url = canvas.toDataURL('image/jpeg', 0.82);
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    return { mediaType: 'image/jpeg', dataBase64: url.slice(comma + 1) };
  } catch {
    return null;
  }
}

/**
 * Render the times into one labelled contact sheet.
 *
 * Each cell carries its timestamp, because "the third frame" is not a thing a
 * critic can refer to usefully — "at 1.4s" is. Cells are laid out in reading
 * order and the sheet is capped at ~1600px wide so it survives the provider's
 * downscale with the labels still readable.
 */
export async function renderFilmstrip(timesSec: number[]): Promise<AiImage | null> {
  if (!timesSec.length) return null;
  try {
    const c = useCompositionStore.getState().comp();
    const lastFrame = Math.max(0, Math.round(c.durationSeconds * c.fps) - 1);

    const cols = timesSec.length <= 8 ? 4 : timesSec.length <= 15 ? 5 : 6;
    const rows = Math.ceil(timesSec.length / cols);
    const cellW = Math.floor(1600 / cols);
    const cellH = Math.round((cellW * c.height) / Math.max(1, c.width));
    const labelH = 18;
    const pad = 4;

    const made = makeCanvas(cols * (cellW + pad) + pad, rows * (cellH + labelH + pad) + pad);
    if (!made) return null;
    const { canvas, c2d } = made;

    // A mid-grey sheet, not black or white — a black sheet hides a dark
    // composition's edges and a white one hides a light composition's.
    c2d.fillStyle = '#2a2a2e';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.font = '12px system-ui, sans-serif';
    c2d.textBaseline = 'middle';

    let drawn = 0;
    for (const [i, t] of timesSec.entries()) {
      const frame = Math.max(0, Math.min(Math.round(t * c.fps), lastFrame));
      const blob = await withTimeout(engineCompStill(c.id, frame / c.fps, 800), 8000);
      if (!blob) continue;

      const bitmap = await withTimeout(createImageBitmap(blob), 4000);
      if (!bitmap) continue;

      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = pad + col * (cellW + pad);
      const y = pad + row * (cellH + labelH + pad);
      c2d.drawImage(bitmap, x, y, cellW, cellH);
      bitmap.close?.();

      c2d.fillStyle = '#cfcfd4';
      c2d.fillText(`${t.toFixed(2)}s`, x + 2, y + cellH + labelH / 2);
      drawn++;
    }

    // A sheet with one or two cells is not a filmstrip; it is a still with
    // decoration, and it would mislead the critic about what it is seeing.
    if (drawn < 3) return null;
    return toImage(canvas);
  } catch {
    return null;
  }
}

/**
 * A filmstrip of one time window — a beat — at `cells` evenly spaced frames,
 * the last one a frame short of the window's end (the end itself belongs to
 * the next beat).
 *
 * The whole-piece strip spends its cells around keyframe events, so a quiet
 * beat between two busy ones gets one cell or none. A critic asked to judge
 * beat 3 needs to SEE beat 3, which is what this gives it.
 */
export async function renderFilmstripWindow(startSec: number, endSec: number, cells = 8): Promise<AiImage | null> {
  if (!(endSec > startSec)) return null;
  const fps = useCompositionStore.getState().comp().fps || 30;
  const last = Math.max(startSec, endSec - 1 / fps);
  const n = Math.max(3, Math.min(STRIP_MAX, Math.round(cells)));
  const times = Array.from({ length: n }, (_, i) => startSec + ((last - startSec) * i) / (n - 1));
  return renderFilmstrip(times);
}

// ── Motion sheet (a close-up of one moment) ───────────────────────────

/** Trail colours: distinct on light and dark frames alike. */
const TRAIL_COLOURS = ['#ff5b2e', '#2ec4ff', '#ffd23f', '#7cff6b', '#ff4fd8', '#a78bff', '#ffffff', '#00e0b0'];

export interface MotionSheetInput {
  startSec: number;
  endSec: number;
  fps: number;
  compWidth: number;
  compHeight: number;
  /** Sample times of the trails, composition seconds. */
  times: readonly number[];
  /** Screen centres (comp px) per sample time, one per moving unit. */
  trails: readonly { name: string; points: readonly ({ x: number; y: number } | null)[] }[];
}

/**
 * Two images of one short window: every frame (or every Nth, up to 24) as a
 * contact sheet labelled with frame numbers, and an onion skin — up to 12 of
 * those frames averaged into one picture — with each moving unit's path drawn
 * over it, one dot per frame. Dot spacing IS speed: tight dots are slow, wide
 * dots fast, and an ease reads as dots bunching at one end.
 */
export async function renderMotionSheet(o: MotionSheetInput): Promise<AiImage[]> {
  const out: AiImage[] = [];
  try {
    const c = useCompositionStore.getState().comp();
    const fps = o.fps || c.fps || 30;
    const firstFrame = Math.round(o.startSec * fps);
    const lastFrame = Math.max(firstFrame, Math.min(Math.round(o.endSec * fps), Math.round(c.durationSeconds * fps) - 1));
    const total = lastFrame - firstFrame + 1;
    const every = Math.max(1, Math.ceil(total / STRIP_MAX));
    const frameNos: number[] = [];
    for (let f = firstFrame; f <= lastFrame; f += every) frameNos.push(f);

    const bitmaps: { frame: number; bitmap: ImageBitmap }[] = [];
    for (const f of frameNos) {
      const blob = await withTimeout(engineCompStill(c.id, f / fps, 800), 8000);
      if (!blob) continue;
      const bitmap = await withTimeout(createImageBitmap(blob), 4000);
      if (bitmap) bitmaps.push({ frame: f, bitmap });
    }
    if (bitmaps.length < 2) return out;

    // The strip.
    const cols = bitmaps.length <= 8 ? 4 : bitmaps.length <= 15 ? 5 : 6;
    const rows = Math.ceil(bitmaps.length / cols);
    const cellW = Math.floor(1600 / cols);
    const cellH = Math.round((cellW * c.height) / Math.max(1, c.width));
    const labelH = 18, pad = 4;
    const strip = makeCanvas(cols * (cellW + pad) + pad, rows * (cellH + labelH + pad) + pad);
    if (strip) {
      const { canvas, c2d } = strip;
      c2d.fillStyle = '#2a2a2e';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      c2d.font = '12px system-ui, sans-serif';
      c2d.textBaseline = 'middle';
      bitmaps.forEach(({ frame, bitmap }, i) => {
        const x = pad + (i % cols) * (cellW + pad);
        const y = pad + Math.floor(i / cols) * (cellH + labelH + pad);
        c2d.drawImage(bitmap, x, y, cellW, cellH);
        c2d.fillStyle = '#cfcfd4';
        c2d.fillText(`f${frame}  ${(frame / fps).toFixed(3)}s`, x + 2, y + cellH + labelH / 2);
      });
      const img = toImage(canvas);
      if (img) out.push(img);
    }

    // The onion skin: a running average, so every frame weighs the same.
    const W = 1280;
    const H = Math.round((W * o.compHeight) / Math.max(1, o.compWidth));
    const onion = makeCanvas(W, H + 28);
    if (onion) {
      const { canvas, c2d } = onion;
      c2d.fillStyle = '#111114';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      const skin = bitmaps.filter((_, i) => bitmaps.length <= 12 || i % Math.ceil(bitmaps.length / 12) === 0);
      skin.forEach(({ bitmap }, k) => {
        c2d.globalAlpha = 1 / (k + 1);
        c2d.drawImage(bitmap, 0, 0, W, H);
      });
      c2d.globalAlpha = 1;
      const sx = W / Math.max(1, o.compWidth), sy = H / Math.max(1, o.compHeight);
      c2d.font = '13px system-ui, sans-serif';
      c2d.lineWidth = 1.5;
      o.trails.forEach((trail, ti) => {
        const colour = TRAIL_COLOURS[ti % TRAIL_COLOURS.length]!;
        c2d.strokeStyle = colour;
        c2d.fillStyle = colour;
        c2d.beginPath();
        let open = false;
        for (const p of trail.points) {
          if (!p) { open = false; continue; }
          if (open) c2d.lineTo(p.x * sx, p.y * sy);
          else { c2d.moveTo(p.x * sx, p.y * sy); open = true; }
        }
        c2d.stroke();
        let last: { x: number; y: number } | null = null;
        for (const p of trail.points) {
          if (!p) continue;
          c2d.beginPath();
          c2d.arc(p.x * sx, p.y * sy, 2.6, 0, Math.PI * 2);
          c2d.fill();
          last = p;
        }
        if (last) c2d.fillText(trail.name.slice(0, 32), last.x * sx + 6, last.y * sy - 6);
      });
      c2d.fillStyle = '#cfcfd4';
      c2d.font = '12px system-ui, sans-serif';
      c2d.textBaseline = 'middle';
      c2d.fillText(`Onion skin of ${skin.length} frames, ${o.startSec.toFixed(2)}–${o.endSec.toFixed(2)}s. Dots: one per sample (${(o.times.length > 1 ? Math.round(((o.times[1]! - o.times[0]!) * fps)) : 1) || 1} frame) — wide spacing fast, tight spacing slow.`, 8, H + 14);
      const img = toImage(canvas);
      if (img) out.push(img);
    }
    for (const b of bitmaps) b.bitmap.close?.();
  } catch {
    // Best-effort: whatever was drawn before the failure goes back.
  }
  return out;
}

// ── Rig view ──────────────────────────────────────────────────────────

/**
 * The layer cropped from the real frame, with a grid labelled in its
 * LAYER-LOCAL pixels and the rig drawn on it (rigTools.ts `rigViewData`
 * computes everything; this only draws). Local → comp is the affine the
 * engine's own layer box and its comp corners define, so the grid is exactly
 * where a pin or a joint at those numbers lands.
 */
export async function renderRigView(view: RigView): Promise<AiImage | null> {
  try {
    const c = useCompositionStore.getState().comp();
    const fps = c.fps || 30;
    const frame = Math.max(0, Math.min(Math.round(view.time * fps), Math.round(c.durationSeconds * fps) - 1));
    const blob = await withTimeout(engineCompStill(c.id, frame / fps, 2048), 8000);
    if (!blob) return null;
    const bitmap = await withTimeout(createImageBitmap(blob), 4000);
    if (!bitmap) return null;
    const px = bitmap.width / Math.max(1, c.width); // image px per comp px
    const { crop } = view;
    const S = 1100 / Math.max(crop.width, crop.height); // canvas px per comp px
    const made = makeCanvas(Math.round(crop.width * S), Math.round(crop.height * S));
    if (!made) return null;
    const { canvas, c2d } = made;
    c2d.fillStyle = '#1a1a1e';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.drawImage(bitmap, crop.x * px, crop.y * px, crop.width * px, crop.height * px, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const { o, ex, ey } = view.affine;
    const toCanvas = (lx: number, ly: number): { x: number; y: number } => ({
      x: (o.x + lx * ex.x + ly * ey.x - crop.x) * S,
      y: (o.y + lx * ex.y + ly * ey.y - crop.y) * S,
    });
    const seg = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
      c2d.beginPath();
      c2d.moveTo(a.x, a.y);
      c2d.lineTo(b.x, b.y);
      c2d.stroke();
    };

    // The grid over the box (plus one step around it), labelled in layer px.
    const { box, gridStep: g } = view;
    const x0 = Math.floor((box.x - g) / g) * g, x1 = Math.ceil((box.x + box.width + g) / g) * g;
    const y0 = Math.floor((box.y - g) / g) * g, y1 = Math.ceil((box.y + box.height + g) / g) * g;
    c2d.font = '11px system-ui, sans-serif';
    c2d.lineWidth = 1;
    for (let x = x0; x <= x1 + 1e-6; x += g) {
      c2d.strokeStyle = Math.abs(x) < 1e-6 ? 'rgba(255,91,46,0.85)' : 'rgba(0,224,255,0.35)';
      seg(toCanvas(x, y0), toCanvas(x, y1));
      const p = toCanvas(x, y0);
      c2d.fillStyle = '#00e0ff';
      c2d.fillText(String(Math.round(x)), p.x + 2, Math.max(11, p.y + 11));
    }
    for (let y = y0; y <= y1 + 1e-6; y += g) {
      c2d.strokeStyle = Math.abs(y) < 1e-6 ? 'rgba(255,91,46,0.85)' : 'rgba(0,224,255,0.35)';
      seg(toCanvas(x0, y), toCanvas(x1, y));
      const p = toCanvas(x0, y);
      c2d.fillStyle = '#00e0ff';
      c2d.fillText(String(Math.round(y)), Math.max(2, p.x + 2), p.y - 2);
    }

    // Bones: a line root → tip, a dot at the root, the id at the middle.
    c2d.lineWidth = 3;
    c2d.font = '12px system-ui, sans-serif';
    for (const b of view.bones) {
      const r = toCanvas(b.root.x, b.root.y), t = toCanvas(b.tip.x, b.tip.y);
      c2d.strokeStyle = 'rgba(255,210,63,0.95)';
      seg(r, t);
      c2d.fillStyle = '#ffd23f';
      c2d.beginPath();
      c2d.arc(r.x, r.y, 4, 0, Math.PI * 2);
      c2d.fill();
      c2d.fillStyle = '#ffffff';
      c2d.fillText(b.id, (r.x + t.x) / 2 + 5, (r.y + t.y) / 2 - 4);
    }
    // IK goals: a crosshair; the pole as a hollow dot.
    c2d.lineWidth = 2;
    for (const k of view.ik) {
      const p = toCanvas(k.x, k.y);
      c2d.strokeStyle = k.mode === 'ik' ? '#ff4fd8' : '#a78bff';
      seg({ x: p.x - 8, y: p.y }, { x: p.x + 8, y: p.y });
      seg({ x: p.x, y: p.y - 8 }, { x: p.x, y: p.y + 8 });
      c2d.fillStyle = '#ff4fd8';
      c2d.fillText(`IK ${k.bone}`, p.x + 9, p.y + 14);
      if (k.pole) {
        const q = toCanvas(k.pole.x, k.pole.y);
        c2d.beginPath();
        c2d.arc(q.x, q.y, 5, 0, Math.PI * 2);
        c2d.stroke();
      }
    }
    // Pins.
    for (const pin of view.pins) {
      const p = toCanvas(pin.x, pin.y);
      c2d.fillStyle = '#7cff6b';
      c2d.beginPath();
      c2d.arc(p.x, p.y, 5, 0, Math.PI * 2);
      c2d.fill();
      c2d.fillText(`${pin.id} ${pin.name}`.slice(0, 28), p.x + 7, p.y - 6);
    }
    return toImage(canvas);
  } catch {
    return null;
  }
}

// ── Velocity graphs ───────────────────────────────────────────────────

export interface VelocityTrack {
  label: string;
  /** Sampled speed, value-units per second. */
  samples: number[];
}

/**
 * Sample the SPEED of the hero properties over time.
 *
 * Speed rather than value, because value is what a still already shows and speed
 * is what it cannot. A flat speed plateau is linear easing; a speed curve that
 * rises and falls smoothly is an eased move; a speed spike is a pop. All three
 * are instantly legible on a plot and invisible in a frame.
 */
export async function sampleVelocities(
  ctx: ToolContext,
  durationSec: number,
  o: { maxTracks?: number; samples?: number } = {},
): Promise<VelocityTrack[]> {
  const sampleCount = o.samples ?? 120;
  const maxTracks = o.maxTracks ?? 6;
  const HERO_PROPS = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'z']);

  const candidates: { label: string; nodeId: string; prop: string; range: number }[] = [];
  for (const node of await ctx.scene.all()) {
    for (const track of await ctx.anim.tracks(node.id)) {
      if (!HERO_PROPS.has(track.prop) || track.keyframes.length < 2) continue;
      const values = track.keyframes.map((k) => k.value);
      const range = Math.max(...values) - Math.min(...values);
      if (range <= 0) continue;
      candidates.push({ label: `${node.name}.${track.prop}`, nodeId: node.id, prop: track.prop, range });
    }
  }
  // The tracks that MOVE most, since a graph of a 2px drift tells nobody
  // anything and crowds out the one that matters.
  candidates.sort((a, b) => b.range - a.range);

  const dt = durationSec / Math.max(1, sampleCount - 1);
  const out: VelocityTrack[] = [];
  for (const c of candidates.slice(0, maxTracks)) {
    const samples: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const t = i * dt;
      const a = (await ctx.anim.evaluate(c.nodeId, Math.max(0, t - dt / 2)))[c.prop] ?? 0;
      const b = (await ctx.anim.evaluate(c.nodeId, Math.min(durationSec, t + dt / 2)))[c.prop] ?? 0;
      samples.push(Math.abs(b - a) / Math.max(1e-6, dt));
    }
    out.push({ label: c.label, samples });
  }
  return out;
}

/**
 * Plot the velocity tracks as one image.
 *
 * Each track is normalised to its own peak — the question is the SHAPE of the
 * curve, not how it compares to a different property in different units, and
 * sharing one axis would flatten every curve but the largest into a line.
 */
export function renderVelocityGraphs(tracks: readonly VelocityTrack[], durationSec: number): AiImage | null {
  if (!tracks.length) return null;
  const rowH = 76;
  const width = 900;
  const padL = 130;
  const made = makeCanvas(width, tracks.length * rowH + 24);
  if (!made) return null;
  const { canvas, c2d } = made;

  c2d.fillStyle = '#1c1c20';
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  c2d.font = '12px system-ui, sans-serif';
  c2d.textBaseline = 'middle';

  tracks.forEach((track, i) => {
    const top = 12 + i * rowH;
    const h = rowH - 22;
    const plotW = width - padL - 16;

    c2d.fillStyle = '#8a8a92';
    c2d.fillText(track.label.slice(0, 22), 8, top + h / 2);

    // Baseline, so a flat curve is visibly flat AT zero rather than just flat.
    c2d.strokeStyle = '#3a3a42';
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(padL, top + h);
    c2d.lineTo(padL + plotW, top + h);
    c2d.stroke();

    const peak = Math.max(...track.samples, 1e-6);
    c2d.strokeStyle = '#5ba8ff';
    c2d.lineWidth = 1.6;
    c2d.beginPath();
    track.samples.forEach((v, n) => {
      const x = padL + (n / Math.max(1, track.samples.length - 1)) * plotW;
      const y = top + h - (v / peak) * h;
      if (n === 0) c2d.moveTo(x, y);
      else c2d.lineTo(x, y);
    });
    c2d.stroke();

    c2d.fillStyle = '#5c5c66';
    c2d.fillText(`0–${durationSec.toFixed(1)}s`, padL + plotW - 54, top + h + 8);
  });

  return toImage(canvas);
}

/**
 * Everything the fit critic sees: one contact sheet plus one graph sheet.
 *
 * Best-effort throughout. A render failure means a critique with less evidence,
 * never a failed run — the linters have already established the craft floor, and
 * this pass is about fit.
 */
export async function renderCritiqueEvidence(
  ctx: ToolContext,
  durationSec: number,
): Promise<AiImage[]> {
  const out: AiImage[] = [];
  try {
    const times = await filmstripTimes(ctx, durationSec);
    const strip = await renderFilmstrip(times);
    if (strip) out.push(strip);

    const graphs = renderVelocityGraphs(await sampleVelocities(ctx, durationSec), durationSec);
    if (graphs) out.push(graphs);
  } catch {
    return out;
  }
  return out;
}
