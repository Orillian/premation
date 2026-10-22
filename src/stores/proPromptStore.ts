/**
 * The one "this is a Pro item" dialog the editor shows, as state any path can
 * open — a Library card, a canvas drop, a timeline drop — without owning the
 * dialog. `PremiumPromptHost` (LibraryCards.tsx) renders it once over the app.
 *
 * Editor state only — nothing here enters the project document.
 */

import { create } from 'zustand';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';

interface ProPromptState {
  /** The item the dialog is about, or null while it is closed. */
  item: PremiumCatalogItem | null;
  open: (item: PremiumCatalogItem) => void;
  close: () => void;
}

export const useProPromptStore = create<ProPromptState>((set) => ({
  item: null,
  open: (item) => set({ item }),
  close: () => set({ item: null }),
}));

/** Open the Pro dialog for `item` (callable outside React). */
export function promptForPro(item: PremiumCatalogItem): void {
  useProPromptStore.getState().open(item);
}
