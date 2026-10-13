/**
 * Video export's ffmpeg, from the page's side: the health status main keeps
 * (electron/ffmpegService.ts), the one-click repair, and the dialog that offers
 * it (src/layout/Export/FfmpegRepairDialog.tsx).
 *
 * Three ways in, one dialog:
 *   - export asks `ensureFfmpegFor(format)` before queueing; if the format
 *     cannot be written it opens the dialog and waits — fixed → the export goes
 *     ahead, closed → it does not;
 *   - a failed export whose `errorCode` is 'ffmpeg-unavailable' offers "Fix";
 *   - main's startup check reports a broken copy → one toast with "Fix"
 *     (FfmpegRepairHost).
 *
 * Desktop only: without the bridge every format is treated as ready (the web
 * build has no engine export at all, and says so elsewhere).
 */

import { create } from 'zustand';
import type { FfmpegRepairErrorCode, FfmpegRepairProgress, FfmpegStatus } from '@/types/motionEditor';

export interface FfmpegRepairFailure {
  code: FfmpegRepairErrorCode;
  detail: string;
  neededBytes?: number;
}

interface FfmpegState {
  status: FfmpegStatus | null;
  progress: FfmpegRepairProgress | null;
  /** The last repair / choose attempt's failure, shown in the dialog until the next attempt. */
  failure: FfmpegRepairFailure | null;
  /** Set when a repair or choice just succeeded — the dialog's "fixed" state. */
  fixed: boolean;
  dialogOpen: boolean;
  /** The format an export is waiting on, for the dialog's wording. */
  dialogFormat: string | null;
}

interface FfmpegActions {
  /** Subscribe to main's pushes and fetch the first status. Idempotent. */
  init(): void;
  refresh(force?: boolean): Promise<FfmpegStatus | null>;
  openDialog(format?: string | null): void;
  closeDialog(): void;
  repair(): Promise<boolean>;
  cancelRepair(): void;
  chooseFile(): Promise<boolean>;
}

const bridge = () => (typeof window !== 'undefined' ? window.motionEditor?.ffmpeg : undefined);

/** The encoders a format cannot be written without — mirrors electron/ffmpegHealth.ts encodersForFormat. */
export function encodersForFormat(format: string): string[] | null {
  switch (format) {
    case 'mp4':
    case 'hdr10':
    case 'hlg':
      return ['libx264', 'aac'];
    case 'webm':
      return ['libvpx-vp9', 'libopus'];
    case 'mov':
      return ['prores_ks'];
    case 'gif':
      return ['gif'];
    default:
      return null;
  }
}

/** Can `status` write `format`? */
export function ffmpegReadyFor(status: FfmpegStatus | null, format: string): boolean {
  const needs = encodersForFormat(format);
  if (!needs) return true;
  if (!status?.active) return false;
  const have = new Set(status.active.encoders);
  return needs.every((e) => have.has(e));
}

let initialised = false;
/** Waiters from `ensureFfmpegFor`: resolved true when fixed, false when the dialog closes unfixed. */
let waiters: Array<(fixed: boolean) => void> = [];

function settleWaiters(fixed: boolean): void {
  const w = waiters;
  waiters = [];
  for (const fn of w) fn(fixed);
}

export const useFfmpegStore = create<FfmpegState & FfmpegActions>((set, get) => ({
  status: null,
  progress: null,
  failure: null,
  fixed: false,
  dialogOpen: false,
  dialogFormat: null,

  init() {
    const b = bridge();
    if (initialised || !b) return;
    initialised = true;
    b.onStatus((status) => set({ status }));
    b.onRepairProgress((progress) => set({ progress }));
    void get().refresh();
  },

  async refresh(force = false) {
    const b = bridge();
    if (!b) return null;
    try {
      const status = await b.status(force);
      set({ status });
      return status;
    } catch {
      return get().status;
    }
  },

  openDialog(format = null) {
    set({ dialogOpen: true, dialogFormat: format, failure: null, fixed: false, progress: null });
    // What the dialog explains must be current, not the startup answer.
    void get().refresh(true);
  },

  closeDialog() {
    const { status, dialogFormat, fixed } = get();
    set({ dialogOpen: false, failure: null, progress: null });
    settleWaiters(fixed || (dialogFormat ? ffmpegReadyFor(status, dialogFormat) : Boolean(status?.ok)));
  },

  async repair() {
    const b = bridge();
    if (!b) return false;
    set({ failure: null, fixed: false, progress: null });
    let result;
    try {
      result = await b.repair();
    } catch (err) {
      set({ failure: { code: 'unavailable', detail: err instanceof Error ? err.message : String(err) }, progress: null });
      return false;
    }
    set({ status: result.status, progress: null });
    if (result.ok) {
      set({ fixed: true });
      return true;
    }
    // Cancel is the person's own choice: nothing to explain.
    if (result.code !== 'cancelled') set({ failure: { code: result.code, detail: result.detail, ...(result.neededBytes ? { neededBytes: result.neededBytes } : {}) } });
    return false;
  },

  cancelRepair() {
    void bridge()?.cancelRepair();
  },

  async chooseFile() {
    const b = bridge();
    if (!b) return false;
    set({ failure: null });
    const result = await b.chooseFile().catch((err: unknown) => ({ ok: false as const, code: 'not-ffmpeg' as const, detail: err instanceof Error ? err.message : String(err), status: get().status! }));
    if (!result) return false;  // dialog closed
    if (result.status) set({ status: result.status });
    if (result.ok) {
      set({ fixed: true });
      return true;
    }
    set({ failure: { code: result.code, detail: result.detail } });
    return false;
  },
}));

/**
 * Before queueing an export: true when `format` can be written now; otherwise
 * opens the repair dialog and resolves when it closes — true if it was fixed.
 * Formats the engine writes itself (sequences, stills, WAV, plugin outputs)
 * never wait.
 */
export async function ensureFfmpegFor(format: string): Promise<boolean> {
  if (!encodersForFormat(format) || !bridge()) return true;
  const store = useFfmpegStore.getState();
  store.init();
  let status = store.status;
  if (ffmpegReadyFor(status, format)) return true;
  // The cached answer said no: ask again (it may have been fixed outside the app).
  status = await store.refresh(true);
  if (ffmpegReadyFor(status, format)) return true;
  return new Promise<boolean>((resolve) => {
    waiters.push(resolve);
    useFfmpegStore.getState().openDialog(format);
  });
}
