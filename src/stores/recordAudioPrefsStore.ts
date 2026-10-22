/**
 * The Record Audio panel's input settings — a preference about the person and
 * their hardware, not the project: localStorage, never the document.
 *
 * Echo cancellation and auto gain start OFF: both are built for calls, and on
 * a voice-over they pump the level and smear the tail of every word. Noise
 * suppression starts on (an untreated room's hiss), and can be turned off for
 * a clean booth.
 */

import { create } from 'zustand';
import type { WavSampleFormat } from '@core/audio/recording/wav';

const KEY = 'premation_record_audio_prefs_v1';

export interface RecordAudioPrefs {
  /** The chosen input's `deviceId`; null = the system default. */
  deviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Input gain before capture, dB (−24 … +24). */
  inputGainDb: number;
  /** 3-2-1 before a take starts. */
  countIn: boolean;
  /** Play the composition from the playhead while recording. */
  playWhileRecording: boolean;
  /** The take's WAV encoding. */
  format: WavSampleFormat;
}

export const DEFAULT_RECORD_AUDIO_PREFS: Readonly<RecordAudioPrefs> = Object.freeze({
  deviceId: null,
  echoCancellation: false,
  noiseSuppression: true,
  autoGainControl: false,
  inputGainDb: 0,
  countIn: true,
  playWhileRecording: false,
  format: 'pcm24',
});

function readStored(): RecordAudioPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_RECORD_AUDIO_PREFS };
    const v = JSON.parse(raw) as Partial<RecordAudioPrefs>;
    const d = DEFAULT_RECORD_AUDIO_PREFS;
    const bool = (x: unknown, dflt: boolean): boolean => (typeof x === 'boolean' ? x : dflt);
    return {
      deviceId: typeof v.deviceId === 'string' && v.deviceId ? v.deviceId : null,
      echoCancellation: bool(v.echoCancellation, d.echoCancellation),
      noiseSuppression: bool(v.noiseSuppression, d.noiseSuppression),
      autoGainControl: bool(v.autoGainControl, d.autoGainControl),
      inputGainDb: typeof v.inputGainDb === 'number' && Number.isFinite(v.inputGainDb) ? Math.min(24, Math.max(-24, v.inputGainDb)) : d.inputGainDb,
      countIn: bool(v.countIn, d.countIn),
      playWhileRecording: bool(v.playWhileRecording, d.playWhileRecording),
      format: v.format === 'float32' ? 'float32' : 'pcm24',
    };
  } catch {
    return { ...DEFAULT_RECORD_AUDIO_PREFS };
  }
}

export interface RecordAudioPrefsStore extends RecordAudioPrefs {
  set: (patch: Partial<RecordAudioPrefs>) => void;
}

export const useRecordAudioPrefsStore = create<RecordAudioPrefsStore>((set, get) => ({
  ...readStored(),
  set: (patch) => {
    set(patch);
    const s = get();
    const prefs: RecordAudioPrefs = {
      deviceId: s.deviceId,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
      inputGainDb: s.inputGainDb,
      countIn: s.countIn,
      playWhileRecording: s.playWhileRecording,
      format: s.format,
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* a private window keeps it for the session */
    }
  },
}));
