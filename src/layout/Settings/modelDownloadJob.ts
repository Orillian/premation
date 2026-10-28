/**
 * An on-demand ML model, fetched the moment a tool needs it — as a JOB.
 *
 * The depth model (Make 3D from Photo) and the hand models (the Performance
 * bar's Hand source) are pinned, checksum-verified downloads
 * (electron/models.json). When the tool is picked and the model is not on
 * this computer, the download starts here, on its own, with the same
 * status-bar tray chip and progress toast a render has (`uiStore.jobs`), so
 * nobody has to find Settings first. The main process does the fetch
 * (electron/modelInstaller.ts); nothing is downloaded that was not pinned.
 *
 * One download per model at a time: a second tool picking the same model
 * while it is in flight waits on the same promise.
 */

import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';

type OnDemandModel = 'depthModel' | 'handModel' | 'faceModel';

export type EnsureModelOutcome = { ok: true } | { ok: false; message: string };

const MB = 1024 * 1024;

const inFlight = new Map<OnDemandModel, Promise<EnsureModelOutcome>>();

function labels(kind: OnDemandModel): { downloading: string; done: string } {
  if (kind === 'depthModel') return { downloading: t('models.job.depthDownloading', 'Downloading the depth model…'), done: t('models.job.depthDone', 'Depth model installed') };
  if (kind === 'faceModel') return { downloading: t('models.job.faceDownloading', 'Downloading the face tracking model…'), done: t('models.job.faceDone', 'Face tracking model installed') };
  return { downloading: t('models.job.handDownloading', 'Downloading the hand tracking model…'), done: t('models.job.handDone', 'Hand tracking model installed') };
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

/**
 * Resolve once `kind` is on disk: at once when it is (or outside the desktop
 * app, where the engine reports what it lacks), else after the download. A
 * failure is the message to show; the toast has already said it.
 */
export function ensureModelInstalled(kind: OnDemandModel): Promise<EnsureModelOutcome> {
  const running = inFlight.get(kind);
  if (running) return running;
  const p = run(kind).finally(() => inFlight.delete(kind));
  inFlight.set(kind, p);
  return p;
}

async function run(kind: OnDemandModel): Promise<EnsureModelOutcome> {
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.[kind] : undefined;
  if (!bridge) return { ok: true };
  try {
    if (await bridge.status()) return { ok: true };
  } catch {
    return { ok: true };
  }
  const { downloading, done } = labels(kind);
  const jobId = `model-${kind}`;
  const requestId = newRequestId();
  const ui = useUIStore.getState();
  ui.startJob({ id: jobId, kind: 'download', label: downloading, progress: 'indeterminate', cancel: () => { void bridge.cancelDownload(requestId); } });
  const off = bridge.onDownloadProgress((e) => {
    const p = e as { requestId?: unknown; receivedBytes?: unknown; totalBytes?: unknown };
    if (p.requestId !== requestId || typeof p.receivedBytes !== 'number') return;
    const total = typeof p.totalBytes === 'number' && p.totalBytes > 0 ? p.totalBytes : null;
    // No percentage without a known total — inventing one would be a lie.
    useUIStore.getState().updateJob(jobId, {
      progress: total ? Math.min(1, p.receivedBytes / total) : 'indeterminate',
      label: total
        ? t('models.job.pct', '{label} {pct}%', { label: downloading, pct: Math.min(100, Math.round((p.receivedBytes / total) * 100)) })
        : t('models.job.mb', '{label} {size} MB', { label: downloading, size: (p.receivedBytes / MB).toFixed(0) }),
    });
  });
  try {
    const res = await bridge.install({ requestId });
    if (res.ok) {
      useUIStore.getState().finishJob(jobId, { status: 'done', message: t('models.job.doneSize', '{label} ({size} MB)', { label: done, size: (res.model.bytes / MB).toFixed(0) }) });
      return { ok: true };
    }
    const cancelled = /^Cancelled\.?$/i.test(res.message);
    useUIStore.getState().finishJob(jobId, cancelled
      ? { status: 'cancelled', message: t('models.job.cancelled', 'Model download cancelled') }
      : { status: 'failed', message: t('models.job.failed', 'Model download failed: {message}', { message: res.message }) });
    return { ok: false, message: res.message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useUIStore.getState().finishJob(jobId, { status: 'failed', message: t('models.job.failed', 'Model download failed: {message}', { message }) });
    return { ok: false, message };
  } finally {
    off();
  }
}
