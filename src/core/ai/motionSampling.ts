/**
 * Per-frame screen samples of the active composition's layers, for
 * motionAnalysis.ts.
 *
 * Screen, not stored values: a child moves when its parent does, a 3D layer
 * moves when the camera does, and a layer's own x/y says neither. Three batched
 * engine queries per sample time cover every layer at once — the rendered box
 * (renderedBoxes: the 2D chain, and the camera projection for 3D layers), the
 * world matrix for rotation, and evaluated opacity (expressions included) —
 * instead of one query per layer per frame.
 */

import { flicksToSeconds, secondsToFlicks } from '@motion/engine-api';
import type { ToolContext } from '@motion/ai-tools';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { renderedBoxes } from './renderedBounds';
import type { LayerSamples, MotionFrame, MotionInput } from './motionAnalysis';

/** Kinds with no picture of their own to move. */
const NOT_VISUAL = new Set(['camera', 'light', 'null', 'audio', 'adjustment']);

export interface SampleOptions {
  startSec: number;
  endSec: number;
  /** Restrict to these layers (resolved ids). Default: every visible picture layer. */
  nodeIds?: readonly string[];
  /** Cap on sample times; past it the step grows beyond one frame. Default 900. */
  maxSamples?: number;
  /** Cap on layers sampled. Default 160. */
  maxLayers?: number;
}

export interface SampledMotion extends MotionInput {
  /** Layers left out by `maxLayers`. */
  skippedLayers: number;
}

/** Sample times: every frame of the window, or evenly fewer when the window is long. */
export function sampleTimes(startSec: number, endSec: number, fps: number, maxSamples: number): number[] {
  const frameDt = 1 / Math.max(1, fps);
  const span = Math.max(0, endSec - startSec);
  const frames = Math.floor(span / frameDt + 1e-6);
  const step = Math.max(1, Math.ceil(frames / Math.max(1, maxSamples)));
  const out: number[] = [];
  for (let f = 0; f <= frames; f += step) out.push(startSec + f * frameDt);
  if (out.length && out[out.length - 1]! < endSec - frameDt / 2 && out.length < maxSamples + 1) out.push(startSec + frames * frameDt);
  return out;
}

export async function sampleMotion(ctx: ToolContext, o: SampleOptions): Promise<SampledMotion> {
  const comp = await ctx.comp.get();
  const fps = comp.fps || 30;
  const times = sampleTimes(o.startSec, o.endSec, fps, o.maxSamples ?? 900);

  const nodes = await ctx.scene.all();
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const wanted = o.nodeIds ? new Set(o.nodeIds) : null;
  let candidates = nodes.filter((n) => (wanted ? wanted.has(n.id) : n.visible && !NOT_VISUAL.has(n.kind)));

  // Over the cap, keep the layers that can move: animated themselves, under an
  // animated parent, or 3D under a camera.
  const maxLayers = o.maxLayers ?? 160;
  let skipped = 0;
  if (candidates.length > maxLayers) {
    const moves = (id: string): boolean => {
      for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) if (n.animated.length) return true;
      return false;
    };
    const ranked = [...candidates].sort((a, b) => Number(moves(b.id)) - Number(moves(a.id)));
    skipped = candidates.length - maxLayers;
    candidates = ranked.slice(0, maxLayers);
  }

  const m = documentMirror();
  const bar = new Map(candidates.map((n) => {
    const t = m.layer(n.id)?.timing;
    return [n.id, t ? { in: flicksToSeconds(t.inPoint), out: flicksToSeconds(t.outPoint) } : { in: -Infinity, out: Infinity }] as const;
  }));
  const ids = candidates.map((n) => n.id);
  const frames: (MotionFrame | null)[][] = ids.map(() => []);

  for (const t of times) {
    if (ctx.signal.aborted) break;
    const time = secondsToFlicks(t);
    const [boxes, xf, op] = await Promise.all([
      renderedBoxes(ids, t),
      engine().query({ type: 'getLayerTransforms', layers: ids, time }),
      engine().query({ type: 'getPropertyValues', props: ids.map((layer) => ({ layer, path: 'transform/opacity' })), time, evaluated: true }),
    ]);
    const rot = new Map<string, number>();
    if (xf.ok) for (const x of xf.value.transforms) rot.set(x.layer, (Math.atan2(x.matrix[1] ?? 0, x.matrix[0] ?? 1) * 180) / Math.PI);
    const opacity = new Map<string, number>();
    if (op.ok) {
      for (const v of op.value.values) {
        const val = v.value;
        if (val.kind === 'scalar' || val.kind === 'int') opacity.set(v.prop.layer, val.value);
      }
    }
    ids.forEach((id, i) => {
      const b = boxes.get(id);
      const span = bar.get(id)!;
      if (!b || t < span.in || t >= span.out) { frames[i]!.push(null); return; }
      frames[i]!.push({
        cx: b.x + b.width / 2,
        cy: b.y + b.height / 2,
        size: Math.sqrt(Math.max(0, b.width) * Math.max(0, b.height)),
        rotation: rot.get(id) ?? 0,
        opacity: opacity.get(id) ?? 100,
      });
    });
  }

  // An abort stops mid-window: every track ends at the last full sample.
  const n = frames.reduce((min, f) => Math.min(min, f.length), times.length);
  const layers: LayerSamples[] = candidates.map((node, i) => ({ id: node.id, name: node.name, frames: frames[i]!.slice(0, n) }));
  return { times: times.slice(0, n), fps, compWidth: comp.width, compHeight: comp.height, layers, skippedLayers: skipped };
}
