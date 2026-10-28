/**
 * Keeps the Electron footage watcher (electron/ipc/footageFiles.ts) in step
 * with the project, and turns a change on disk into ONE engine `reloadItems`.
 *
 *   project items (document mirror 'items')  ──►  footage.watch({ paths, priority })
 *   footage:changed  /  window focus → check ──►  item ids  ──►  reloadItems
 *
 * - The watched set is every footage file (and proxy file) the project uses;
 *   files just opened with Edit Original are PRIORITY, so their folders are
 *   watched first when a project spans more folders than the watcher's cap.
 * - The set is re-sent only when it changes (a signature compare), debounced,
 *   so an import of 500 files is one IPC, and nothing runs per frame.
 * - Removing an item drops its path; closing the project empties the set,
 *   which closes every directory watch in main. Uninstall empties it too.
 * - Window focus re-checks the whole set — AE's reload-on-activate — which also
 *   covers network shares where change events never arrive.
 * - Many layers of one item, a file plus its proxy, a watch event racing a
 *   focus check: `itemsForChangedPaths` + `ReloadBatcher` make that one reload
 *   of each item.
 *
 * The engine owns the decoders and caches: `reloadItems` (engine-api
 * 30_items.eapi, a control — no undo entry, no dirty flag) is where they are
 * dropped and the file re-read.
 */

import { documentMirror, hasDocumentMirror } from '@stores/documentMirror';
import { useUIStore } from '@stores/uiStore';
import { engine, hasEngine } from '@core/engine/engineInstance';
import { t } from '@core/i18n';
import {
  footageWatchPlan,
  itemsForChangedPaths,
  ReloadBatcher,
  type EditableItem,
} from './editOriginalLogic';

/** Paths sent to Edit Original this session (their folders are watched first). */
const priorityPaths = new Set<string>();
let resync: (() => void) | null = null;

/** Windows and macOS file systems fold case; a path key must too. */
export function pathsFoldCase(): boolean {
  return typeof navigator !== 'undefined' && /win|mac/i.test(navigator.platform ?? '');
}

/** Edit Original opened `path`: watch its folder first, now. */
export function noteEditedOriginal(path: string): void {
  if (path.trim() === '') return;
  priorityPaths.add(path);
  resync?.();
}

function bridge(): NonNullable<NonNullable<Window['motionEditor']>['footage']> | null {
  const f = typeof window !== 'undefined' ? window.motionEditor?.footage : undefined;
  return f && typeof f.watch === 'function' && typeof f.onChanged === 'function' ? f : null;
}

function currentItems(): EditableItem[] {
  return hasDocumentMirror() ? [...documentMirror().items.values()] : [];
}

const RESYNC_DEBOUNCE_MS = 250;
const FOCUS_CHECK_MIN_INTERVAL_MS = 1000;

/**
 * Start watching. Idempotent per call site: returns the uninstall, which stops
 * every watch of this window. The editor window installs it once (Providers).
 */
export function installFootageWatchSync(): () => void {
  const f = bridge();
  if (!f) return () => {};
  const fold = pathsFoldCase();
  let disposed = false;
  let lastSignature = '';
  let resyncTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFocusCheck = 0;

  const reloader = new ReloadBatcher((ids) => {
    if (disposed || !hasEngine()) return;
    void engine()
      .execute({ type: 'reloadItems', items: ids })
      .then((res) => {
        if (!res.ok) {
          console.warn('[footage] reloadItems failed:', res.error.message);
          return;
        }
        const names = ids.map((id) => documentMirror().item(id)?.name).filter((n): n is string => !!n);
        if (names.length === 0) return;
        useUIStore.getState().notify({
          level: 'info',
          message: names.length === 1
            ? t('assets.editOriginal.reloadedOne', 'Reloaded “{name}”', { name: names[0] ?? '' })
            : t('assets.editOriginal.reloadedMany', 'Reloaded {n} footage items', { n: names.length }),
          durationMs: 2500,
        });
      })
      .catch((e: unknown) => console.warn('[footage] reloadItems failed:', e));
  });

  const onChangedPaths = (paths: readonly string[]): void => {
    if (disposed || paths.length === 0) return;
    reloader.add(itemsForChangedPaths(currentItems(), paths, fold));
  };

  const sendPlan = (): void => {
    resyncTimer = null;
    if (disposed) return;
    const plan = footageWatchPlan(currentItems(), priorityPaths, fold);
    if (plan.signature === lastSignature) return;
    lastSignature = plan.signature;
    void f.watch?.({ paths: plan.paths, priority: plan.priority })?.catch(() => {
      // Main refused or is gone: re-send on the next change rather than never.
      lastSignature = '';
    });
  };
  const scheduleResync = (): void => {
    if (disposed || resyncTimer !== null) return;
    resyncTimer = setTimeout(sendPlan, RESYNC_DEBOUNCE_MS);
  };
  resync = scheduleResync;

  const offChanged = f.onChanged?.((paths) => onChangedPaths(Array.isArray(paths) ? paths : [])) ?? (() => {});
  let offItems: () => void = () => {};
  try {
    offItems = documentMirror().subscribe(['items'], scheduleResync);
  } catch {
    // No engine source in this window (a route without the editor core): nothing to watch.
  }

  const onFocus = (): void => {
    const now = Date.now();
    if (disposed || now - lastFocusCheck < FOCUS_CHECK_MIN_INTERVAL_MS) return;
    lastFocusCheck = now;
    void f.check?.().then(onChangedPaths, () => {});
  };
  window.addEventListener('focus', onFocus);
  scheduleResync();

  return () => {
    if (disposed) return;
    disposed = true;
    if (resync === scheduleResync) resync = null;
    if (resyncTimer !== null) clearTimeout(resyncTimer);
    resyncTimer = null;
    reloader.dispose();
    offChanged();
    offItems();
    window.removeEventListener('focus', onFocus);
    // Stop every directory watch of this window.
    void f.watch?.({ paths: [], priority: [] })?.catch(() => {});
  };
}
