/**
 * Premium LAYER transitions from data (`TransitionPayload`, packFormat.ts).
 *
 * The bundled recipes in transitionLibrary.ts are code; a premium one arrives
 * as a spec of pose-relative keys, so the same authored move fits any layer in
 * any comp. This evaluates a spec against a layer's pose and keys it the way
 * `planLayerTransition` keys a bundled recipe: onto a scratch engine, comp
 * seconds mapped onto each layer's keyframe axis, effect tracks resolved to an
 * existing effect of the type or one the caller adds with the id returned.
 *
 * The invariant the bundled recipes keep holds here too, enforced rather than
 * trusted: an entrance ends every prop on the pose (opacity 100); an exit
 * reaches opacity 0, then glides every moved prop back onto the pose while
 * invisible, so a re-trimmed clip can never strand the layer off-frame.
 *
 * Pure apart from the engine it is handed.
 */

import type { AnimationEngine, BezierHandles, EasingKind } from '@motion/animation';
import { effectPropPath } from '@core/effects/effects';
import { detectPhase, type ApplyTransitionResult, type CompBox, type LayerPose, type TransitionLayerFacts, type TransitionPhase } from '@core/library/transitionLibrary';
import type { SpecEase, SpecKf, SpecProp, SpecValue, TransitionPayload } from './packFormat';

/** A spec key resolved to a concrete value at a time in seconds. `fx` = index into `spec.fx`. */
export interface ResolvedKf {
  prop: SpecProp | { fx: number };
  t: number;
  value: number;
  ease: SpecEase;
}

const POSE_PROPS: readonly SpecProp[] = ['x', 'y', 'scaleX', 'scaleY', 'rotation'];
/** An exit is fully transparent by this fraction of its duration. */
const FADE_BY = 0.92;

/** Displacements that put the layer fully off each edge (transitionRecipe's rule). */
export function offFrame(pose: LayerPose, comp: CompBox): { offL: number; offR: number; offU: number; offD: number } {
  const halfW = (pose.width * Math.abs(pose.scaleX)) / 2;
  const halfH = (pose.height * Math.abs(pose.scaleY)) / 2;
  const cx = pose.x + (pose.offsetX ?? 0);
  const cy = pose.y + (pose.offsetY ?? 0);
  return {
    offL: -(cx + halfW) - 40,
    offR: comp.width - cx + halfW + 40,
    offU: -(cy + halfH) - 40,
    offD: comp.height - cy + halfH + 40,
  };
}

function poseValue(pose: LayerPose, prop: SpecProp): number {
  return prop === 'opacity' ? 100 : pose[prop];
}

/** A spec value for `prop` on this pose. Off-frame bases are DISPLACEMENTS from the pose. */
export function resolveValue(v: SpecValue, prop: SpecProp, pose: LayerPose, comp: CompBox): number {
  const mul = v.mul ?? 1;
  const add = v.add ?? 0;
  const home = poseValue(pose, prop);
  switch (v.base) {
    case 'pose': return home * mul + add;
    // An absolute value: `add` is the value itself (`mul` has nothing to scale).
    case 'const': return add;
    default: {
      const off = offFrame(pose, comp)[v.base];
      return home + off * mul + add;
    }
  }
}

