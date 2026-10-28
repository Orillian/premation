/**
 * After Effects' proxy surface for the Project panel: File ▸ Create Proxy ▸
 * Movie…, File ▸ Set Proxy ▸ None, and the proxy box left of an item's name.
 *
 * The proxy itself is the engine's (`ProxyJob` transcodes and attaches it
 * with `setProxy`; `ItemInfo.proxyPath` / `proxyEnabled` carry it back through
 * the document mirror). This module only decides WHICH items an action can act
 * on, and sends the job or the edit:
 *
 *   • `proxyState`        none / off / on — what the box draws;
 *   • `canCreateProxy`    a video item large enough to be worth a proxy
 *                          (`proxyResolution`, the same rule as the Inspector);
 *   • `proxyToggleEdit`   the `setProxy` that flips an existing proxy between
 *                          in use and not (AE's box click), keeping its file;
 *   • `proxyNoneEdits`    the `setProxy` that removes it (Set Proxy ▸ None).
 *
 * Progress goes through `uiStore` jobs (the status bar's tray, the Tasks
 * panel), one job per item, run one after another so a batch of 4K clips does
 * not saturate every core while the user edits.
 */

import type { Command as EngineCommand, ItemInfo } from '@motion/engine-api';
import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { proxyResolution } from '@core/assets/proxy';
import { startEngineJob } from '@core/engine/engineJobs';
import { edit } from '@core/engine/uiEdits';
import { panelAssetSelectionIds } from '@core/composition/assetSelection';
import { documentMirror } from '@stores/documentMirror';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';

export const CREATE_PROXY_MOVIE_COMMAND = asCommandId('file.createProxyMovie');
export const SET_PROXY_NONE_COMMAND = asCommandId('file.setProxyNone');

/** What the Project panel's proxy box draws: no box, hollow (original in use), filled (proxy in use). */
export type ProxyState = 'none' | 'off' | 'on';

export function proxyState(info: Pick<ItemInfo, 'proxyPath' | 'proxyEnabled'> | undefined): ProxyState {
  if (!info || !info.proxyPath) return 'none';
  return info.proxyEnabled ? 'on' : 'off';
}

type ProxyFacts = Pick<ItemInfo, 'kind' | 'mediaType' | 'missing' | 'width' | 'height'>;

/** A video footage item whose file is there and large enough for a proxy to buy anything. */
export function canCreateProxy(info: ProxyFacts | undefined): boolean {
  if (!info || info.kind !== 'footage' || info.mediaType !== 'video' || info.missing) return false;
  return proxyResolution(info.width, info.height) !== null;
}

/** The items Create Proxy ▸ Movie… would run on, in the order given. */
export function createProxyTargets(infos: ReadonlyArray<ItemInfo | undefined>): ItemInfo[] {
  return infos.filter((i): i is ItemInfo => canCreateProxy(i));
}

/** The items Set Proxy ▸ None would clear: footage that has a proxy. */
export function proxyNoneTargets(infos: ReadonlyArray<ItemInfo | undefined>): ItemInfo[] {
  return infos.filter((i): i is ItemInfo => !!i && i.kind === 'footage' && proxyState(i) !== 'none');
}

/** The box click: use the proxy, or go back to the original, keeping the proxy file attached. */
export function proxyToggleEdit(info: Pick<ItemInfo, 'id' | 'proxyPath' | 'proxyEnabled'>): EngineCommand | null {
  if (!info.proxyPath) return null;
  return { type: 'setProxy', item: info.id, path: info.proxyPath, enabled: !info.proxyEnabled };
}

/** Set Proxy ▸ None: absent path with enabled=false removes the record (the file stays on disk). */
export function proxyNoneEdits(infos: ReadonlyArray<Pick<ItemInfo, 'id'>>): EngineCommand[] {
  return infos.map((i) => ({ type: 'setProxy', item: i.id, enabled: false }));
}

const itemsOf = (ids: readonly string[]): Array<ItemInfo | undefined> => ids.map((id) => documentMirror().item(id));

