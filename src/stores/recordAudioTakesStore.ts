/**
 * The Record Audio panel's takes for this session: editor state, never the
 * project. A take reaches the project only through "Add to Project" /
 * "Add to Composition", which import its WAV like any file.
 *
 * The store holds each take's small facts (name, length, where it starts,
 * the edit settings). The audio itself — the original WAV Blob, the rendered
 * edit, the waveform peaks — sits in `takeAudio`, a plain map outside React
 * state: a Blob is a handle Chromium may keep on disk, and nothing that size
 * belongs in a store a component re-renders from.
 */

import { create } from 'zustand';
import { DEFAULT_TAKE_EDIT, type TakeEditParams } from '@core/audio/recording/dsp';
import type { WavSampleFormat } from '@core/audio/recording/wav';

export interface TakeMeta {
  id: string;
  name: string;
  durationSec: number;
  sampleRate: number;
  channelCount: number;
  format: WavSampleFormat;
  /** Composition seconds where the take belongs (the playhead when it started). */
  startSec: number;
  /** The edit being set up (applied when auditioned or added). */
  edit: TakeEditParams;
  /** The edit the rendered audio was made with; null = no render (the original plays). */
  renderedEdit: TakeEditParams | null;
  /** The take was cut short (device unplugged, length ceiling). */
  partial: boolean;
}

export interface TakeAudio {
  original: Blob;
  /** Min / max pairs over the ORIGINAL, `framesPerBucket` frames each. */
  peaks: Float32Array;
  framesPerBucket: number;
  edited: Blob | null;
}

const audio = new Map<string, TakeAudio>();

/** The audio behind a take (undefined once the take is deleted). */
export function takeAudio(id: string): TakeAudio | undefined {
  return audio.get(id);
}

export interface RecordAudioTakesStore {
  takes: TakeMeta[];
  /** The take the edit section shows. */
  selectedId: string | null;
  add: (meta: Omit<TakeMeta, 'edit' | 'renderedEdit'>, data: Omit<TakeAudio, 'edited'>) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  setEdit: (id: string, patch: Partial<TakeEditParams>) => void;
  /** Store a rendered edit (or drop it with `null`, which also resets the settings when `revert`). */
  setRendered: (id: string, edited: Blob | null, edit: TakeEditParams | null, revert?: boolean) => void;
}

export const useRecordAudioTakesStore = create<RecordAudioTakesStore>((set) => ({
  takes: [],
  selectedId: null,
  add: (meta, data) => {
    audio.set(meta.id, { ...data, edited: null });
    set((s) => ({ takes: [...s.takes, { ...meta, edit: { ...DEFAULT_TAKE_EDIT }, renderedEdit: null }], selectedId: meta.id }));
  },
  rename: (id, name) => {
    const n = name.trim();
    if (!n) return;
    set((s) => ({ takes: s.takes.map((tk) => (tk.id === id ? { ...tk, name: n } : tk)) }));
  },
  remove: (id) => {
    audio.delete(id);
    set((s) => {
      const takes = s.takes.filter((tk) => tk.id !== id);
      return { takes, selectedId: s.selectedId === id ? (takes[takes.length - 1]?.id ?? null) : s.selectedId };
    });
  },
  select: (id) => set({ selectedId: id }),
  setEdit: (id, patch) => set((s) => ({ takes: s.takes.map((tk) => (tk.id === id ? { ...tk, edit: { ...tk.edit, ...patch } } : tk)) })),
  setRendered: (id, edited, edit, revert = false) => {
    const a = audio.get(id);
    if (a) a.edited = edited;
    set((s) => ({
      takes: s.takes.map((tk) => (tk.id === id ? { ...tk, renderedEdit: edit, ...(revert ? { edit: { ...DEFAULT_TAKE_EDIT } } : {}) } : tk)),
    }));
  },
}));
