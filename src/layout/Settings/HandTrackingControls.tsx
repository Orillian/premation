/**
 * Settings ▸ Performance Recording ▸ Hand tracking (docs/PERFORMANCE_ANIMATION_PLAN.md P1).
 *
 *   HandModelControl   the two pinned hand models (electron/handModel.ts):
 *                      nothing is fetched until Install is pressed; the source
 *                      and size are on screen before it.
 *   CameraTestControl  start the camera with the hand model and watch the
 *                      readout (rate, latency, hands seen) — the check that
 *                      hand input works on this machine before recording with
 *                      it. The camera stops when the row unmounts.
 */

import { useEffect, useState } from 'react';
import type { CameraInfo } from '@motion/engine-api';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { listLiveCameras, startLiveInput, stopLiveInput } from '@core/live/liveInput';
import { useLiveInputStore } from '@stores/liveInputStore';
import { t } from '@core/i18n';
import styles from './ObjectMatteControl.module.css';

const MB = 1024 * 1024;
/** Both pinned files (handModel.ts HAND_MODEL_PINS), shown before the download. */
const DOWNLOAD_MB = (3_905_734 + 4_099_621) / MB;

type ModelStatus =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'ready'; bytes: number }
  | { kind: 'failed'; message: string };

const bridge = (): NonNullable<Window['motionEditor']>['handModel'] | undefined =>
  typeof window !== 'undefined' ? window.motionEditor?.handModel : undefined;

/** Whether the hand models are installed (null while asking). */
export function useHandModelInstalled(): [boolean | null, (v: boolean) => void] {
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const b = bridge();
    if (!b) {
      setInstalled(false);
      return undefined;
    }
    void b.status().then((m) => { if (live) setInstalled(m !== null); }).catch(() => { if (live) setInstalled(false); });
    return () => { live = false; };
  }, []);
  return [installed, setInstalled];
}

export function HandModelControl({ onChange }: { onChange?: (installed: boolean) => void }): JSX.Element {
  const [status, setStatus] = useState<ModelStatus>({ kind: 'loading' });
  const [requestId, setRequestId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const b = bridge();
    if (!b) {
      setStatus({ kind: 'absent' });
      return undefined;
    }
    void b.status().then((m) => { if (live) setStatus(m ? { kind: 'ready', bytes: m.bytes } : { kind: 'absent' }); })
      .catch(() => { if (live) setStatus({ kind: 'absent' }); });
    return () => { live = false; };
  }, []);

  const install = async (): Promise<void> => {
    const b = bridge();
    if (!b) {
      setStatus({ kind: 'failed', message: t('settings.handModel.needsDesktop', 'Installing the hand model needs the desktop app: the engine reads it from this computer.') });
      return;
    }
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    setRequestId(id);
    setStatus({ kind: 'downloading', received: 0, total: null });
    const off = b.onDownloadProgress((e) => {
      const p = e as { requestId?: unknown; receivedBytes?: unknown; totalBytes?: unknown };
      if (p.requestId === id && typeof p.receivedBytes === 'number') {
        setStatus({ kind: 'downloading', received: p.receivedBytes, total: typeof p.totalBytes === 'number' ? p.totalBytes : null });
      }
    });
    try {
      const r = await b.install({ requestId: id });
      setStatus(r.ok ? { kind: 'ready', bytes: r.model.bytes } : { kind: 'failed', message: r.message });
      if (r.ok) onChange?.(true);
    } finally {
      off();
      setRequestId(null);
    }
  };

  if (status.kind === 'loading') return <div className={styles.root} />;
  if (status.kind === 'ready') {
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.ready}>{t('settings.handModel.installed', 'Installed · {size} MB', { size: (status.bytes / MB).toFixed(1) })}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void stopLiveInput();
              void bridge()?.remove().then(() => {
                setStatus({ kind: 'absent' });
                onChange?.(false);
              });
            }}
          >
            {t('settings.handModel.remove', 'Remove')}
          </Button>
        </div>
        <div className={styles.source}>{t('settings.handModel.source', 'MediaPipe palm + hand models · OpenCV Zoo · Apache-2.0')}</div>
      </div>
    );
  }
  if (status.kind === 'downloading') {
    const pct = status.total ? Math.min(100, Math.round((status.received / status.total) * 100)) : null;
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.progressText}>{pct === null
            ? t('settings.handModel.downloadingMb', 'Downloading… {size} MB', { size: (status.received / MB).toFixed(1) })
            : t('settings.handModel.downloadingPct', 'Downloading… {pct}%', { pct })}</span>
          <Button variant="secondary" size="sm" onClick={() => { if (requestId) void bridge()?.cancelDownload(requestId); }}>
            {t('settings.handModel.cancel', 'Cancel')}
          </Button>
        </div>
        <div className={styles.progressTrack}>
          <div className={pct === null ? styles.progressIndeterminate : styles.progressFill} style={pct === null ? undefined : { transform: `scaleX(${pct / 100})` }} />
        </div>
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <div className={styles.readyRow}>
        <span className={styles.source}>{t('settings.handModel.source', 'MediaPipe palm + hand models · OpenCV Zoo · Apache-2.0')}</span>
        <Button variant="secondary" size="sm" onClick={() => { void install(); }}>
          {t('settings.handModel.install', 'Install ({size} MB)', { size: DOWNLOAD_MB.toFixed(1) })}
        </Button>
      </div>
      {status.kind === 'failed' ? <div className={styles.error}>{status.message}</div> : null}
      <div className={styles.hint}>
        {t('settings.handModel.hint', 'Downloaded once from a pinned, checksum-verified source and kept on this computer. Camera frames never leave this computer.')}
      </div>
    </div>
  );
}