export async function toggleProxy(itemId: string): Promise<void> {
  const info = documentMirror().item(itemId);
  const cmd = info ? proxyToggleEdit(info) : null;
  if (!info || !cmd) return;
  await edit(info.proxyEnabled ? 'Use Original' : 'Use Proxy', cmd);
}

export async function setProxyNone(ids: readonly string[]): Promise<void> {
  const targets = proxyNoneTargets(itemsOf(ids));
  if (targets.length === 0) return;
  await edit(targets.length === 1 ? 'Set Proxy None' : `Set Proxy None (${targets.length} items)`, proxyNoneEdits(targets));
}

/** Items with a proxy job of ours still running (a second Create Proxy on them is a no-op). */
const running = new Set<string>();

/**
 * Create a proxy movie for each item that can have one, one job after another.
 * Resolves when the last has finished; callers need not await it.
 */
export async function createProxies(ids: readonly string[]): Promise<void> {
  const targets = createProxyTargets(itemsOf(ids)).filter((i) => !running.has(i.id));
  for (const info of targets) running.add(info.id);
  try {
    for (const info of targets) await createOne(info);
  } finally {
    for (const info of targets) running.delete(info.id);
  }
}

async function createOne(info: ItemInfo): Promise<void> {
  const ui = (): ReturnType<typeof useUIStore.getState> => useUIStore.getState();
  const jobId = `proxy:${info.id}`;
  ui().startJob({
    id: jobId,
    kind: 'render',
    label: t('assets.proxy.jobLabel', 'Creating proxy for {name}', { name: info.name }),
    progress: 'indeterminate',
  });
  try {
    const handle = await startEngineJob<{ path: string }>(
      { kind: 'proxy', value: { item: info.id, outputFolder: '' } },
      { onProgress: (fraction, message) => ui().updateJob(jobId, { progress: fraction, ...(message ? { statusLine: message } : {}) }) },
    );
    if (!handle) {
      ui().finishJob(jobId, { status: 'failed', message: t('core.proxy.noEngine', 'Proxies are made by the engine, which is not running here.') });
      return;
    }
    ui().updateJob(jobId, { cancel: () => handle.cancel() });
    const out = await handle.done;
    if (out.status === 'done') {
      ui().finishJob(jobId, { status: 'done', message: t('assets.proxy.jobDone', 'Proxy ready for {name}', { name: info.name }) });
    } else if (out.status === 'cancelled') {
      ui().finishJob(jobId, { status: 'cancelled' });
    } else {
      ui().finishJob(jobId, {
        status: 'failed',
        message: t('assets.proxy.jobFailed', 'The proxy for {name} could not be made', { name: info.name }),
        ...(out.error?.message ? { detail: out.error.message } : {}),
      });
    }
  } catch (e) {
    ui().finishJob(jobId, {
      status: 'failed',
      message: t('assets.proxy.jobFailed', 'The proxy for {name} could not be made', { name: info.name }),
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Enable rules, over the Project panel's selection (exported for the tests). */
export function canCreateProxyForSelection(ids: readonly string[] = panelAssetSelectionIds()): boolean {
  return createProxyTargets(itemsOf(ids)).some((i) => !running.has(i.id));
}

export function canSetProxyNoneForSelection(ids: readonly string[] = panelAssetSelectionIds()): boolean {
  return proxyNoneTargets(itemsOf(ids)).length > 0;
}

export function buildProxyCommands(): ReadonlyArray<Command> {
  return [
    {
      id: CREATE_PROXY_MOVIE_COMMAND,
      label: 'Create Proxy Movie…',
      description: 'Transcode a low-resolution proxy movie for the selected footage and use it in the viewer. Exports always use the original.',
      icon: 'media',
      enabled: () => canCreateProxyForSelection(),
      execute: () => { void createProxies(panelAssetSelectionIds()); },
    },
    {
      id: SET_PROXY_NONE_COMMAND,
      label: 'Set Proxy: None',
      description: 'Remove the proxy from the selected footage; the viewer goes back to the original file.',
      icon: 'media',
      enabled: () => canSetProxyNoneForSelection(),
      execute: () => { void setProxyNone(panelAssetSelectionIds()); },
    },
  ];
}