/** The keys a spec writes for one layer and phase, seconds from the transition's start. */
export function specRecipe(spec: TransitionPayload, pose: LayerPose, comp: CompBox, phase: TransitionPhase): ResolvedKf[] {
  const d = spec.duration;
  const keys: SpecKf[] = phase === 'enter' ? spec.enter : spec.exit;
  const out: ResolvedKf[] = keys.map((k) => ({
    prop: k.prop,
    t: k.t * d,
    value: resolveValue(k.value, k.prop, pose, comp),
    ease: k.ease ?? 'easeOut',
  }));
  const last = (prop: SpecProp): ResolvedKf | undefined =>
    out.filter((k) => k.prop === prop).sort((a, b) => a.t - b.t).at(-1);

  if (phase === 'enter') {
    // Land exactly on the pose, whatever the author wrote last.
    for (const prop of [...POSE_PROPS, 'opacity'] as SpecProp[]) {
      const k = last(prop);
      if (!k) continue;
      const home = poseValue(pose, prop);
      if (k.t < d) out.push({ prop, t: d, value: home, ease: 'easeInOut' });
      else k.value = home;
    }
  } else {
    // Invisible by FADE_BY·d at the latest; then every moved prop returns to
    // the pose at d — a glide nobody sees.
    const fadeBy = d * FADE_BY;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.prop === 'opacity' && out[i]!.t > fadeBy) out.splice(i, 1);
    }
    const op = last('opacity');
    if (!op) out.push({ prop: 'opacity', t: 0, value: 100, ease: 'easeIn' });
    if (!op || op.value !== 0) out.push({ prop: 'opacity', t: fadeBy, value: 0, ease: 'easeIn' });
    for (const prop of POSE_PROPS) {
      const k = last(prop);
      if (!k) continue;
      if (k.t >= d) k.t = d * 0.96;
      out.push({ prop, t: d, value: poseValue(pose, prop), ease: 'linear' });
    }
  }
  spec.fx.forEach((fx, i) => {
    const fk = phase === 'enter' ? fx.enter : fx.exit;
    for (const k of fk) out.push({ prop: { fx: i }, t: k.t * d, value: k.value, ease: k.ease ?? 'easeOut' });
  });
  return out;
}

function setKey(engine: AnimationEngine, layer: string, prop: string, t: number, value: number, ease: SpecEase): void {
  if (Array.isArray(ease)) {
    engine.setKeyframe(layer, prop, t, value, 'bezier' as EasingKind);
    engine.setBezier(layer, prop, t, [...ease] as BezierHandles);
  } else {
    engine.setKeyframe(layer, prop, t, value, ease as EasingKind);
  }
}

export interface SpecTransitionPlan {
  result: ApplyTransitionResult | null;
  /** Effects to add first, with the caller-chosen ids the keys already use. */
  needFx: Array<{ layer: string; id: string; type: string; init?: Record<string, number | string | boolean> }>;
}

/** `planLayerTransition` for a spec (see the file header). */
export function planSpecTransition(
  spec: TransitionPayload,
  targets: readonly string[],
  t0: number,
  box: CompBox,
  facts: TransitionLayerFacts,
  engine: AnimationEngine,
  keyTime: (nodeId: string, compSeconds: number) => number,
): SpecTransitionPlan {
  const needFx: SpecTransitionPlan['needFx'] = [];
  const written: string[] = [];
  const phases: TransitionPhase[] = [];
  for (const nodeId of targets) {
    const pose = facts.pose(nodeId);
    if (!pose) continue;
    const { fps, clips } = facts.clips(nodeId);
    const phase = detectPhase(clips, Math.round(t0 * fps), Math.round((t0 + spec.duration) * fps));
    const recipe = specRecipe(spec, pose, box, phase);
    if (recipe.length === 0) continue;
    const fxTracks = new Map<number, string>();
    const effects = facts.effects(nodeId);
    const taken = new Set(effects.map((e) => e.id));
    for (const kf of recipe) {
      let prop: string;
      if (typeof kf.prop === 'string') {
        prop = kf.prop;
      } else {
        const i = kf.prop.fx;
        let track = fxTracks.get(i);
        if (track === undefined) {
          const fx = spec.fx[i]!;
          let id = effects.find((e) => e.type === fx.type)?.id ?? needFx.find((n) => n.layer === nodeId && n.type === fx.type)?.id;
          if (!id) {
            id = `transition_${fx.type.replace(/[^a-z0-9]+/gi, '_')}`;
            for (let n = 2; taken.has(id); n++) id = `transition_${fx.type.replace(/[^a-z0-9]+/gi, '_')}_${n}`;
            taken.add(id);
            needFx.push({ layer: nodeId, id, type: fx.type, ...(fx.init ? { init: fx.init } : {}) });
          }
          track = effectPropPath(id, fx.param);
          fxTracks.set(i, track);
        }
        prop = track;
      }
      setKey(engine, nodeId, prop, keyTime(nodeId, t0 + kf.t), kf.value, kf.ease);
    }
    written.push(nodeId);
    phases.push(phase);
  }
  return { result: written.length > 0 ? { mode: 'layer', nodeIds: written, phases } : null, needFx };
}
