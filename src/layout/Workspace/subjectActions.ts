/**
 * What can be done with a subject — one list, used by Properties ▸ Subject,
 * right-click ▸ Subject and the subject chip's menu, so the three are always
 * the same (the approved Subject workflow mockup, screen 3).
 *
 * Every action is one undo entry and leaves ordinary layers and effects the
 * user can edit afterwards: nothing here is a special mode.
 */

import type { PropertyInit } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { values } from '@core/engine/propRefs';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { settingsDurationSeconds, settingsFps, settingsSetWorkArea } from '@core/mirror/compFacts';
import { playheadSeconds } from '@core/timeline/timelineView';
import { propagateObjectMatte, rotoFreezeEdit, rotoMattes, ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { ContextMenuItem } from '@stores/contextMenuStore';
import { t } from '@core/i18n';
import { placeBehindSubjectEdit } from './placeBehindSubject';
import { newLayerFromSubject } from './newLayerFromSubjectCommand';
import { runCreateSubjectTrack } from './placeBehindSubjectCommand';
import { matteOutlineKeys } from './subjectTrack';

export type SubjectActionId =
  | 'select' | 'follow' | 'newLayer' | 'textBehind' | 'outline' | 'colorSubject' | 'colorBackground'
  | 'blurBackground' | 'removeBackground' | 'trackNull' | 'freeze';

export interface SubjectAction {
  id: SubjectActionId;
  label: string;
  description: string;
  run: () => void;
  disabled?: boolean;
}

/** What the layer's subject is today (for labels and enable rules). */
export interface SubjectState {
  /** A selection exists on the layer (any matte mask). */
  selected: boolean;
  /** The matte runs through the shot (keyed outline), not one frame. */
  followed: boolean;
  frozen: boolean;
  /** The selection cuts the layer (its mask is Add): the background is removed. */
  cuts: boolean;
}

const MATTE_NAMES = new Set(['Object Matte', ROTO_PATH_NAME, 'Roto Brush (Frozen)']);

/**
 * The same, from what the mirror holds right now (a context menu is built
 * synchronously). A layer whose property tree has not arrived reads as
 * having no subject; Properties ▸ Subject loads it and shows the real state.
 */
export function subjectStateNow(layer: string): SubjectState {
  const m = documentMirror();
  const tree = m.tree(layer);
  if (!tree) return { selected: false, followed: false, frozen: false, cuts: false };
  const masks = mirrorMaskHeaders(tree);
  const r = rotoMattes(layer);
  const followed = masks.some((x) => MATTE_NAMES.has(x.name) && m.keyframes(layer, `masks/${x.id}/path`).length > 1);
  return {
    selected: masks.some((x) => MATTE_NAMES.has(x.name)),
    followed,
    frozen: r.frozen.length > 0,
    cuts: r.live.length > 0 || r.frozen.length > 0,
  };
}

/** The actions as context-menu rows (right-click ▸ Subject, the subject chip). */
export function subjectMenuItems(layer: string, hooks: SubjectActionHooks): ContextMenuItem[] {
  const actions = subjectActions(layer, subjectStateNow(layer), hooks);
  const rows: ContextMenuItem[] = [];
  for (const a of actions) {
    rows.push({ id: `subject-${a.id}`, label: a.label, disabled: a.disabled, onSelect: a.run });
    // Select / Follow, then the designs, then the matte's own state.
    if (a.id === 'follow' || a.id === 'removeBackground') rows.push({ id: `subject-sep-${a.id}`, separator: true });
  }
  return rows;
}

export async function subjectStateOf(layer: string): Promise<SubjectState> {
  const m = documentMirror();
  await m.loadTrees([layer]);
  const masks = mirrorMaskHeaders(m.tree(layer));
  const r = rotoMattes(layer);
  return {
    selected: masks.some((x) => MATTE_NAMES.has(x.name)),
    followed: (await matteOutlineKeys(layer)) !== null,
    frozen: r.frozen.length > 0,
    cuts: r.live.length > 0 || r.frozen.length > 0,
  };
}

const notify = (message: string, level: 'info' | 'success' | 'warning' = 'success'): void => {
  useUIStore.getState().notify({ level, message, durationMs: 3200 });
};

/** Follow the subject through the work area, both ways, as a Tasks-panel job. */
export async function followSubject(layer: string): Promise<void> {
  const settings = activeCompSettingsNow();
  const fps = settingsFps(settings);
  const wa = settingsSetWorkArea(settings);
  const start = wa ? wa.start : 0;
  const end = wa ? wa.end : settingsDurationSeconds(settings);
  const store = useRotoBrushStore.getState();
  const jobId = `follow-${layer}`;
  let cancelled = false;
  useUIStore.getState().startJob({ id: jobId, kind: 'analysis', label: t('workspace.subjects.following', 'Following the subject'), progress: 0, cancel: () => { cancelled = true; } });
  store.setBusy(true, 0);
  try {
    const r = await propagateObjectMatte(layer, store.strokes, {
      origin: playheadSeconds(), start, end, fps, direction: 'both', featherPx: store.featherPx, refine: store.refine, box: store.box,
    }, (f) => {
      useUIStore.getState().updateJob(jobId, { progress: f });
      useRotoBrushStore.getState().setBusy(true, f);
      return !cancelled;
    });
    useUIStore.getState().finishJob(jobId, r.status === 'cancelled'
      ? { status: 'cancelled', message: t('workspace.subjects.followCancelled', 'Following cancelled') }
      : { status: 'done', message: t('workspace.subjects.followDone', 'Subject followed over {n} frames', { n: r.frames }) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useUIStore.getState().finishJob(jobId, { status: 'failed', message });
    notify(message, 'warning');
  } finally {
    useRotoBrushStore.getState().setBusy(false);
  }
}

async function addEffect(layer: string, label: string, effect: string, params: PropertyInit[]): Promise<boolean> {
  const res = await edit(label, { type: 'addEffect', layers: [layer], effect, params });
  if (res.ok) useSelectionStore.getState().set([layer]);
  return res.ok;
}

const hex = (h: string): ReturnType<typeof values.color> => {
  const n = Number.parseInt(h.replace('#', ''), 16);
  return values.color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** Outline / Glow presets (Matte Stroke), the mockup's screen 5. */
export const OUTLINE_PRESETS = {
  neon: { label: () => t('workspace.subjects.preset.neon', 'Neon'), params: [
    { path: 'color', value: hex('#ffe14d') }, { path: 'width', value: values.scalar(8) }, { path: 'softness', value: values.scalar(1) },
    { path: 'glowAmount', value: values.scalar(60) }, { path: 'glowRadius', value: values.scalar(24) },
  ] },
  comic: { label: () => t('workspace.subjects.preset.comic', 'Comic outline'), params: [
    { path: 'color', value: hex('#ffffff') }, { path: 'width', value: values.scalar(10) },
  ] },
  dashes: { label: () => t('workspace.subjects.preset.dashes', 'Marching dashes'), params: [
    { path: 'color', value: hex('#ffffff') }, { path: 'width', value: values.scalar(4) }, { path: 'dashed', value: values.bool(true) },
  ] },
  halo: { label: () => t('workspace.subjects.preset.halo', 'Soft halo'), params: [
    { path: 'color', value: hex('#bfe3ff') }, { path: 'width', value: values.scalar(2) }, { path: 'softness', value: values.scalar(6) },
    { path: 'glowAmount', value: values.scalar(80) }, { path: 'glowRadius', value: values.scalar(40) },
  ] },
} as const satisfies Record<string, { label: () => string; params: PropertyInit[] }>;

/** Selective Color (AI) looks, screen 6. */
export const COLOR_LOOKS = {
  pop: { label: () => t('workspace.subjects.look.pop', 'Colour pop'), params: [
    { path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'saturation', value: values.scalar(-100) }, { path: 'lightness', value: values.scalar(-25) }, { path: 'matteFeather', value: values.scalar(4) },
  ] },
  warm: { label: () => t('workspace.subjects.look.warm', 'Warm subject'), params: [
    { path: 'applyTo', value: values.choice('Inside Matte') }, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex('#ff9a3c') }, { path: 'colorizeAmount', value: values.scalar(35) },
  ] },
  teal: { label: () => t('workspace.subjects.look.teal', 'Teal background'), params: [
    { path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex('#1f8a8a') }, { path: 'colorizeAmount', value: values.scalar(60) },
  ] },
  spotlight: { label: () => t('workspace.subjects.look.spotlight', 'Spotlight'), params: [
    { path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'lightness', value: values.scalar(-60) }, { path: 'matteFeather', value: values.scalar(24) },
  ] },
} as const satisfies Record<string, { label: () => string; params: PropertyInit[] }>;

export function outlineSubject(layer: string, preset: keyof typeof OUTLINE_PRESETS = 'neon'): Promise<boolean> {
  return addEffect(layer, t('workspace.subjects.outlineLabel', 'Outline Subject'), 'matte-stroke', [...OUTLINE_PRESETS[preset].params]);
}

export function colorSubject(layer: string, look: keyof typeof COLOR_LOOKS): Promise<boolean> {
  return addEffect(layer, t('workspace.subjects.colorLabel', 'Color Subject'), 'selective-color-ai', [...COLOR_LOOKS[look].params]);
}

/** A cut-out copy over the original, the original blurred: portrait-style depth. */
export async function blurBackground(layer: string): Promise<boolean> {
  const own = documentMirror().layer(layer);
  if (!own) return false;
  const made = await placeBehindSubjectEdit({ footage: layer, behind: [], comp: own.comp, parent: own.parent ?? own.comp });
  if (!made) return false;
  const res = await edit(t('workspace.subjects.blurLabel', 'Blur Background'), { type: 'addEffect', layers: [layer], effect: 'gaussian-blur', params: [{ path: 'blurriness', value: values.scalar(24) }] });
  if (res.ok) {
    useSelectionStore.getState().set([layer]);
    notify(made.hadMatte
      ? t('workspace.subjects.blurDone', 'Background blurred behind the subject.')
      : t('workspace.subjects.blurNeedsMatte', 'Background blurred. Select the subject on the top copy to keep them sharp.'));
  }
  return res.ok;
}

/** Remove Background toggles whether the selection cuts the layer (its masks Add ⇄ None). */
async function toggleRemoveBackground(layer: string, cuts: boolean): Promise<void> {
  const masks = mirrorMaskHeaders(documentMirror().tree(layer)).filter((x) => x.name === ROTO_PATH_NAME || x.name === 'Roto Brush (Frozen)');
  if (masks.length === 0) return;
  await edit(cuts ? t('workspace.subjects.keepBackground', 'Keep Background') : t('workspace.subjects.removeBackground', 'Remove Background'),
    masks.map((x) => ({ type: 'setProperty' as const, prop: { layer, path: `masks/${x.id}/mode` }, value: values.choice(cuts ? 'none' : 'add') })));
}

export interface SubjectActionHooks {
  /** Text Behind opens its popover (TextBehindDialog); the caller owns where it shows. */
  openTextBehind: (layer: string) => void;
}

export function subjectActions(layer: string, state: SubjectState, hooks: SubjectActionHooks): SubjectAction[] {
  const needs = !state.selected;
  return [
    { id: 'select', label: t('workspace.subjects.action.select', 'Select Subject…'), description: t('workspace.subjects.action.selectDesc', 'Hover the person and click'),
      run: () => {
        useSelectionStore.getState().set([layer]);
        useUIStore.getState().setActiveTool('object-matte');
      } },
    { id: 'follow', label: t('workspace.subjects.action.follow', 'Follow Through Shot'), description: t('workspace.subjects.action.followDesc', 'Carry the selection to every frame'),
      disabled: needs, run: () => { void followSubject(layer); } },
    { id: 'newLayer', label: t('workspace.subjects.action.newLayer', 'New Layer from Subject'), description: t('workspace.subjects.action.newLayerDesc', 'The subject alone, on its own layer'),
      disabled: needs, run: () => { void newLayerFromSubject(layer); } },
    { id: 'textBehind', label: t('workspace.subjects.action.textBehind', 'Text Behind'), description: t('workspace.subjects.action.textBehindDesc', 'Selected text goes behind the person'),
      disabled: needs, run: () => hooks.openTextBehind(layer) },
    { id: 'outline', label: t('workspace.subjects.action.outline', 'Outline / Glow'), description: t('workspace.subjects.action.outlineDesc', 'Border that follows them'),
      disabled: needs, run: () => { void outlineSubject(layer); } },
    { id: 'colorSubject', label: t('workspace.subjects.action.colorSubject', 'Color Subject'), description: t('workspace.subjects.action.colorSubjectDesc', 'Tint, hue, saturation'),
      disabled: needs, run: () => { void colorSubject(layer, 'warm'); } },
    { id: 'colorBackground', label: t('workspace.subjects.action.colorBackground', 'Color Background'), description: t('workspace.subjects.action.colorBackgroundDesc', 'Everything except them'),
      disabled: needs, run: () => { void colorSubject(layer, 'pop'); } },
    { id: 'blurBackground', label: t('workspace.subjects.action.blurBackground', 'Blur Background'), description: t('workspace.subjects.action.blurBackgroundDesc', 'Portrait-style depth'),
      disabled: needs, run: () => { void blurBackground(layer); } },
    { id: 'removeBackground', label: state.cuts ? t('workspace.subjects.action.keepBackground', 'Keep Background') : t('workspace.subjects.action.removeBackground', 'Remove Background'),
      description: state.cuts ? t('workspace.subjects.action.keepBackgroundDesc', 'Show the whole picture again') : t('workspace.subjects.action.removeBackgroundDesc', 'Keep only the person'),
      disabled: needs, run: () => { void toggleRemoveBackground(layer, state.cuts); } },
    { id: 'trackNull', label: t('workspace.subjects.action.trackNull', 'Track with Null'), description: t('workspace.subjects.action.trackNullDesc', 'Stickers follow the person'),
      disabled: !state.followed, run: () => { void runCreateSubjectTrack(layer); } },
    { id: 'freeze', label: state.frozen ? t('workspace.subjects.action.unfreeze', 'Unfreeze') : t('workspace.subjects.action.freeze', 'Freeze'),
      description: state.frozen ? t('workspace.subjects.action.unfreezeDesc', 'Let the matte change again') : t('workspace.subjects.action.freezeDesc', 'Lock the matte'),
      disabled: needs, run: () => {
        const e = rotoFreezeEdit(layer, !state.frozen);
        if (e.commands.length) void edit(e.label, e.commands);
      } },
  ];
}
