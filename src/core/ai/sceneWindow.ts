/**
 * Active-scene window — the seam that turns the flat compose recipes into a
 * multi-scene sequence.
 *
 * A "scene" is a time window [startSec, endSec] on the one composition timeline.
 * `add_scene` registers a window here; every content recipe (title, emblem,
 * cards…) reads the CURRENT scene so its entrance is offset to that scene's
 * start and it gets an EXIT near the scene's end — instead of every element
 * self-scheduling from t≈0 and holding to comp end (the single-scene collapse).
 *
 * Scenes are keyed by index, and content can bind to a specific scene by number
 * (`selectScene`). That makes the multi-scene build robust to BOTH orderings a
 * model uses: interleaved (scene → its content → next scene) AND front-loaded
 * (all add_scene first, then content tagged with `scene: N`). Without the index
 * binding, a front-loaded plan dumps every element into the last scene.
 *
 * State is module-level rather than threaded through ToolContext because the
 * executor runs tool steps in order. `resetSceneWindow` (from createToolContext)
 * clears it so a new run never inherits a stale window.
 */

export interface SceneWindow {
  index: number;
  startSec: number;
  endSec: number;
  /** Fade length used for this scene's in/out (dissolve feel). */
  transitionSec: number;
}

const scenes = new Map<number, SceneWindow>();
/** How many animated elements each scene has placed — per-scene stagger. */
const elementCounts = new Map<number, number>();
/**
 * The layer ids each scene placed (its background and the content bound to
 * it), so a repeated add_scene with the same index can REPLACE the scene
 * instead of stacking a second copy of it (docs/PROGRAM_3D_PERF_UX.md M1).
 */
const elementIds = new Map<number, string[]>();
let currentIndex: number | null = null;

/** Register (or replace) a scene window and make it the current one. */
export function beginSceneWindow(index: number, startSec: number, endSec: number, transitionSec = 0.35): void {
  const w: SceneWindow = {
    index,
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.1, endSec),
    transitionSec,
  };
  scenes.set(index, w);
  elementCounts.set(index, 0);
  currentIndex = index;
}

/** Remember a layer as part of the active scene (see `sceneElementIds`). */
export function recordSceneElement(id: string): void {
  if (currentIndex === null) return;
  const list = elementIds.get(currentIndex) ?? [];
  if (!list.includes(id)) list.push(id);
  elementIds.set(currentIndex, list);
}

/** The layers scene `index` placed so far (in this run), oldest first; [] when it has none. */
export function sceneElementIds(index: number): string[] {
  return [...(elementIds.get(index) ?? [])];
}

/** Forget scene `index`'s layers (they were deleted for a rebuild). */
export function forgetSceneElements(index: number): void {
  elementIds.delete(index);
}

/** Bind subsequent content to an already-registered scene by index. Returns
 *  false when no scene with that index exists (caller keeps the current one). */
export function selectScene(index: number): boolean {
  if (!scenes.has(index)) return false;
  currentIndex = index;
  return true;
}

/** The scene content is currently being placed into, or null (single-scene). */
export function activeSceneWindow(): SceneWindow | null {
  return currentIndex !== null ? scenes.get(currentIndex) ?? null : null;
}

/** Next entrance start for an element in the active scene (start + n·stagger),
 *  or null when there is no active scene (caller keeps its legacy scheduling). */
export function nextSceneElementStart(staggerSec: number): number | null {
  const w = activeSceneWindow();
  if (!w) return null;
  const n = elementCounts.get(w.index) ?? 0;
  elementCounts.set(w.index, n + 1);
  // Keep entrances inside the first ~60% of the scene so they finish before the
  // exit — a scene whose last element is still entering as it fades out reads
  // as broken.
  const room = Math.max(0, (w.endSec - w.startSec) * 0.6);
  return w.startSec + Math.min(n * staggerSec, room);
}

/** Reset between runs (called from createToolContext). */
export function resetSceneWindow(): void {
  scenes.clear();
  elementCounts.clear();
  elementIds.clear();
  currentIndex = null;
}
