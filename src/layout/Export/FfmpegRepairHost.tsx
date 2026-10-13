/**
 * Mounts the "Fix video export" dialog once for the whole app, and turns
 * main's startup health check into ONE notice when the copy that should work
 * does not — so a person learns about it (with a Fix button) before their
 * first export, not after it.
 *
 * Not for development builds without ffmpeg on PATH: there the problem's
 * source is 'system', which is a developer's setup, not a broken install.
 */

import { useEffect, useRef } from 'react';
import { useFfmpegStore } from '@stores/ffmpegStore';
import { useUIStore } from '@stores/uiStore';
import { FfmpegRepairDialog } from './FfmpegRepairDialog';

export function FfmpegRepairHost(): JSX.Element {
  const status = useFfmpegStore((s) => s.status);
  const noticed = useRef(false);

  useEffect(() => {
    useFfmpegStore.getState().init();
  }, []);

  useEffect(() => {
    if (noticed.current || !status || status.checkedAt === 0 || status.ok || status.repairing) return;
    const problem = status.problem;
    if (!problem || problem.source === 'system') return;
    noticed.current = true;
    useUIStore.getState().notify({
      level: 'warning',
      message: "Video export needs a quick repair",
      detail: 'Images and WAV still export. Press Fix to set up video export — about a minute.',
      durationMs: 0,
      group: 'ffmpeg-health',
      action: { label: 'Fix', onSelect: () => useFfmpegStore.getState().openDialog() },
    });
  }, [status]);

  return <FfmpegRepairDialog />;
}
