/**
 * The Record Audio panel's state machine, as a pure reducer.
 *
 *   off ──open──▶ opening ──opened──▶ ready ──record──▶ countIn ──(ticks)──▶ recording
 *                    │                  ▲                  │ stop                │ ▲
 *                    └─failed──▶ off    │                  ▼                pause│ │resume
 *                                       └──finished── finishing ◀──stop──── paused ┘
 *
 * `deviceLost` from recording / paused goes to `finishing` (what was captured
 * is kept) and leaves an error; from anywhere else it closes the input. An
 * error never blocks a state: it is shown until dismissed or the next open.
 */

export type RecorderPhase = 'off' | 'opening' | 'ready' | 'countIn' | 'recording' | 'paused' | 'finishing';

export type RecorderErrorKind =
  /** The page's getUserMedia was refused (NotAllowedError). */
  | 'permission'
  /** The OS privacy switch is off (macOS / Windows). */
  | 'osDenied'
  /** No input device, or the chosen one is gone (NotFoundError / OverconstrainedError). */
  | 'noDevice'
  /** The device is held by another app or failed to start (NotReadableError). */
  | 'busy'
  /** The input went away mid-take (unplugged); the take so far was kept. */
  | 'deviceLost'
  /** No getUserMedia / AudioWorklet in this runtime. */
  | 'unsupported'
  /** The take reached the longest a WAV can hold; it was stopped and kept. */
  | 'tooLong'
  | 'failed';

export interface RecorderState {
  phase: RecorderPhase;
  /** Seconds left in the count-in (3, 2, 1) while `countIn`. */
  countdown: number;
  error: { kind: RecorderErrorKind; detail?: string } | null;
}

export type RecorderEvent =
  | { type: 'open' }
  | { type: 'opened' }
  | { type: 'openFailed'; kind: RecorderErrorKind; detail?: string }
  | { type: 'record'; countIn: number }
  | { type: 'tick' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'finished' }
  | { type: 'deviceLost' }
  | { type: 'limitReached' }
  | { type: 'close' }
  | { type: 'dismissError' };

export const INITIAL_RECORDER_STATE: RecorderState = { phase: 'off', countdown: 0, error: null };

export function recorderReducer(s: RecorderState, e: RecorderEvent): RecorderState {
  switch (e.type) {
    case 'open':
      return s.phase === 'off' ? { phase: 'opening', countdown: 0, error: null } : s;
    case 'opened':
      return s.phase === 'opening' ? { ...s, phase: 'ready' } : s;
    case 'openFailed':
      return s.phase === 'opening' ? { phase: 'off', countdown: 0, error: { kind: e.kind, ...(e.detail ? { detail: e.detail } : {}) } } : s;
    case 'record':
      if (s.phase !== 'ready') return s;
      return e.countIn > 0
        ? { phase: 'countIn', countdown: Math.round(e.countIn), error: null }
        : { phase: 'recording', countdown: 0, error: null };
    case 'tick':
      if (s.phase !== 'countIn') return s;
      return s.countdown > 1 ? { ...s, countdown: s.countdown - 1 } : { ...s, phase: 'recording', countdown: 0 };
    case 'pause':
      return s.phase === 'recording' ? { ...s, phase: 'paused' } : s;
    case 'resume':
      return s.phase === 'paused' ? { ...s, phase: 'recording' } : s;
    case 'stop':
      if (s.phase === 'countIn') return { ...s, phase: 'ready', countdown: 0 };
      return s.phase === 'recording' || s.phase === 'paused' ? { ...s, phase: 'finishing' } : s;
    case 'finished':
      return s.phase === 'finishing' ? { ...s, phase: 'ready' } : s;
    case 'limitReached':
      return s.phase === 'recording' || s.phase === 'paused' ? { ...s, phase: 'finishing', error: { kind: 'tooLong' } } : s;
    case 'deviceLost':
      if (s.phase === 'recording' || s.phase === 'paused') return { phase: 'finishing', countdown: 0, error: { kind: 'deviceLost' } };
      return s.phase === 'off' ? s : { phase: 'off', countdown: 0, error: { kind: 'deviceLost' } };
    case 'close':
      // A take being finished finishes first; the caller closes after `finished`.
      return s.phase === 'finishing' ? s : { ...s, phase: 'off', countdown: 0 };
    case 'dismissError':
      return s.error ? { ...s, error: null } : s;
  }
}

/** Whether the input is open (the meter is live). */
export function inputOpen(s: RecorderState): boolean {
  return s.phase !== 'off' && s.phase !== 'opening';
}

/** Whether a take is in progress (count-in included) — settings are locked. */
export function takeInProgress(s: RecorderState): boolean {
  return s.phase === 'countIn' || s.phase === 'recording' || s.phase === 'paused' || s.phase === 'finishing';
}

/** getUserMedia's DOMException name → the error the panel shows. */
export function captureErrorKind(err: unknown): RecorderErrorKind {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'permission';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'noDevice';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  if (name === 'UnsupportedError') return 'unsupported';
  if (name === 'OsDeniedError') return 'osDenied';
  return 'failed';
}
