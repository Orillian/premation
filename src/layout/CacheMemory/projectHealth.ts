/**
 * Project Health — what is slowing this composition down or breaking it, and
 * the one thing to do about each. Neither After Effects nor Premiere has this.
 *
 * Every figure is one the editor really has:
 *
 *   • memory      `getRenderStats` through `engineMemory.ts` (the verdict is
 *                 `memoryHealth`: RAM tier at budget, machine short, growing);
 *   • frame cost  the same stats' last frame build + GPU time against the
 *                 composition's frame budget;
 *   • cache       `getCacheCoverage` (the timeline's cache bar figures);
 *   • footage     the document mirror: the active comp's layers, the items
 *                 they use (size, media type, missing, proxy path / enabled);
 *   • errors      `snapshot.layerErrors` as the mirror holds it
 *                 (`layerErrors` events, `errors:<comp>`).
 *
 * The engine does not report how many video decoders it has open, nor the
 * GPU's own memory use and budget. Until it does, "video layers" stands in
 * for decoders (each visible footage layer of a video item is one stream the
 * engine decodes), and video memory means the viewport frame cache only.
 *
 * Pure over plain values, so every rule is tested without an engine.
 */

import type { ItemInfo, LayerError, LayerInfo } from '@motion/engine-api';
import type { MemoryHealth, MemoryReadout } from '@core/perf/memoryHealth';

/** Footage at or above this long edge is "4K-class": UHD 3840, DCI 4096, 3K cinema. */
export const LARGE_FOOTAGE_LONG_EDGE = 2880;
/** Video layers in one composition from which a precompose / trim suggestion is made. */
export const MANY_VIDEO_LAYERS = 8;

export type HealthTone = 'ok' | 'warn' | 'bad';

/** What the active composition holds, read off the mirror. */
export interface CompFootageFacts {
  /** Visible layers whose source is a video item (≈ decoders the engine keeps open). */
  videoLayers: number;
  /** Distinct video items those layers use. */
  videoSources: number;
  /** 4K-class video items used here that have no proxy at all. */
  largeWithoutProxy: string[];
  /** 4K-class items used here whose proxy exists but is switched off. */
  proxiesOff: string[];
  /** Items used here whose proxy is attached and switched on. */
  proxiesOn: number;
  /** Footage used here whose file is missing. */
  missing: number;
  /** The comp's layer errors (expression errors included). */
  errors: readonly LayerError[];
}

export function compFootageFacts(
  layers: ReadonlyArray<LayerInfo | undefined>,
  item: (id: string) => ItemInfo | undefined,
  errors: readonly LayerError[],
): CompFootageFacts {
  let videoLayers = 0;
  const video = new Set<string>();
  const used = new Set<string>();
  for (const l of layers) {
    if (!l?.source) continue;
    const info = item(l.source);
    if (!info || info.kind !== 'footage') continue;
    used.add(info.id);
    if (info.mediaType === 'video' && l.switches.visible && !l.switches.guide) {
      videoLayers += 1;
      video.add(info.id);
    }
  }
  const largeWithoutProxy: string[] = [];
  const proxiesOff: string[] = [];
  let proxiesOn = 0;
  let missing = 0;
  for (const id of used) {
    const info = item(id);
    if (!info) continue;
    if (info.missing) missing += 1;
    if (info.mediaType !== 'video') continue;
    const large = Math.max(info.width, info.height) >= LARGE_FOOTAGE_LONG_EDGE;
    if (!info.proxyPath && !info.missing && large) largeWithoutProxy.push(id);
    if (info.proxyPath && !info.proxyEnabled && large) proxiesOff.push(id);
    if (info.proxyPath && info.proxyEnabled) proxiesOn += 1;
  }
  return { videoLayers, videoSources: video.size, largeWithoutProxy, proxiesOff, proxiesOn, missing, errors };
}

/** The suggestion kinds; the view words them and wires their one action. */
export type HealthFindingKind =
  | 'layerErrors'
  | 'memoryGrowing'
  | 'machineLow'
  | 'gpuLow'
  | 'ramFull'
  | 'missingFootage'
  | 'largeWithoutProxy'
  | 'useProxiesOff'
  | 'proxiesOff'
  | 'manyVideoLayers'
  | 'slowUncached';

export interface HealthFinding {
  kind: HealthFindingKind;
  tone: Exclude<HealthTone, 'ok'>;
  /** The count the sentence quotes. */
  n: number;
  /** Items an action runs on (Create Proxies, Use Proxy). */
  items?: string[];
}

export interface HealthInput {
  readout: MemoryReadout | null;
  memory: MemoryHealth;
  /** null = no composition open. */
  footage: CompFootageFacts | null;
  /** The global Use Proxies switch. */
  useProxies: boolean;
  /** The last frame's build + GPU time, ms; null before the engine answers. */
  frameMs: number | null;
  /** One frame at the comp's rate, ms. */
  frameBudgetMs: number;
  /** Cached / total frames of the comp's work area; null = not read (the status dot). */
  cache: { cached: number; total: number } | null;
}

export interface ProjectHealth {
  tone: HealthTone;
  /** Worst first. */
  findings: HealthFinding[];
}

const RANK: Record<HealthFinding['tone'], number> = { bad: 0, warn: 1 };

export function projectHealth(input: HealthInput): ProjectHealth {
  const out: HealthFinding[] = [];
  const f = input.footage;

  if (f) {
    const errLayers = new Set(f.errors.map((e) => e.layer)).size;
    if (errLayers > 0) out.push({ kind: 'layerErrors', tone: 'bad', n: errLayers });
    if (f.missing > 0) out.push({ kind: 'missingFootage', tone: 'warn', n: f.missing });
    if (f.largeWithoutProxy.length > 0) out.push({ kind: 'largeWithoutProxy', tone: 'warn', n: f.largeWithoutProxy.length, items: f.largeWithoutProxy });
    if (f.proxiesOff.length > 0) out.push({ kind: 'proxiesOff', tone: 'warn', n: f.proxiesOff.length, items: f.proxiesOff });
    // Proxies are set up and on, but the global switch keeps the viewer on the originals.
    if (!input.useProxies && f.proxiesOn > 0) out.push({ kind: 'useProxiesOff', tone: 'warn', n: f.proxiesOn });
    if (f.videoLayers >= MANY_VIDEO_LAYERS) out.push({ kind: 'manyVideoLayers', tone: 'warn', n: f.videoLayers });
  }

  if (input.memory.kind === 'growing') out.push({ kind: 'memoryGrowing', tone: 'bad', n: 0 });
  else if (input.memory.kind === 'pressure' && input.memory.pressure === 'machine') out.push({ kind: 'machineLow', tone: 'warn', n: 0 });
  else if (input.memory.kind === 'pressure' && input.memory.pressure === 'gpu') out.push({ kind: 'gpuLow', tone: 'warn', n: 0 });
  else if (input.memory.kind === 'pressure') out.push({ kind: 'ramFull', tone: 'warn', n: 0 });

  const c = input.cache;
  if (f && input.frameMs !== null && input.frameMs > input.frameBudgetMs && (!c || (c.total > 0 && c.cached < c.total))) {
    out.push({ kind: 'slowUncached', tone: 'warn', n: Math.round(input.frameMs) });
  }

  out.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
  const tone: HealthTone = out.length === 0 ? 'ok' : out[0]!.tone;
  return { tone, findings: out };
}
