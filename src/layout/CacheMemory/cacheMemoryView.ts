/**
 * Which view the Cache & Memory panel shows — module state, so the status
 * bar's health dot can open the panel straight on Health. Editor state only
 * (never in the document); it starts on Overview each session.
 */

import { useSyncExternalStore } from 'react';
import { useLayoutStore } from '@stores/layoutStore';

export type CacheMemoryView = 'overview' | 'location' | 'diagnostics' | 'health';

let view: CacheMemoryView = 'overview';
const listeners = new Set<() => void>();

export function cacheMemoryView(): CacheMemoryView {
  return view;
}

export function setCacheMemoryView(next: CacheMemoryView): void {
  if (next === view) return;
  view = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCacheMemoryView(): CacheMemoryView {
  return useSyncExternalStore(subscribe, cacheMemoryView, cacheMemoryView);
}

/** Open (or bring forward) the Cache & Memory panel on one of its views. */
export function openCacheMemoryPanel(on: CacheMemoryView): void {
  setCacheMemoryView(on);
  useLayoutStore.getState().openPanel('cacheMemory');
}
