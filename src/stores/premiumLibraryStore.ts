/**
 * The premium library shelf as the panel reads it: the catalog (loaded once,
 * refreshed on sign-in) and which item is downloading right now.
 *
 * Editor state only — nothing here enters the project document.
 */

import { create } from 'zustand';
import { loadCatalog, type CatalogStatus } from '@core/library/premium/catalog';
import { forgetPremiumPayloads } from '@core/library/premium/payload';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';
import { useAuthStore } from './authStore';

interface PremiumLibraryState {
  status: CatalogStatus | 'idle';
  items: PremiumCatalogItem[];
  /** Ids being fetched for an insert — the card shows progress and refuses a second click. */
  busy: ReadonlySet<string>;
  load: (opts?: { force?: boolean }) => Promise<void>;
  setBusy: (id: string, on: boolean) => void;
}

let loading: Promise<void> | null = null;

export const usePremiumLibraryStore = create<PremiumLibraryState>((set, get) => ({
  status: 'idle',
  items: [],
  busy: new Set(),
  load: (opts) => {
    if (loading && !opts?.force) return loading;
    if (get().status === 'idle' || get().status === 'error') set({ status: 'loading' });
    loading = loadCatalog(opts).then((res) => {
      set({ status: res.status, items: res.items });
    }).finally(() => { loading = null; });
    return loading;
  },
  setBusy: (id, on) => {
    const next = new Set(get().busy);
    if (on) next.add(id);
    else next.delete(id);
    set({ busy: next });
  },
}));

// A new account may see a different shelf (unpublished items for an admin), and
// must never reuse the previous account's payloads.
useAuthStore.subscribe((s, prev) => {
  if (s.user?.id === prev.user?.id) return;
  forgetPremiumPayloads();
  if (usePremiumLibraryStore.getState().status !== 'idle') void usePremiumLibraryStore.getState().load({ force: true });
});
