/**
 * The Text Behind Subject popover's open state: which footage layer it is for
 * (null = closed). Session state, never project data.
 */

import { create } from 'zustand';

interface TextBehindState {
  layer: string | null;
  open: (layer: string) => void;
  close: () => void;
}

export const useTextBehindStore = create<TextBehindState>((set) => ({
  layer: null,
  open: (layer) => set({ layer }),
  close: () => set({ layer: null }),
}));
