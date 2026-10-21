/**
 * Inserting a premium library item — the one path the Library cards, the
 * canvas drop and the timeline drop share.
 *
 * Fetch the payload (Electron main downloads, verifies and keeps it; a Free
 * account is refused there with 402), then hand it to the generic interpreter
 * for its kind — the same paste / import / keyframe paths free content takes,
 * so a premium item behaves like any other once it lands:
 *   template   → templateStore.applyPayload (new comp, or an element at the playhead)
 *   lottie     → insertLottieDocEdit
 *   sfx        → insertSfxBytesEdit
 *   transition → applyTransitionSpecEdit (layer mode only)
 *
 * Every outcome is worded here, once, for a toast.
 */

import { flicksToSeconds } from '@motion/engine-api';
import { t } from '@core/i18n';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';
import { getPremiumPayload, PremiumError } from '@core/library/premium/payload';
import { documentMirror } from '@stores/documentMirror';
import { usePremiumLibraryStore } from '@stores/premiumLibraryStore';
import { useTemplateStore } from '@stores/templateStore';
import { useUIStore } from '@stores/uiStore';
import { insertLottieDocEdit } from './lottieInsertEdits';
import { insertSfxBytesEdit } from './sfxInsertEdits';
import { applyTransitionSpecEdit, hasLayerTransitionTargets } from './transitionInsertEdits';

/** Timeline drag ids for premium transitions (`markLayerTransitionDrag`), beside bundled ids and `preset:`. */
export const PREMIUM_TRANSITION_PREFIX = 'premium:';

export type PremiumInsertOutcome =
  | { ok: true; message: string }
  | { ok: false; code: 'plan-required' | 'signed-out' | 'offline' | 'needs-selection' | 'failed'; message: string };

export interface PremiumInsertOptions {
  /** Comp-space drop point (Lottie). */
  at?: { x: number; y: number };
  /** A timeline drop: the layer and the comp time the transition starts at. */
  layerDrop?: { layer: string; time: number };
}

function errorOutcome(item: PremiumCatalogItem, e: unknown): PremiumInsertOutcome {
  if (e instanceof PremiumError) {
    switch (e.code) {
      case 'plan-required':
        return { ok: false, code: 'plan-required', message: t('editor.library.premium.planRequired', '{name} comes with Premation Cloud.', { name: item.name }) };
      case 'signed-out':
        return { ok: false, code: 'signed-out', message: t('editor.library.premium.signIn', 'Sign in to use {name}.', { name: item.name }) };
      case 'offline':
        return { ok: false, code: 'offline', message: t('editor.library.premium.offline', 'You are offline — {name} has not been downloaded on this computer yet.', { name: item.name }) };
      default:
        return { ok: false, code: 'failed', message: t('editor.library.premium.failed', 'Could not get {name}: {reason}', { name: item.name, reason: e.message }) };
    }
  }
  return { ok: false, code: 'failed', message: t('editor.library.premium.failed', 'Could not get {name}: {reason}', { name: item.name, reason: (e as Error)?.message ?? String(e) }) };
}

/** Insert `item`. Never throws; the outcome says what happened in words. */
export async function insertPremiumItem(item: PremiumCatalogItem, opts: PremiumInsertOptions = {}): Promise<PremiumInsertOutcome> {
  // A transition with nothing to key is refused BEFORE the download, so the hint is instant.
  if (item.kind === 'transition' && !opts.layerDrop && !hasLayerTransitionTargets()) {
    return {
      ok: false,
      code: 'needs-selection',
      message: t('editor.library.premium.selectLayer', 'Select a layer first, or drag {name} onto a layer’s start or end in the timeline.', { name: item.name }),
    };
  }
  const store = usePremiumLibraryStore.getState();
  if (store.busy.has(item.id)) return { ok: false, code: 'failed', message: t('editor.library.premium.busy', '{name} is still downloading…', { name: item.name }) };
  store.setBusy(item.id, true);
  try {
    let payload;
    try {
      payload = await getPremiumPayload(item);
    } catch (e) {
      return errorOutcome(item, e);
    }
    const failed: PremiumInsertOutcome = { ok: false, code: 'failed', message: t('editor.library.premium.couldNotInsert', 'Could not insert {name}', { name: item.name }) };
    switch (payload.kind) {
      case 'template': {
        const ok = await useTemplateStore.getState().applyPayload(item, payload.payload);
        if (!ok) return failed;
        return {
          ok: true,
          message: payload.payload.mode === 'scene'
            ? t('editor.library.premium.newScene', 'Opened {name} in a new composition — edit its fields in Templates', { name: item.name })
            : t('editor.library.premium.inserted', 'Inserted {name}', { name: item.name }),
        };
      }
      case 'lottie': {
        const ids = await insertLottieDocEdit(`Insert ${item.name}`, payload.payload.doc, opts.at?.x, opts.at?.y);
        return ids && ids.length > 0 ? { ok: true, message: t('editor.library.premium.inserted', 'Inserted {name}', { name: item.name }) } : failed;
      }
      case 'sfx': {
        const id = await insertSfxBytesEdit(item, payload.payload);
        return id ? { ok: true, message: t('editor.library.premium.addedSound', 'Added {name}', { name: item.name }) } : failed;
      }
      case 'transition': {
        const r = await applyTransitionSpecEdit(payload.payload, `Apply ${item.name}`, opts.layerDrop);
        if (!r) return failed;
        const n = r.nodeIds.length;
        return { ok: true, message: t('editor.library.premium.keyed', 'Keyed {name} onto {count} layer(s)', { name: item.name, count: n }) };
      }
    }
  } finally {
    usePremiumLibraryStore.getState().setBusy(item.id, false);
  }
}

/** Insert and toast the outcome (canvas and timeline drops; the cards toast themselves). */
export async function insertPremiumWithToast(item: PremiumCatalogItem, opts: PremiumInsertOptions = {}): Promise<PremiumInsertOutcome> {
  const r = await insertPremiumItem(item, opts);
  useUIStore.getState().notify(r.ok
    ? { level: 'success', message: r.message, durationMs: 2000 }
    : { level: 'warning', message: r.message, durationMs: 3200 });
  return r;
}

/** The catalog row for `id`, if the shelf has it. */
export function premiumItemById(id: string): PremiumCatalogItem | undefined {
  return usePremiumLibraryStore.getState().items.find((i) => i.id === id);
}

/** A premium transition dropped on a bar's start or end (useTimelineHandlers). */
export function applyPremiumTransitionDrop(dragId: string, layerId: string, edge: 'in' | 'out'): void {
  const item = premiumItemById(dragId.slice(PREMIUM_TRANSITION_PREFIX.length));
  const layer = documentMirror().layer(layerId);
  if (!item || !layer) return;
  const inSec = flicksToSeconds(layer.timing.inPoint);
  const outSec = flicksToSeconds(layer.timing.outPoint);
  const time = edge === 'in' ? inSec : Math.max(inSec, outSec - item.durationSec);
  void insertPremiumWithToast(item, { layerDrop: { layer: layerId, time } });
}
