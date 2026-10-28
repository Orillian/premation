/**
 * Edit ▸ Edit Original — the pure rules (no engine, no stores, no bridge), so
 * the enable state, the target choice and the reload dedupe are unit-tested.
 * The command and the watcher wiring are `editOriginal.ts` / `footageWatchSync.ts`.
 *
 * AE's rule, kept: Edit Original opens the SOURCE FILE of footage. A layer
 * whose source is footage (an image, a clip, a sound, a model) qualifies; a
 * solid, text, shape, camera, light, null or precomp layer has no file and the
 * command greys out. A footage item whose bytes live only inside the project
 * (a `motion-blob:` collected into the bundle, an in-memory import) has no
 * file of its own either: editing the content-addressed blob in place would
 * break its address, so it does not qualify.
 */

import type { ItemInfo } from '@motion/engine-api';

export type EditableItem = Pick<ItemInfo, 'id' | 'kind' | 'name' | 'path' | 'missing' | 'proxyPath'>;

/** Most files Edit Original opens at once — a stray Select All must not launch 300 editors. */
export const MAX_EDIT_ORIGINAL_FILES = 10;

/** Pure: is this a path to a file on disk (not a URL, a blob or an inline image)? */
export function isDiskPath(p: string | undefined | null): p is string {
  if (!p || p.trim() === '') return false;
  // `C:\…`, `C:/…` and `\\server\share` are paths; anything else with a scheme is a URL.
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p);
}

/** Pure: can Edit Original open this item's file? */
export function isEditableOriginal(item: EditableItem | undefined | null): item is EditableItem {
  return !!item && item.kind === 'footage' && isDiskPath(item.path);
}

export interface TargetQuery {
  /** Selected layer ids (timeline / viewport), in selection order. */
  layerIds: readonly string[];
  /** Selected Project/Assets panel item ids, in row order. */
  panelIds: readonly string[];
  /** The Assets panel has keyboard focus: its selection wins over the layers'. */
  panelFocused: boolean;
  layerSource(layerId: string): string | undefined;
  item(id: string): EditableItem | undefined;
}

/**
 * Pure: the footage items Edit Original acts on — one entry per ITEM (ten
 * layers of the same clip open it once), in selection order.
 *
 * AE acts on the active panel's selection. Here: the Assets panel's when it
 * has focus; otherwise the selected layers' sources; and when no selected
 * layer has a file, the Assets panel's selection (the menu bar took focus).
 */
export function editOriginalTargets(q: TargetQuery): EditableItem[] {
  const fromIds = (ids: readonly string[]): EditableItem[] => {
    const seen = new Set<string>();
    const out: EditableItem[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const it = q.item(id);
      if (isEditableOriginal(it)) out.push(it);
    }
    return out;
  };
  const panel = (): EditableItem[] => fromIds(q.panelIds);
  const layers = (): EditableItem[] => fromIds(q.layerIds.map((l) => q.layerSource(l)).filter((s): s is string => !!s));
  if (q.panelFocused) {
    const p = panel();
    if (p.length > 0) return p;
  }
  const l = layers();
  return l.length > 0 ? l : panel();
}

/** Pure: the comparison key for a footage path (separators unified, case folded where the OS folds it). */
export function footagePathKey(p: string, caseInsensitive: boolean): string {
  let k = p.trim().replace(/\\/g, '/');
  const unc = k.startsWith('//');
  k = k.replace(/\/{2,}/g, '/');
  if (unc) k = `/${k}`;
  return caseInsensitive ? k.toLowerCase() : k;
}

export interface WatchPlan {
  paths: string[];
  priority: string[];
  /** Equal signatures = the same request: no IPC. */
  signature: string;
}

/**
 * Pure: what to watch — every footage file the project uses (its proxy too:
 * a re-rendered proxy reloads the item), deduped by key, with the files sent
 * to Edit Original first so their folders are watched before any cap.
 */
export function footageWatchPlan(
  items: Iterable<EditableItem>,
  priorityPaths: Iterable<string>,
  caseInsensitive: boolean,
): WatchPlan {
  const byKey = new Map<string, string>();
  for (const it of items) {
    if (it.kind !== 'footage') continue;
    for (const p of [it.path, it.proxyPath]) {
      if (!isDiskPath(p)) continue;
      const k = footagePathKey(p, caseInsensitive);
      if (!byKey.has(k)) byKey.set(k, p);
    }
  }
  const priority: string[] = [];
  const seen = new Set<string>();
  for (const p of priorityPaths) {
    const k = footagePathKey(p, caseInsensitive);
    const watched = byKey.get(k);
    if (watched !== undefined && !seen.has(k)) {
      seen.add(k);
      priority.push(watched);
    }
  }
  const paths = [...byKey.values()].sort();
  return { paths, priority, signature: `${paths.join('\n')}\u0000${priority.join('\n')}` };
}

/**
 * Pure: the item ids a batch of changed paths reloads — each item once,
 * however many of its paths (file, proxy) or duplicate events arrived.
 */
export function itemsForChangedPaths(
  items: Iterable<EditableItem>,
  changed: readonly string[],
  caseInsensitive: boolean,
): string[] {
  const keys = new Set(changed.map((p) => footagePathKey(p, caseInsensitive)));
  if (keys.size === 0) return [];
  const out: string[] = [];
  for (const it of items) {
    if (it.kind !== 'footage') continue;
    const hit = [it.path, it.proxyPath].some((p) => isDiskPath(p) && keys.has(footagePathKey(p, caseInsensitive)));
    if (hit) out.push(it.id);
  }
  return out;
}

/**
 * Coalesces reload requests: ids arriving within `windowMs` of each other go
 * to the engine as ONE `reloadItems`, each id once (a file watch event and the
 * focus check racing, five layers' worth of the same save).
 */
export class ReloadBatcher {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushFn: (ids: string[]) => void,
    private readonly windowMs = 50,
  ) {}

  add(ids: readonly string[]): void {
    for (const id of ids) this.pending.add(id);
    if (this.pending.size === 0 || this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const ids = [...this.pending];
    this.pending.clear();
    this.flushFn(ids);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
