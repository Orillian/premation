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
import { t } from '@core/i18n';

const MB = 1024 * 1024;

export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

/** Called at use time: `t()` must not run at module scope. */
function formatNames(): Record<string, string> {
  return {
    mp4: t('export.ffmpeg.format.mp4', 'MP4 video'),
    hdr10: t('export.ffmpeg.format.hdr', 'HDR video'),
    hlg: t('export.ffmpeg.format.hdr', 'HDR video'),
    webm: t('export.ffmpeg.format.webm', 'WebM video'),
    mov: t('export.ffmpeg.format.mov', 'QuickTime (ProRes) video'),
    gif: t('export.ffmpeg.format.gif', 'animated GIFs'),
  };
}

export function formatName(format: string | null | undefined): string {
  return (format && formatNames()[format]) || t('export.ffmpeg.format.video', 'video');
}

/** Why export cannot write video right now. */
export function problemText(code: FfmpegProblemCode | undefined, format: string | null): string {
  switch (code) {
    case 'blocked':
      return t('export.ffmpeg.problem.blocked', 'Your security software or system settings are stopping the part of Premation that writes video files from running.');
    case 'wrong-arch':
      return t('export.ffmpeg.problem.wrongArch', 'The part of Premation that writes video files was made for a different kind of processor than this computer has.');
    case 'damaged':
      return t('export.ffmpeg.problem.damaged', "The part of Premation that writes video files is damaged and can't run.");
    case 'timeout':
      return t('export.ffmpeg.problem.timeout', "The part of Premation that writes video files didn't respond. Security software scanning it can cause this.");
    case 'incomplete':
      return t('export.ffmpeg.problem.incomplete', "The FFmpeg Premation is using can't write {format} — it was built without the parts that needs.", { format: formatName(format) });
    case 'missing':
    default:
      return t('export.ffmpeg.problem.missing', "The part of Premation that writes video files is missing from this computer. Antivirus software sometimes removes it, or the installation didn't finish.");
  }
}

/** The promise the primary button makes. */
export function fixText(repairBytes: number | undefined): string {
  return repairBytes
    ? t('export.ffmpeg.fixSized', "Premation can download a fresh copy ({size}) and set it up for you. Your project isn't affected, and images, PNG/JPG/EXR sequences and WAV audio still export in the meantime.", { size: megabytes(repairBytes) })
    : t('export.ffmpeg.fix', "Premation can download a fresh copy and set it up for you. Your project isn't affected, and images, PNG/JPG/EXR sequences and WAV audio still export in the meantime.");
}

export type RepairNextStep = 'retry' | 'choose' | 'recheck' | 'none';

/** A failed repair: what happened, in one sentence, and the button that helps most. */
export function failureText(code: FfmpegRepairErrorCode, neededBytes?: number): { message: string; next: RepairNextStep } {
  switch (code) {
    case 'offline':
      return { message: t('export.ffmpeg.failure.offline', "You're not connected to the internet. Connect, then press Try again."), next: 'retry' };
    case 'network-blocked':
      return {
        message: t('export.ffmpeg.failure.networkBlocked', 'Your network blocked the download — common on work or school networks. Try another network, or download the file on another device (Copy download link) and pick it with Choose file.'),
        next: 'choose',
      };
    case 'unavailable':
      return { message: t('export.ffmpeg.failure.unavailable', "The download server isn't answering right now. Please try again in a few minutes."), next: 'retry' };
    case 'stalled':
      return { message: t('export.ffmpeg.failure.stalled', 'The download stopped partway. Press Try again — it continues where it left off.'), next: 'retry' };
    case 'disk-full':
      return {
        message: neededBytes
          ? t('export.ffmpeg.failure.diskFullSized', "There isn't enough free disk space — about {size} is needed. Free up some space (empty the Recycle Bin / Trash, remove old downloads), then press Try again.", { size: megabytes(neededBytes) })
          : t('export.ffmpeg.failure.diskFull', "There isn't enough free disk space. Free up some space (empty the Recycle Bin / Trash, remove old downloads), then press Try again."),
        next: 'retry',
      };
    case 'no-permission':
      return {
        message: t('export.ffmpeg.failure.noPermission', "Premation isn't allowed to save files in its own app folder. Restart Premation and try again; on a managed computer, ask your IT administrator."),
        next: 'retry',
      };
    case 'corrupted':
      return { message: t('export.ffmpeg.failure.corrupted', 'The download was damaged on the way. Press Try again; if it keeps happening, try another network.'), next: 'retry' };
    case 'blocked-after-install':
      return {
        message: t('export.ffmpeg.failure.blockedAfterInstall', 'The download worked, but your security software is stopping it from running. Open your antivirus, allow Premation (or restore the blocked file), then press Check again.'),
        next: 'recheck',
      };
    case 'unsupported':
      return {
        message: t('export.ffmpeg.failure.unsupported', "Premation can't download this for your computer automatically. If you have FFmpeg installed, pick it with Choose file."),
        next: 'choose',
      };
    case 'not-ffmpeg':
      return {
        message: t('export.ffmpeg.failure.notFfmpeg', 'That file isn\'t a working FFmpeg. Pick ffmpeg (ffmpeg.exe on Windows) or the .zip from the download link.'),
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
      return t('export.ffmpeg.progress.checkingSpace', 'Checking free space…');
    case 'verifying':
      return t('export.ffmpeg.progress.verifying', 'Checking the download…');
    case 'installing':
      return t('export.ffmpeg.progress.installing', 'Installing…');
    case 'testing':
      return t('export.ffmpeg.progress.testing', 'Making sure it works…');
    case 'downloading':
    default: {
      const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
      return t('export.ffmpeg.progress.downloading', 'Downloading… {pct}% ({received} of {total})', { pct, received: megabytes(received), total: megabytes(total) });
    }
  }
}
