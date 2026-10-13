/**
 * What the ffmpeg repair dialog says — for people who have never heard of
 * ffmpeg and should not need to. Every problem and every failed fix maps to
 * one plain sentence and one next step; the technical detail stays behind
 * "Technical details" for support.
 *
 * Kept apart from the component so the wording is reviewable (and testable) as
 * a table rather than buried in JSX.
 */

import type { FfmpegProblemCode, FfmpegRepairErrorCode } from '@/types/motionEditor';

const MB = 1024 * 1024;

export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

const FORMAT_NAMES: Record<string, string> = {
  mp4: 'MP4 video', hdr10: 'HDR video', hlg: 'HDR video', webm: 'WebM video', mov: 'QuickTime (ProRes) video', gif: 'animated GIFs',
};

export function formatName(format: string | null | undefined): string {
  return (format && FORMAT_NAMES[format]) || 'video';
}

/** Why export cannot write video right now. */
export function problemText(code: FfmpegProblemCode | undefined, format: string | null): string {
  const part = 'the part of Premation that writes video files';
  switch (code) {
    case 'blocked':
      return `Your security software or system settings are stopping ${part} from running.`;
    case 'wrong-arch':
      return `${capital(part)} was made for a different kind of processor than this computer has.`;
    case 'damaged':
      return `${capital(part)} is damaged and can't run.`;
    case 'timeout':
      return `${capital(part)} didn't respond. Security software scanning it can cause this.`;
    case 'incomplete':
      return `The FFmpeg Premation is using can't write ${formatName(format)} — it was built without the parts that needs.`;
    case 'missing':
    default:
      return `${capital(part)} is missing from this computer. Antivirus software sometimes removes it, or the installation didn't finish.`;
  }
}

/** The promise the primary button makes. */
export function fixText(repairBytes: number | undefined): string {
  const size = repairBytes ? ` (${megabytes(repairBytes)})` : '';
  return `Premation can download a fresh copy${size} and set it up for you. Your project isn't affected, and images, PNG/JPG/EXR sequences and WAV audio still export in the meantime.`;
}

export type RepairNextStep = 'retry' | 'choose' | 'recheck' | 'none';

/** A failed repair: what happened, in one sentence, and the button that helps most. */
export function failureText(code: FfmpegRepairErrorCode, neededBytes?: number): { message: string; next: RepairNextStep } {
  switch (code) {
    case 'offline':
      return { message: "You're not connected to the internet. Connect, then press Try again.", next: 'retry' };
    case 'network-blocked':
      return {
        message: 'Your network blocked the download — common on work or school networks. Try another network, or download the file on another device (Copy download link) and pick it with Choose file.',
        next: 'choose',
      };
    case 'unavailable':
      return { message: "The download server isn't answering right now. Please try again in a few minutes.", next: 'retry' };
    case 'stalled':
      return { message: 'The download stopped partway. Press Try again — it continues where it left off.', next: 'retry' };
    case 'disk-full':
      return {
        message: `There isn't enough free disk space${neededBytes ? ` — about ${megabytes(neededBytes)} is needed` : ''}. Free up some space (empty the Recycle Bin / Trash, remove old downloads), then press Try again.`,
        next: 'retry',
      };
    case 'no-permission':
      return {
        message: "Premation isn't allowed to save files in its own app folder. Restart Premation and try again; on a managed computer, ask your IT administrator.",
        next: 'retry',
      };
    case 'corrupted':
      return { message: 'The download was damaged on the way. Press Try again; if it keeps happening, try another network.', next: 'retry' };
    case 'blocked-after-install':
      return {
        message: 'The download worked, but your security software is stopping it from running. Open your antivirus, allow Premation (or restore the blocked file), then press Check again.',
        next: 'recheck',
      };
    case 'unsupported':
      return {
        message: "Premation can't download this for your computer automatically. If you have FFmpeg installed, pick it with Choose file.",
        next: 'choose',
      };
    case 'not-ffmpeg':
      return {
        message: 'That file isn\'t a working FFmpeg. Pick ffmpeg (ffmpeg.exe on Windows) or the .zip from the download link.',
        next: 'choose',
      };
    case 'cancelled':
    default:
      return { message: '', next: 'none' };
  }
}

/** The progress line while repairing. */
export function progressText(phase: string, received: number, total: number): string {
  switch (phase) {
    case 'checking-space':
      return 'Checking free space…';
    case 'verifying':
      return 'Checking the download…';
    case 'installing':
      return 'Installing…';
    case 'testing':
      return 'Making sure it works…';
    case 'downloading':
    default: {
      const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
      return `Downloading… ${pct}% (${megabytes(received)} of ${megabytes(total)})`;
    }
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
