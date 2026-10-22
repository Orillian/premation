/**
 * Input meter ballistics for the Record Audio panel: instant attack, a
 * smooth fall, a peak-hold tick that waits then falls, and a clip latch that
 * stays lit until it is reset (as AE's / every DAW's clip LED does).
 *
 * Mutable state, updated in place — the meter is driven from a
 * requestAnimationFrame loop and must not allocate per frame. Times are
 * milliseconds passed in by the caller, so the ballistics are deterministic
 * under test.
 */

/** The meter's floor, dBFS: anything quieter draws as empty. */
export const METER_FLOOR_DB = -60;
/** A sample at or above this |value| counts as a clip (−0.1 dBFS). */
export const CLIP_LEVEL = 0.98855;

export interface MeterChannel {
  /** The displayed level, dBFS (falls at `fallDbPerSec`). */
  levelDb: number;
  /** The held peak, dBFS. */
  holdDb: number;
  /** When the held peak was last raised, ms. */
  holdAtMs: number;
  /** Latched until `resetClip`. */
  clipped: boolean;
}

export interface MeterState {
  channels: MeterChannel[];
  lastMs: number;
}

export const METER_FALL_DB_PER_SEC = 24;
export const METER_HOLD_MS = 1500;
export const METER_HOLD_FALL_DB_PER_SEC = 18;

export function createMeter(channelCount: number): MeterState {
  return {
    channels: Array.from({ length: Math.max(1, channelCount) }, () => ({ levelDb: METER_FLOOR_DB, holdDb: METER_FLOOR_DB, holdAtMs: 0, clipped: false })),
    lastMs: 0,
  };
}

/** |sample| → dBFS, floored at the meter's floor. */
export function amplitudeToDb(a: number): number {
  if (a <= 0) return METER_FLOOR_DB;
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(a));
}

/** dBFS → 0…1 along the meter (linear in dB from the floor to 0 dBFS). */
export function meterFraction(db: number): number {
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/**
 * Fold in the peaks measured since the last call (`peaks[c]` = the block's
 * max |sample| for channel c) at time `nowMs`. Missing channels fall.
 */
export function updateMeter(state: MeterState, peaks: ArrayLike<number>, nowMs: number): void {
  const dt = state.lastMs > 0 ? Math.max(0, nowMs - state.lastMs) / 1000 : 0;
  state.lastMs = nowMs;
  for (let c = 0; c < state.channels.length; c++) {
    const ch = state.channels[c]!;
    const p = c < peaks.length ? peaks[c]! : 0;
    const db = amplitudeToDb(p);
    const fallen = Math.max(METER_FLOOR_DB, ch.levelDb - METER_FALL_DB_PER_SEC * dt);
    ch.levelDb = db > fallen ? db : fallen;
    if (db >= ch.holdDb) {
      ch.holdDb = db;
      ch.holdAtMs = nowMs;
    } else if (nowMs - ch.holdAtMs > METER_HOLD_MS) {
      ch.holdDb = Math.max(ch.levelDb, ch.holdDb - METER_HOLD_FALL_DB_PER_SEC * dt);
    }
    if (p >= CLIP_LEVEL) ch.clipped = true;
  }
}

export function resetClip(state: MeterState): void {
  for (const ch of state.channels) ch.clipped = false;
}
