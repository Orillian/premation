/**
 * The ONE definition of the track-matte menu.
 *
 * There were two: the inspector's CompositingControls and the timeline row, each
 * with its own hardcoded copy of the four legacy enum labels. Two copies of a
 * value list is how a fifth matte type becomes an expensive change — and it is
 * why the four-value enum survived as long as it did.
 *
 * This module owns the OPTIONS and the read/write mapping; the two hosts own
 * their own chrome, because a timeline row and an inspector row genuinely look
 * different. Sharing the data and not the markup is the split that holds.
 */

import { readMatte, type TrackMatte, type MatteMode } from '@core/effects/matte';
import { t } from '@core/i18n';

export interface MatteOption {
  id: string;
  label: string;
  /** undefined = "no matte". */
  value: TrackMatte | undefined;
}

/**
 * Alpha/Luma × Inverted, presented as four rows.
 *
 * The MODEL is two fields; the MENU is still four rows, because that is what AE
 * shows and what a user picking a matte is actually choosing between. The point
 * of the model change was never to make the user click twice — it was so a fifth
 * matte kind costs one entry here instead of a new spelling in every consumer.
 */
// Labels are getters: `t()` runs when a menu reads them (render time), never at
// module scope, where the catalogue is not loaded yet.
export const MATTE_OPTIONS: readonly MatteOption[] = [
  { id: 'none', get label() { return t('ui.matte.none', 'No matte'); }, value: undefined },
  { id: 'alpha', get label() { return t('ui.matte.alpha', 'Alpha'); }, value: { mode: 'alpha', inverted: false } },
  { id: 'alpha-inv', get label() { return t('ui.matte.alphaInverted', 'Alpha Inverted'); }, value: { mode: 'alpha', inverted: true } },
  { id: 'luma', get label() { return t('ui.matte.luma', 'Luma'); }, value: { mode: 'luma', inverted: false } },
  { id: 'luma-inv', get label() { return t('ui.matte.lumaInverted', 'Luma Inverted'); }, value: { mode: 'luma', inverted: true } },
];

/** Short labels for the timeline's narrow column. */
export const MATTE_SHORT_LABEL: Record<string, string> = {
  get none() { return t('ui.matte.short.none', 'None'); },
  get alpha() { return t('ui.matte.alpha', 'Alpha'); },
  get 'alpha-inv'() { return t('ui.matte.short.alphaInv', 'Alpha Inv'); },
  get luma() { return t('ui.matte.luma', 'Luma'); },
  get 'luma-inv'() { return t('ui.matte.short.lumaInv', 'Luma Inv'); },
};

/** Which option a stored matte corresponds to. Accepts every legacy shape. */
export function matteOptionId(stored: unknown): string {
  const m = readMatte(stored);
  if (!m) return 'none';
  return m.inverted ? `${m.mode}-inv` : m.mode;
}

/**
 * Apply an option to a stored matte, PRESERVING the explicit source.
 *
 * Dropping sourceId here would silently re-point the matte at whatever layer sits
 * above — still matted, still looks fine, cut to the wrong shape.
 */
export function applyMatteOption(stored: unknown, optionId: string): TrackMatte | undefined {
  const opt = MATTE_OPTIONS.find((o) => o.id === optionId);
  if (!opt?.value) return undefined;
  const sourceId = readMatte(stored)?.sourceId;
  return { ...opt.value, ...(sourceId ? { sourceId } : {}) };
}

/** Repoint a matte at a source without disturbing mode/inverted. */
export function setMatteSource(stored: unknown, sourceId: string | undefined): TrackMatte | undefined {
  const m = readMatte(stored);
  if (!m) return undefined;
  const { sourceId: _drop, ...rest } = m;
  return sourceId ? { ...rest, sourceId } : (rest as { mode: MatteMode; inverted: boolean });
}
