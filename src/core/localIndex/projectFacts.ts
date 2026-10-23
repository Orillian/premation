/**
 * deriveProjectFacts — the pure projector from a document to the scalar facts
 * the index mirrors (so a dashboard card renders without opening the bundle).
 *
 * This is the local counterpart of the backend's `projectFacts`
 * (motion-back src/projects/project-facts.ts): the same summary — size, fps,
 * duration, layer count — and the same main-comp rule, computed from the live
 * `EditorDocument` on every save. Deterministic and dependency-free.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { CompositionSettings } from '@stores/projectStore';

export interface ProjectFacts {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  layerCount: number;
}

const ZERO: ProjectFacts = { width: 0, height: 0, fps: 0, durationSeconds: 0, layerCount: 0 };

interface NodeLike {
  id?: unknown;
  parent?: unknown;
  components?: unknown;
}

/** The comp a precomp layer places, read off its fx component (`__compRef`). */
function placedComp(node: NodeLike): string | null {
  if (!Array.isArray(node.components)) return null;
  for (const c of node.components as Array<{ type?: unknown; props?: Record<string, unknown> }>) {
    const ref = c?.type === 'fx' ? c.props?.__compRef : undefined;
    if (typeof ref === 'string' && ref !== '') return ref;
  }
  return null;
}

/**
 * The comp that describes the project. Each comp is a root scene node with its
 * layers beneath it, and the FIRST comp is often the auto-made empty one — so
 * reading it made every card say 1920×1080 · 30 fps · 10 s. The main comp is
 * the one holding the work: most layers, and not placed as a layer by another
 * comp (a precomp is part of a bigger piece). Ties go to the earlier comp.
 */
export function mainCompId(comps: Record<string, unknown>, nodes: readonly NodeLike[]): string | null {
  const ids = Object.keys(comps);
  if (ids.length <= 1) return ids[0] ?? null;

  const parentOf = new Map<string, string | null>();
  for (const n of nodes) {
    if (typeof n?.id === 'string') parentOf.set(n.id, typeof n.parent === 'string' ? n.parent : null);
  }
  const rootOf = (id: string): string => {
    let at = id;
    // Bounded: a parent cycle in a damaged file ends the walk.
    for (let guard = 0; guard < 4096; guard++) {
      const up = parentOf.get(at);
      if (up == null) return at;
      at = up;
    }
    return at;
  };

  const layers = new Map<string, number>();
  const placed = new Set<string>();
  for (const n of nodes) {
    if (typeof n?.id !== 'string' || n.id in comps) continue;
    const root = rootOf(n.id);
    if (root in comps) layers.set(root, (layers.get(root) ?? 0) + 1);
    const ref = placedComp(n);
    if (ref !== null && ref !== root) placed.add(ref);
  }

  let best: string | null = null;
  let bestScore = -1;
  for (const id of ids) {
    // An unplaced comp with work beats any precomp; a precomp beats an empty comp.
    const n = layers.get(id) ?? 0;
    const score = n === 0 ? 0 : placed.has(id) ? n : n + 1_000_000;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Summarize a document. Size/fps/duration come from the main composition
 * (`mainCompId`, else the legacy single `comp`); layer count is the scene's
 * layers (comps are root nodes, not layers). Absent data yields zeros rather
 * than throwing — a bundle mid-write or a legacy scene-only file still
 * produces a valid (if sparse) card.
 */
export function deriveProjectFacts(doc: EditorDocument): ProjectFacts {
  if (!doc) return { ...ZERO };

  const comps: Record<string, CompositionSettings> =
    doc.comps ?? (doc.comp ? { [doc.comp.id]: doc.comp } : {});
  const rawNodes = (doc.scene as { nodes?: unknown } | undefined)?.nodes;
  const nodes: NodeLike[] = Array.isArray(rawNodes) ? (rawNodes as NodeLike[]) : [];
  const mainId = mainCompId(comps, nodes);
  const primary = mainId !== null ? comps[mainId] : undefined;

  const layerCount = nodes.filter((n) => !(typeof n?.id === 'string' && n.id in comps)).length;

  return {
    width: primary?.width ?? 0,
    height: primary?.height ?? 0,
    fps: primary?.fps ?? 0,
    durationSeconds: primary?.durationSeconds ?? 0,
    layerCount,
  };
}
