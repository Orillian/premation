/**
 * Make 3D from Photo / Video (camera program D3) — the editor's half.
 *
 * The engine renders an image / video layer with a Depth Scale and a Depth
 * Source as a camera-facing displaced grid (threed_port.cpp): white = near.
 * The source is one of
 *   `layer:<id>`         a user depth-map layer (an image layer's picture)
 *   `src:<file>`         a depth map on disk (the AI job's map for a still)
 *   `seq:<fps>:<dir>`    per-frame maps on disk (the AI job's cache for footage)
 *   `asset:<id>`         a project image item
 * The AI estimate is the engine's `depthEstimate` job (Depth Anything V2
 * Small, kind_depth_estimate.cpp), which writes the maps and points the layer
 * at them in one history entry; the model downloads once on first use.
 */

import type { Command as EngineCommand } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { startEngineJob } from '@core/engine/engineJobs';
import { documentMirror } from '@stores/documentMirror';
import { uiKindOf } from '@core/mirror/layerKinds';

export const DEFAULT_DEPTH_SCALE = 300;

export function isDepthParallaxCandidate(id: string): boolean {
  const k = uiKindOf(documentMirror().layer(id));
  return k === 'image' || k === 'video';
}

/** The comp's other image / video layers a depth map could come from. */
export function depthMapLayerChoices(layer: string): Array<{ id: string; name: string }> {
  const m = documentMirror();
  const info = m.layer(layer);
  const comp = info ? m.comp(info.comp) : undefined;
  return (comp?.layers ?? [])
    .filter((id) => id !== layer && isDepthParallaxCandidate(id))
    .map((id) => ({ id, name: m.layer(id)?.name ?? id }));
}

/** The commands that make `layer` a depth-parallax layer fed by `source` (one history entry). */
export function depthParallaxCommands(layer: string, source: string, depthScale = DEFAULT_DEPTH_SCALE): EngineCommand[] {
  return [
    { type: 'setLayerSwitches', layers: [layer], patch: { threeD: true } },
    { type: 'setProperty', prop: { layer, path: 'layer/depthSource' }, value: { kind: 'string', value: source } },
    { type: 'setProperty', prop: { layer, path: 'geometry/depthScale' }, value: { kind: 'scalar', value: depthScale } },
  ];
}

/** Depth from a depth-map layer: one entry; the map layer is hidden (it is a data source, not a picture). */
export async function makeDepthFromLayer(layer: string, mapLayer: string, depthScale = DEFAULT_DEPTH_SCALE): Promise<boolean> {
  const res = await edit('Make 3D from Photo', [
    ...depthParallaxCommands(layer, `layer:${mapLayer}`, depthScale),
    { type: 'setLayerSwitches', layers: [mapLayer], patch: { visible: false } },
  ]);
  return res.ok;
}

export type DepthJobOutcome = { ok: true } | { ok: false; message: string };

const depthBridge = (): NonNullable<Window['motionEditor']>['depthModel'] | undefined =>
  typeof window !== 'undefined' ? window.motionEditor?.depthModel : undefined;

/**
 * The depth model on disk, downloaded once on first use (electron/depthModel.ts:
 * a pinned URL + SHA-256). Outside the desktop app there is no installer: the
 * engine job reports what it is missing.
 */
export async function ensureDepthModel(onProgress?: (progress: number, message: string) => void): Promise<DepthJobOutcome> {
  const bridge = depthBridge();
  if (!bridge) return { ok: true };
  if (await bridge.status()) return { ok: true };
  const requestId = `depth-${Date.now().toString(36)}`;
  const off = bridge.onDownloadProgress((e) => {
    const p = e as { requestId?: string; receivedBytes?: number; totalBytes?: number | null };
    if (p.requestId === requestId && p.totalBytes) onProgress?.((p.receivedBytes ?? 0) / p.totalBytes, 'Downloading the depth model');
  });
  try {
    const res = await bridge.install({ requestId });
    return res.ok ? { ok: true } : { ok: false, message: res.message };
  } finally {
    off();
  }
}

/** Depth from the AI model: the engine job (estimate, cache to disk, apply). */
export async function makeDepthFromModel(
  layer: string,
  depthScale = DEFAULT_DEPTH_SCALE,
  onProgress?: (progress: number, message: string) => void,
): Promise<DepthJobOutcome> {
  const model = await ensureDepthModel(onProgress);
  if (!model.ok) return model;
  let handle;
  try {
    handle = await startEngineJob({ kind: 'depthEstimate', value: { layer, depthScale } }, { apply: true, ...(onProgress ? { onProgress } : {}) });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!handle) {
    return { ok: false, message: 'This engine does not run depth estimation — pick a depth-map layer instead.' };
  }
  const out = await handle.done;
  if (out.status === 'done') return { ok: true };
  return { ok: false, message: out.error?.message ?? (out.status === 'cancelled' ? 'Cancelled.' : 'Depth estimation failed.') };
}
