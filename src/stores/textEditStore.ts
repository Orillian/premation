/**
 * textEditStore — which text layer is being edited on-canvas, and what part of
 * it is selected.
 *
 * Text editing used to be a `window.prompt`, which Electron's Chromium refuses
 * to show — so double-clicking a text layer in the desktop app (what this
 * ships as) did nothing at all. This drives a real on-canvas editor instead.
 *
 * The selection is what makes per-character styling addressable: the inspector
 * reads it to decide whether an edit means "this layer" or "these characters".
 * Offsets are GRAPHEME indices into `splitGraphemes(content)` — the same index
 * space runs, animator selectors and layout use (see core/text/graphemes.ts) —
 * NOT `string.length` and not code points, so a caret can never land inside an
 * emoji sequence or between a letter and its combining accent.
 */

import { create } from 'zustand';

/**
 * Mark a surface (the Character panel) with this attribute and focus moving
 * into it does NOT end on-canvas text editing — the character selection stays
 * live so the panel can style it. A pointerdown anywhere else still commits.
 */
export const TEXT_EDIT_KEEP_ATTR = 'data-text-edit-keep';

export interface TextSelection {
  /** Inclusive start, in grapheme clusters. */
  start: number;
  /** Exclusive end, in grapheme clusters. `start === end` is a caret, not a range. */
  end: number;
}

interface TextEditState {
  /** The text layer currently being edited, or null. */
  nodeId: string | null;
  /**
   * The layer was made by the Type tool a moment ago and has never been
   * typed into: the editor opens EMPTY with a caret (After Effects), not on
   * the placeholder "Text" selected — and a commit that leaves it empty
   * deletes the layer, as AE drops an empty text layer.
   */
  fresh: boolean;
  /** The live selection within that layer, or null when not editing. */
  selection: TextSelection | null;
  begin: (nodeId: string, opts?: { fresh?: boolean }) => void;
  end: () => void;
  setSelection: (selection: TextSelection | null) => void;
}

export const useTextEditStore = create<TextEditState>((set) => ({
  nodeId: null,
  fresh: false,
  selection: null,
  begin: (nodeId, opts) => set({ nodeId, fresh: opts?.fresh === true, selection: null }),
  end: () => set({ nodeId: null, fresh: false, selection: null }),
  setSelection: (selection) => set({ selection }),
}));

/** True when a range (not just a caret) is selected. */
export function hasRange(selection: TextSelection | null): selection is TextSelection {
  return selection !== null && selection.end > selection.start;
}
