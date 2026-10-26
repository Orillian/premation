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
import type { SceneNodeView, ToolContext } from '@motion/ai-tools';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { activeCompRootId } from '@core/scene/activeComp';
import { allLayerIds, layerView } from './mirrorReads';
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


/** A layer that renders in the active composition: directly, or inside precomps (`chain`, outer → inner). */
interface Source {
  id: string;
  /** The precomp layers it is seen through, outermost first. */
  chain: string[];
}

/** Precomps nest this deep at most before the walk stops. */
const MAX_NESTING = 4;

/**
 * Every layer that can draw in `comp`, walking into precomps — and ONLY those:
 * the mirror holds every composition of the project (an orphaned precomp a
 * rebuild left behind, a scene the user is not looking at), and a layer that
 * never reaches the frame has no motion on it.
 */
function sourcesOf(comp: string): Source[] {
  const m = documentMirror();
  const sources: Source[] = [];
  const visit = (c: string, chain: string[]): void => {
    for (const id of m.comp(c)?.layers ?? []) {
      const l = m.layer(id);
      if (!l) continue;
      const inner = l.source && m.comp(l.source) ? l.source : null;
      if (inner && chain.length < MAX_NESTING && !chain.includes(id)) {
        visit(inner, [...chain, id]);
      } else {
        sources.push({ id, chain });
      }
    }
  };
  visit(comp, []);
  return sources;
}

interface Xf { matrix: number[]; anchor: { x: number; y: number }; opacity: number; live: boolean }

/** Layer → its comp, for the 2D chain: the drawn content sits at matrix · T(−anchor) (getLayerTransforms). */
function mapPoint(x: Xf, px: number, py: number): { x: number; y: number } {
  const m = x.matrix;
  const lx = px - x.anchor.x, ly = py - x.anchor.y;
  return { x: (m[0] ?? 1) * lx + (m[4] ?? 0) * ly + (m[12] ?? 0), y: (m[1] ?? 0) * lx + (m[5] ?? 1) * ly + (m[13] ?? 0) };
}

