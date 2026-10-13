/**
 * "Fix video export" — the one place a person repairs the ffmpeg export runs
 * (src/stores/ffmpegStore.ts; main's side is electron/ffmpegService.ts).
 *
 * States, in the order someone meets them:
 *   explain   what is wrong (ffmpegRepairCopy.problemText) + "Download and fix (N MB)"
 *   repairing a progress bar, the phase in words, Cancel
 *   failed    one sentence on what happened + the button that helps most
 *             (Try again / Choose file… / Check again), the technical detail folded away
 *   fixed     "Video export works again" + Continue (resumes a waiting export)
 *
 * Mounted once by FfmpegRepairHost; opened by export (ensureFfmpegFor), a
 * failed job's Fix action, the startup notice and Settings.
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { DialogFooter, Modal } from '@components/Modal';
import { Progress } from '@components/Progress';
import { useFfmpegStore } from '@stores/ffmpegStore';
import { failureText, fixText, formatName, progressText, problemText } from './ffmpegRepairCopy';
import styles from './FfmpegRepairDialog.module.css';

export function FfmpegRepairDialog(): JSX.Element | null {
  const open = useFfmpegStore((s) => s.dialogOpen);
  const status = useFfmpegStore((s) => s.status);
  const progress = useFfmpegStore((s) => s.progress);
  const failure = useFfmpegStore((s) => s.failure);
  const fixed = useFfmpegStore((s) => s.fixed);
  const format = useFfmpegStore((s) => s.dialogFormat);
  const close = useFfmpegStore((s) => s.closeDialog);
  const repair = useFfmpegStore((s) => s.repair);
  const cancelRepair = useFfmpegStore((s) => s.cancelRepair);
  const chooseFile = useFfmpegStore((s) => s.chooseFile);
  const refresh = useFfmpegStore((s) => s.refresh);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  if (!open) return null;

  const repairing = Boolean(status?.repairing) || progress !== null;
  const canRepair = status?.canRepair !== false;
  const fail = failure ? failureText(failure.code, failure.neededBytes) : null;
  // Fixed outside the dialog (Check again after allowing it in antivirus) counts too.
  const works = fixed || Boolean(status?.ok);

  const recheck = async (): Promise<void> => {
    setChecking(true);
    await refresh(true);
    setChecking(false);
  };

  const copyLink = (): void => {
    if (!status?.downloadUrl) return;
    void navigator.clipboard?.writeText(status.downloadUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const details = [
    status?.problem ? `Problem: ${status.problem.code} (${status.problem.source})${status.problem.detail ? ` — ${status.problem.detail}` : ''}` : null,
    status?.active ? `In use: ${status.active.source} ${status.active.path}` : 'In use: none',
    failure ? `Last attempt: ${failure.code} — ${failure.detail}` : null,
  ].filter(Boolean).join('\n');

  let body: JSX.Element;
  let footer: JSX.Element;

  if (works && !repairing) {
    body = (
      <p className={styles.lead}>
        Video export works again.{format ? ` Your ${formatName(format)} export will continue when you press Continue.` : ''}
      </p>
    );
    footer = <DialogFooter primary={<Button variant="primary" size="md" onClick={close}>{format ? 'Continue' : 'Done'}</Button>} />;
  } else if (repairing) {
    const p = progress;
    const value = p && p.totalBytes > 0 && p.phase === 'downloading' ? p.receivedBytes / p.totalBytes : undefined;
    body = (
      <div className={styles.stack}>
        <p className={styles.lead}>Setting up video export. You can keep working while this runs.</p>
        <Progress
          value={value}
          indeterminate={value === undefined}
          label={p ? progressText(p.phase, p.receivedBytes, p.totalBytes) : 'Starting…'}
        />
        {p && p.attempt > 1 ? <p className={styles.hint}>The connection dropped — retrying (attempt {p.attempt}).</p> : null}
      </div>
    );
    // Cancel stops the transfer; the last few seconds (check, install, test) run to completion.
    const cancellable = !p || p.phase === 'checking-space' || p.phase === 'downloading';
    footer = <DialogFooter secondary={cancellable ? <Button variant="secondary" size="md" onClick={cancelRepair}>Cancel download</Button> : undefined} />;
  } else {
    const next = fail?.next ?? 'retry';
    const primary = !canRepair || next === 'choose'
      ? <Button variant="primary" size="md" onClick={() => { void chooseFile(); }}>Choose file…</Button>
      : next === 'recheck'
        ? <Button variant="primary" size="md" disabled={checking} onClick={() => { void recheck(); }}>{checking ? 'Checking…' : 'Check again'}</Button>
        : <Button variant="primary" size="md" onClick={() => { void repair(); }}>{fail ? 'Try again' : `Download and fix${status?.repairBytes ? ` (${Math.round(status.repairBytes / 1048576)} MB)` : ''}`}</Button>;
    body = (
      <div className={styles.stack}>
        <p className={styles.lead}>{problemText(status?.problem?.code, format)}</p>
        {canRepair ? <p className={styles.text}>{fixText(status?.repairBytes)}</p> : null}
        {fail && fail.message ? (
          <div className={styles.failure} role="alert">{fail.message}</div>
        ) : null}
        <div className={styles.alternatives}>
          {next !== 'choose' ? (
            <Button variant="ghost" size="sm" onClick={() => { void chooseFile(); }}>Choose file…</Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => { void repair(); }}>Try download again</Button>
          )}
          {status?.downloadUrl ? (
            <Button variant="ghost" size="sm" onClick={copyLink}>{copied ? 'Link copied' : 'Copy download link'}</Button>
          ) : null}
          {next !== 'recheck' ? (
            <Button variant="ghost" size="sm" disabled={checking} onClick={() => { void recheck(); }}>{checking ? 'Checking…' : 'Check again'}</Button>
          ) : null}
        </div>
        <details className={styles.details}>
          <summary>Technical details</summary>
          <pre className={styles.pre}>{details}</pre>
        </details>
      </div>
    );
    footer = <DialogFooter secondary={<Button variant="secondary" size="md" onClick={close}>{format ? 'Cancel export' : 'Close'}</Button>} primary={primary} />;
  }

  return (
    <Modal
      open
      id="ffmpeg-repair"
      size="md"
      title="Fix video export"
      onClose={() => { if (!repairing) close(); }}
      persistent={repairing}
      persistentScrim
      footer={footer}
    >
      {body}
    </Modal>
  );
}
