/**
 * Pure preparation of a premium TEMPLATE payload for `pasteLayers`.
 *
 * A payload is authored once, at its own size and from t = 0. Before it is
 * pasted it is fitted to where it lands:
 *   • asset placeholders become the ids / urls the engine minted on import;
 *   • an ELEMENT (a lower third, a title) is moved to the target comp's centre,
 *     scaled to its height, and retimed to start at the playhead — through its
 *     single top layer, so the element's internal design is never touched;
 *   • a SCENE pastes as authored into a composition made to its settings.
 *
 * No engine, no stores: the caller does the I/O (templateStore.applyPayload).
 */

/* eslint-disable no-restricted-syntax -- every `.props` written here belongs to a deep JSON copy of the
   payload's layers (`copy`), about to be encoded into a fragment: plain data, not scene-graph components. */

import type { FragmentLayer } from '@/engine-client/fragmentBuilder';
import type { TemplatePayload } from './packFormat';

export interface ImportedRef {
  ref: string;
  /** The engine's item id. */
  id: string;
  /** The item's media url. */
  src: string;
}

const ASSET_ID_KEYS = new Set(['assetId', '__assetId']);
const SRC_KEYS = new Set(['src', '__src']);

/** Deep copy (payload layers are plain JSON). */
function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Replace asset placeholders in every component's props. Returns refs that no layer used. */
export function rewriteAssetRefs(layers: FragmentLayer[], imported: readonly ImportedRef[]): string[] {
  const byRef = new Map(imported.map((r) => [r.ref, r]));
  const used = new Set<string>();
  for (const layer of layers) {
    for (const c of layer.row.components) {
      for (const [k, v] of Object.entries(c.props)) {
        if (typeof v !== 'string') continue;
        const hit = byRef.get(v);
        if (!hit) continue;
        if (ASSET_ID_KEYS.has(k)) { c.props[k] = hit.id; used.add(v); }
        else if (SRC_KEYS.has(k)) { c.props[k] = hit.src; used.add(v); }
      }
    }
  }
  return imported.map((r) => r.ref).filter((r) => !used.has(r));
}

/** Shift every keyframe and bar of `layers` by `dt` seconds (bars re-expressed at `toFps`). */
export function retime(layers: FragmentLayer[], dt: number, fromFps: number, toFps: number): void {
  for (const layer of layers) {
    const anim = layer.anim;
    if (anim) {
      for (const keys of Object.values(anim.tracks)) for (const k of keys) k.t += dt;
      for (const track of Object.values(anim.data)) for (const k of track.keyframes) k.t += dt;
    }
    layer.bars = layer.bars.map((b) => ({
      start: Math.round((b.start / fromFps + dt) * toFps),
      duration: Math.max(1, Math.round((b.duration / fromFps) * toFps)),
      sourceIn: Math.round((b.sourceIn / fromFps) * toFps),
      sourceDuration: b.sourceDuration === null ? null : Math.round((b.sourceDuration / fromFps) * toFps),
    }));
  }
}

/** The single top-level layer of an element payload, or null when there is not exactly one. */
export function elementRoot(layers: readonly FragmentLayer[]): FragmentLayer | null {
  const ids = new Set(layers.map((l) => l.row.id));
  const tops = layers.filter((l) => !l.row.parent || !ids.has(l.row.parent));
  return tops.length === 1 ? tops[0]! : null;
}

/**
 * Move and scale an element through its root's Transform so the authored
 * centre `from` lands on `to`, `u` times larger. The root scales about its own
 * position (anchor 0), so a root at `r` must move to `to - u·(from - r)` for
 * the content centre to arrive — applied to position keys too.
 */
export function placeElement(root: FragmentLayer, from: { x: number; y: number }, to: { x: number; y: number }, u: number): void {
  const t = root.row.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const px = (v: number): number => to.x - u * (from.x - v);
  const py = (v: number): number => to.y - u * (from.y - v);
  t.props.x = px(num(t.props.x, 0));
  t.props.y = py(num(t.props.y, 0));
  t.props.scaleX = num(t.props.scaleX, 1) * u;
  t.props.scaleY = num(t.props.scaleY, 1) * u;
  root.row.transform.position = { x: num(t.props.x, 0), y: num(t.props.y, 0) };
  const tracks = root.anim?.tracks;
  if (!tracks) return;
  for (const k of tracks.x ?? []) k.value = px(k.value);
  for (const k of tracks.y ?? []) k.value = py(k.value);
  for (const k of tracks.scaleX ?? []) k.value *= u;
  for (const k of tracks.scaleY ?? []) k.value *= u;
}

export interface PlacementTarget {
  width: number;
  height: number;
  fps: number;
  /** Comp seconds the element starts at. */
  t0: number;
}

/**
 * The payload's layers ready to paste: copied, assets rewritten, and — for an
 * element — placed and retimed into `target`. Throws when an element payload
 * has no single root (the contract's rule, checked again here because the
 * placement depends on it).
 */
export function preparedLayers(p: TemplatePayload, imported: readonly ImportedRef[], target: PlacementTarget | null): FragmentLayer[] {
  const layers = copy(p.layers);
  rewriteAssetRefs(layers, imported);
  if (p.mode === 'element' && target) {
    const root = elementRoot(layers);
    if (!root) throw new Error('an element template must have exactly one top layer');
    const u = target.height / p.settings.height;
    placeElement(root, { x: p.settings.width / 2, y: p.settings.height / 2 }, { x: target.width / 2, y: target.height / 2 }, u);
    retime(layers, target.t0, p.settings.fps, target.fps);
  }
  return layers;
}
