/**
 * The editor's boot, as stages the loading screen can name.
 *
 * The wait has real parts — the engine process, the fonts, the plugins, the
 * project — and a screen that says which one it is on reads as fast and
 * honest where a pulsing logo reads as stuck. Providers sets the stage as it
 * boots; LoadingScreen reads it. Editor state, never persisted.
 */

import { create } from 'zustand';
import { t } from '@core/i18n';

export const BOOT_STAGES = ['engine', 'fonts', 'plugins', 'project'] as const;
export type BootStage = (typeof BOOT_STAGES)[number];

export function bootStageLabel(stage: BootStage): string {
  switch (stage) {
    case 'engine': return t('stores.bootStage.label.engine', 'Engine');
    case 'fonts': return t('stores.bootStage.label.fonts', 'Fonts');
    case 'plugins': return t('stores.bootStage.label.plugins', 'Plugins');
    case 'project': return t('stores.bootStage.label.project', 'Project');
  }
}

/** What the stage line says while a stage runs. */
export function bootStageVerb(stage: BootStage): string {
  switch (stage) {
    case 'engine': return t('stores.bootStage.verb.engine', 'Starting the engine');
    case 'fonts': return t('stores.bootStage.verb.fonts', 'Loading fonts');
    case 'plugins': return t('stores.bootStage.verb.plugins', 'Loading plugins');
    case 'project': return t('stores.bootStage.verb.project', 'Opening the project');
  }
}

interface BootStageState {
  /** The stage in progress, or null before the boot reports one / after it is done. */
  stage: BootStage | null;
  /** Stages that have finished. */
  done: ReadonlySet<BootStage>;
  /** A count the current stage can report ("212 / 340" fonts), or null. */
  progress: { done: number; total: number } | null;
  begin: (stage: BootStage) => void;
  finish: (stage: BootStage) => void;
  setProgress: (p: { done: number; total: number } | null) => void;
  reset: () => void;
}

export const useBootStageStore = create<BootStageState>((set) => ({
  stage: null,
  done: new Set<BootStage>(),
  progress: null,
  begin: (stage) => set({ stage, progress: null }),
  finish: (stage) => set((s) => {
    const done = new Set(s.done);
    done.add(stage);
    return { done, stage: s.stage === stage ? null : s.stage, progress: s.stage === stage ? null : s.progress };
  }),
  setProgress: (progress) => set({ progress }),
  reset: () => set({ stage: null, done: new Set<BootStage>(), progress: null }),
}));

/** The fraction of the boot that is behind us (for the progress line). */
export function bootFraction(s: Pick<BootStageState, 'stage' | 'done' | 'progress'>): number {
  const per = 1 / BOOT_STAGES.length;
  let f = s.done.size * per;
  if (s.stage && !s.done.has(s.stage)) {
    const within = s.progress && s.progress.total > 0 ? Math.min(1, s.progress.done / s.progress.total) : 0.35;
    f += per * within;
  }
  return Math.max(0, Math.min(1, f));
}