export function CameraTestControl(): JSX.Element {
  const live = useLiveInputStore();
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [listError, setListError] = useState('');

  useEffect(() => {
    let alive = true;
    void listLiveCameras().then((r) => {
      if (!alive) return;
      if ('error' in r) setListError(r.error);
      else setCameras(r.cameras);
    });
    // Leaving Settings turns the camera off: a test is a test.
    return () => {
      alive = false;
      void stopLiveInput();
    };
  }, []);

  const running = live.state === 'running' || live.state === 'starting';
  const cameraName = cameras.find((c) => c.id === cameraId)?.name ?? t('settings.cameraTest.auto', 'First camera');
  const items = (): DropdownItem[] => [
    { type: 'item', id: '', label: t('settings.cameraTest.auto', 'First camera'), ...(cameraId === '' ? { icon: 'check' as const } : {}), onSelect: () => setCameraId('') },
    ...cameras.map((c): DropdownItem => ({ type: 'item', id: c.id, label: c.name, ...(c.id === cameraId ? { icon: 'check' as const } : {}), onSelect: () => setCameraId(c.id) })),
  ];

  const readout = live.state === 'running'
    ? t('settings.cameraTest.running', '{camera} · {fps} fps · {latency} ms · {hands} hand(s)', {
      camera: live.camera, fps: live.trackedFps || Math.round(live.fps), latency: live.latencyMs, hands: live.hands,
    })
    : live.state === 'starting'
      ? t('settings.cameraTest.starting', 'Starting the camera…')
      : live.state === 'failed'
        ? live.message
        : t('settings.cameraTest.idle', 'Hold a hand up to the camera to check tracking.');

  return (
    <div className={styles.root}>
      <div className={styles.readyRow}>
        <Dropdown
          placement="bottom-start"
          items={items}
          trigger={(
            <Button size="sm" variant="ghost" disabled={running}>
              <Icon name="video" size="sm" />
              <span>{cameraName}</span>
              <Icon name="chevron-down" size="sm" />
            </Button>
          )}
        />
        <Button size="sm" variant="secondary" onClick={() => { void (running ? stopLiveInput() : startLiveInput({ camera: cameraId })); }}>
          {running ? t('settings.cameraTest.stop', 'Stop') : t('settings.cameraTest.start', 'Start test')}
        </Button>
      </div>
      <div className={live.state === 'failed' ? styles.error : styles.hint} aria-live="polite">{listError && !running ? listError : readout}</div>
    </div>
  );
}
