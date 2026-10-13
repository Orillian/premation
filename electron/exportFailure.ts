/**
 * An export failure, said so a non-technical person knows what to do next.
 *
 * The engine and ffmpeg report failures in their own words ("starting the
 * encoder: the executable was not found", "ffmpeg exited 1: … No space left on
 * device"). The record keeps that text as `errorDetail` (for "Copy details"
 * and support), and `error` becomes one sentence with the next step; `errorCode`
 * lets the UI attach the right button (Fix / Choose location / Retry).
 *
 * Electron-free.
 */

export type ExportErrorCode = 'ffmpeg-unavailable' | 'disk-full' | 'output-unwritable' | 'output-busy';

export interface ExplainedFailure {
  message: string;
  code?: ExportErrorCode;
  /** The original text, when `message` replaced it. */
  detail?: string;
}

export const FFMPEG_UNAVAILABLE_MESSAGE =
  "Premation's video export component (FFmpeg) is missing or blocked on this computer. Press Fix to repair it — your project is safe.";

const RULES: ReadonlyArray<{ test: RegExp; code: ExportErrorCode; message: string }> = [
  {
    // The encoder could not be started at all — whatever the OS said why.
    test: /starting the encoder|could not start ffmpeg|spawn ffmpeg|ffmpeg(\.exe)?\b.*\b(ENOENT|not found|EACCES)/i,
    code: 'ffmpeg-unavailable',
    message: FFMPEG_UNAVAILABLE_MESSAGE,
  },
  {
    test: /No space left on device|ENOSPC|EDQUOT|not enough space on the disk|disk (is )?full/i,
    code: 'disk-full',
    message: 'The disk is full. Free up some space, or export to a different drive, then press Retry.',
  },
  {
    test: /being used by another process|sharing violation|EBUSY|Device or resource busy/i,
    code: 'output-busy',
    message: 'The output file is open in another app. Close it there, then press Retry.',
  },
  {
    test: /Permission denied|Access is denied|EACCES|EPERM|Operation not permitted|Read-only file system|EROFS/i,
    code: 'output-unwritable',
    message: "Premation can't save to that folder. Export again and choose another location, such as Documents or Desktop.",
  },
];

export function explainExportFailure(raw: string): ExplainedFailure {
  for (const r of RULES) {
    if (r.test.test(raw)) return { message: r.message, code: r.code, detail: raw };
  }
  return { message: raw };
}