export async function sampleMotion(ctx: ToolContext, o: SampleOptions): Promise<SampledMotion> {
  const comp = await ctx.comp.get();
  const fps = comp.fps || 30;
  const times = sampleTimes(o.startSec, o.endSec, fps, o.maxSamples ?? 900);

  const m = documentMirror();
  // Every composition's layers, not only the active one's (ctx.scene.all): a
  // precomp's contents live in their own composition and are measured too.
  const nodes: SceneNodeView[] = [];
  for (const id of allLayerIds()) {
    const v = await layerView(id);
    if (v) nodes.push(v);
  }
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const sources = sourcesOf(activeCompRootId() as string);
  const chainOf = new Map(sources.map((s) => [s.id, s.chain] as const));
  const wanted = o.nodeIds ? new Set(o.nodeIds) : null;
  let candidates = sources
    .map((s) => byId.get(s.id))
    .filter((n): n is NonNullable<typeof n> => !!n && (wanted ? wanted.has(n.id) : n.visible && !NOT_VISUAL.has(n.kind)));

  // Over the cap, keep the layers that can move: animated themselves, under an
  // animated parent, or inside an animated precomp.
  const maxLayers = o.maxLayers ?? 160;
  let skipped = 0;
  const animatedAbove = (id: string): boolean => {
    for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) if (n.animated.length) return true;
    return (chainOf.get(id) ?? []).some((p) => byId.get(p)?.animated.length);
  };
  if (candidates.length > maxLayers) {
    const ranked = [...candidates].sort((a, b) => Number(animatedAbove(b.id)) - Number(animatedAbove(a.id)));
    skipped = candidates.length - maxLayers;
    candidates = ranked.slice(0, maxLayers);
  }

  const seconds = (f: number | undefined): number => (typeof f === 'number' ? flicksToSeconds(f) : 0);
  const barOf = (id: string): { in: number; out: number } => {
    const t = m.layer(id)?.timing;
    return t ? { in: seconds(t.inPoint), out: seconds(t.outPoint) } : { in: -Infinity, out: Infinity };
  };
  /** A precomp's own time at its comp's time `t` (AE Start Time; stretch and remap are not followed). */
  const innerTime = (precomp: string, t: number): number => t - seconds(m.layer(precomp)?.timing.startTime);

  // Layers grouped by the chain they are seen through: one batch of queries per group and sample.
  const groups = new Map<string, { chain: string[]; ids: string[] }>();
  for (const n of candidates) {
    const chain = chainOf.get(n.id) ?? [];
    const key = chain.join('>');
    const g = groups.get(key) ?? { chain, ids: [] };
    g.ids.push(n.id);
    groups.set(key, g);
  }
  const index = new Map(candidates.map((n, i) => [n.id, i] as const));
  const frames: (MotionFrame | null)[][] = candidates.map(() => []);

  const opacityAt = async (ids: readonly string[], t: number): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    const op = await engine().query({ type: 'getPropertyValues', props: ids.map((layer) => ({ layer, path: 'transform/opacity' })), time: secondsToFlicks(t), evaluated: true });
    if (op.ok) for (const v of op.value.values) if (v.value.kind === 'scalar' || v.value.kind === 'int') out.set(v.prop.layer, v.value.value);
    return out;
  };
  const transformsAt = async (ids: readonly string[], t: number): Promise<Map<string, { matrix: number[]; anchor: { x: number; y: number } }>> => {
    const out = new Map<string, { matrix: number[]; anchor: { x: number; y: number } }>();
    if (!ids.length) return out;
    const xf = await engine().query({ type: 'getLayerTransforms', layers: [...ids], time: secondsToFlicks(t) });
    if (xf.ok) for (const x of xf.value.transforms) out.set(x.layer, { matrix: x.matrix, anchor: { x: x.anchor.x, y: x.anchor.y } });
    return out;
  };

  for (const t of times) {
    if (ctx.signal.aborted) break;
    // Each precomp layer at its own comp's time, once per sample.
    const precompXf = new Map<string, Xf>();
    const resolve = async (chain: readonly string[]): Promise<{ xfs: Xf[]; inner: number } | null> => {
      let tc = t;
      const xfs: Xf[] = [];
      for (const p of chain) {
        let x = precompXf.get(`${p}@${tc}`);
        if (!x) {
          const [tr, op] = await Promise.all([transformsAt([p], tc), opacityAt([p], tc)]);
          const bar = barOf(p);
          const got = tr.get(p);
          x = { matrix: got?.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], anchor: got?.anchor ?? { x: 0, y: 0 }, opacity: op.get(p) ?? 100, live: tc >= bar.in && tc < bar.out };
          precompXf.set(`${p}@${tc}`, x);
        }
        xfs.push(x);
        tc = innerTime(p, tc);
      }
      return { xfs, inner: tc };
    };

    for (const g of groups.values()) {
      const r = await resolve(g.chain);
      if (!r) continue;
      const { xfs, inner } = r;
      const [boxes, rot, op] = await Promise.all([
        renderedBoxes(g.ids, inner),
        transformsAt(g.ids, inner),
        opacityAt(g.ids, inner),
      ]);
      const outerRot = xfs.reduce((a, x) => a + (Math.atan2(x.matrix[1] ?? 0, x.matrix[0] ?? 1) * 180) / Math.PI, 0);
      const outerOpacity = xfs.reduce((a, x) => a * (x.opacity / 100), 1);
      const live = xfs.every((x) => x.live);
      for (const id of g.ids) {
        const i = index.get(id)!;
        const b = boxes.get(id);
        const bar = barOf(id);
        if (!b || !live || inner < bar.in || inner >= bar.out) { frames[i]!.push(null); continue; }
        // The box's corners out through each precomp, innermost first.
        let pts = [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
        for (let k = xfs.length - 1; k >= 0; k--) pts = pts.map((p) => mapPoint(xfs[k]!, p.x, p.y));
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const x0 = Math.min(...xs), y0 = Math.min(...ys);
        const w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
        const own = rot.get(id);
        frames[i]!.push({
          cx: x0 + w / 2,
          cy: y0 + h / 2,
          size: Math.sqrt(Math.max(0, w) * Math.max(0, h)),
          w,
          h,
          rotation: (own ? (Math.atan2(own.matrix[1] ?? 0, own.matrix[0] ?? 1) * 180) / Math.PI : 0) + outerRot,
          opacity: (op.get(id) ?? 100) * outerOpacity,
        });
      }
    }
  }

  // An abort stops mid-window: every track ends at the last full sample.
  const n = frames.reduce((min, f) => Math.min(min, f.length), times.length);
  // What each layer moves WITH: its top-most animated parent, else the
  // outermost animated precomp it is seen through (a scene pushed as one).
  const rigOf = (id: string): { id: string; name: string } | undefined => {
    let rig: { id: string; name: string } | undefined;
    for (let p = byId.get(id)?.parent ? byId.get(byId.get(id)!.parent!) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) {
      if (p.animated.length) rig = { id: p.id, name: p.name };
    }
    if (rig) return rig;
    const pc = (chainOf.get(id) ?? []).find((p) => byId.get(p)?.animated.length);
    return pc ? { id: pc, name: byId.get(pc)?.name ?? pc } : undefined;
  };
  const layers: LayerSamples[] = candidates.map((node, i) => {
    const rig = rigOf(node.id);
    return { id: node.id, name: node.name, frames: frames[i]!.slice(0, n), ...(rig ? { rig } : {}) };
  });
  return { times: times.slice(0, n), fps, compWidth: comp.width, compHeight: comp.height, layers, skippedLayers: skipped };
}
