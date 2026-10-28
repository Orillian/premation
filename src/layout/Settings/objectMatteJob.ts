/**
 * The Object Matte model download, as a JOB.
 *
 * `useSamModelStore` already carries the download's progress for the control
 * that started it; this mirrors its status transitions into `uiStore.jobs` so
 * the status-bar tray and a progress toast show the download after the
 * Preferences dialog is closed — a 40 MB fetch outlives the dialog that
 * started it, and a person who closed it deserves to know when it landed.
 *
 * Installed once, on first import (the control imports it). A module-level
 * subscription rather than an effect in the control, for exactly that reason:
 * the control unmounts with the dialog and the download does not.
 */

import { isObjectMatteModelMissing, SUGGESTED_MODEL } from '@core/tracking/samModelInstall';
import { useSamModelStore } from '@stores/samModelStore';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';

export const OBJECT_MATTE_JOB_ID = 'object-matte-model';

const MB = 1024 * 1024;

let installed = false;

export function installObjectMatteJob(): void {
  if (installed) return;
  installed = true;
  let wasDownloading = false;
  useSamModelStore.subscribe((state) => {
    const { status } = state;
    const ui = useUIStore.getState();
    if (status.kind === 'downloading') {
      const { receivedBytes, totalBytes } = status;
      const label = totalBytes
        ? t('settings.objectMatte.jobPct', 'Downloading Object Matte model… {pct}%', { pct: Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) })
        : t('settings.objectMatte.jobMb', 'Downloading Object Matte model… {size} MB', { size: (receivedBytes / MB).toFixed(0) });
      // No percentage without a Content-Length — inventing one would be a lie.
      const progress = totalBytes ? Math.min(1, receivedBytes / totalBytes) : 'indeterminate';
      if (!wasDownloading) ui.startJob({ id: OBJECT_MATTE_JOB_ID, kind: 'download', label, progress, cancel: () => state.cancel() });
      else ui.updateJob(OBJECT_MATTE_JOB_ID, { label, progress });
      wasDownloading = true;
      return;
    }
    if (!wasDownloading) return;
    wasDownloading = false;
    if (status.kind === 'ready') {
      ui.finishJob(OBJECT_MATTE_JOB_ID, {
        status: 'done',
        message: t('settings.objectMatte.jobDone', 'Object Matte model installed ({size} MB)', { size: (status.bytes / MB).toFixed(0) }),
      });
    } else if (status.kind === 'failed') {
      ui.finishJob(OBJECT_MATTE_JOB_ID, { status: 'failed', message: t('settings.objectMatte.jobFailed', 'Model download failed: {message}', { message: status.message }) });
    } else {
      // `absent` after downloading is the user's Cancel.
      ui.finishJob(OBJECT_MATTE_JOB_ID, { status: 'cancelled', message: t('settings.objectMatte.jobCancelled', 'Model download cancelled') });
    }
  });
}

/**
 * The model is missing (the engine said so) and the person picked a tool that
 * needs it: start the download now, as a job (tray chip + Tasks panel), with no
 * toast to answer first. Premiere does the same for its masking models on first
 * use. Returns whether `message` was that failure.
 */
export function autoInstallObjectMatte(message: string): boolean {
  if (!isObjectMatteModelMissing(message)) return false;
  installObjectMatteJob();
  const sam = useSamModelStore.getState();
  if (sam.status.kind !== 'downloading') void sam.install(SUGGESTED_MODEL.encoderUrl, SUGGESTED_MODEL.decoderUrl);
  return true;
}

/**
 * The model is missing (the engine said so): offer the fix where the person
 * is — a toast with "Download model", which installs the suggested pair with
 * the same progress tray as Settings ▸ AI Object Matte Model. Returns whether
 * `message` was that failure, so callers can stop there.
 */
export function offerObjectMatteDownload(message: string): boolean {
  if (!isObjectMatteModelMissing(message)) return false;
  installObjectMatteJob();
  const sam = useSamModelStore.getState();
  if (sam.status.kind === 'downloading') return true;
  useUIStore.getState().notify({
    level: 'warning',
    message: t('settings.objectMatte.missing', "Object Matte's AI model isn't on this computer"),
    detail: t('settings.objectMatte.missingDetail', 'It is a one-time download of about 14 MB. Try the selection again once it finishes.'),
    durationMs: 0,
    group: 'object-matte-model',
    action: { label: t('settings.objectMatte.downloadModel', 'Download model'), onSelect: () => { void sam.install(SUGGESTED_MODEL.encoderUrl, SUGGESTED_MODEL.decoderUrl); } },
  });
  return true;
}
