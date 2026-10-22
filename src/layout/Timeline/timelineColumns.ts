/**
 * The optional In / Out / Duration / Stretch columns of the track header.
 *
 * AE shows these on demand; here they are a preference (`timelineExtraColumns`)
 * because which of them you want is a fact about how you cut, not about the
 * project. Their WIDTHS are part of the column model (`TL_COLUMN_WIDTHS` in
 * Timeline.tsx, `--tl-col-*` in Timeline.module.css) — both halves read the
 * numbers here so they cannot drift.
 */

import { t } from '@core/i18n';

export type TimelineExtraColumn = 'in' | 'out' | 'duration' | 'stretch';

export interface ExtraColumnDef {
  id: TimelineExtraColumn;
  label: string;
  /** Column width, px — matches `--tl-col-<id>` in the stylesheet. */
  width: number;
  description: string;
}

/** Labels are getters: `t()` must run when the header reads them, not at import (the catalogue loads later). */
export const TIMELINE_EXTRA_COLUMNS: ReadonlyArray<ExtraColumnDef> = [
  {
    id: 'in',
    get label() { return t('timeline.columns.in', 'In'); },
    width: 72,
    get description() { return t('timeline.columns.inDescription', 'The layer’s in-point, in frames. Editing it trims the head.'); },
  },
  {
    id: 'out',
    get label() { return t('timeline.columns.out', 'Out'); },
    width: 72,
    get description() { return t('timeline.columns.outDescription', 'The layer’s out-point, in frames. Editing it trims the tail.'); },
  },
  {
    id: 'duration',
    get label() { return t('timeline.columns.duration', 'Duration'); },
    width: 72,
    get description() { return t('timeline.columns.durationDescription', 'Frames from in to out. Editing it moves the out-point.'); },
  },
  {
    id: 'stretch',
    get label() { return t('timeline.columns.stretch', 'Stretch'); },
    width: 64,
    get description() { return t('timeline.columns.stretchDescription', 'Time stretch, percent. 200 plays at half speed.'); },
  },
];

const ORDER: ReadonlyArray<TimelineExtraColumn> = TIMELINE_EXTRA_COLUMNS.map((c) => c.id);

/** Persisted JSON in; the known ids out, in canonical order, deduplicated. */
export function parseExtraColumns(raw: unknown): TimelineExtraColumn[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((v): v is TimelineExtraColumn => typeof v === 'string' && (ORDER as readonly string[]).includes(v)));
  return ORDER.filter((id) => wanted.has(id));
}

export function toggleExtraColumn(list: ReadonlyArray<TimelineExtraColumn>, id: TimelineExtraColumn): TimelineExtraColumn[] {
  const set = new Set(list);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return ORDER.filter((c) => set.has(c));
}

/** The header width these columns add: each is width + gap + one divider rule. */
export function extraColumnsWidth(list: ReadonlyArray<TimelineExtraColumn>, gap: number, rule: number): number {
  let total = 0;
  for (const id of list) {
    const def = TIMELINE_EXTRA_COLUMNS.find((c) => c.id === id);
    if (def) total += gap + def.width + rule;
  }
  return total;
}

/** What a column shows for a clip, in the column's own unit (frames or %). */
export function extraColumnValue(
  id: TimelineExtraColumn,
  clip: { start: number; duration: number } | undefined,
  fps: number,
  stretchPercent: number,
): number | null {
  if (id === 'stretch') return stretchPercent;
  if (!clip) return null;
  switch (id) {
    case 'in':
      return Math.round(clip.start * fps);
    case 'out':
      return Math.round((clip.start + clip.duration) * fps);
    case 'duration':
      return Math.round(clip.duration * fps);
    default:
      return null;
  }
}

/**
 * What an edit to a column means for the clip, in SECONDS on the comp axis.
 * `null` for a value that would give the clip no length.
 */
export function extraColumnEdit(
  id: Exclude<TimelineExtraColumn, 'stretch'>,
  clip: { start: number; duration: number },
  frames: number,
  fps: number,
): { edge: 'start' | 'end'; time: number } | null {
  const minDur = 1 / fps;
  const sec = Math.max(0, Math.round(frames)) / fps;
  const end = clip.start + clip.duration;
  switch (id) {
    case 'in':
      return sec <= end - minDur ? { edge: 'start', time: sec } : null;
    case 'out':
      return sec >= clip.start + minDur ? { edge: 'end', time: sec } : null;
    case 'duration':
      return sec >= minDur ? { edge: 'end', time: clip.start + sec } : null;
    default:
      return null;
  }
}
