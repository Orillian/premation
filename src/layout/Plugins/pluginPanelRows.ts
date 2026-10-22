/**
 * The Plugins panel's rows, flattened (docs/mockups/plugin-docking-ae.html,
 * frame 4): AE's list-panel grammar, one twirl row per installed plugin and,
 * under an open one, a dim meta line, its effects (each followed by the
 * presets it ships, one level deeper) and its panels.
 *
 * Pure: the panel hands in the engine's plugin list, the store's view of it
 * and the contributions caches, and draws what comes back. A flat list is what
 * the keyboard walks (Up / Down / Left / Right), the same shape the Effects &
 * Presets browser uses (EffectsPanelRows.ts).
 */

import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import type { PluginPanelEntry } from '@core/nativePlugins/pluginContrib';
import type { PluginPreset } from '@core/nativePlugins/pluginPresets';
import { nativePluginStatusLabel, type NativePlugin } from '@core/nativePlugins/nativePlugins';
import { t } from '@core/i18n';

/** How the status word on a plugin row reads: its colour role. */
export type PluginStatusTone = 'ok' | 'dim' | 'danger' | 'warning';

export interface PluginStatusWord {
  text: string;
  tone: PluginStatusTone;
}

export type PluginPanelRow =
  | { kind: 'plugin'; id: string; plugin: NativePlugin; open: boolean; status: PluginStatusWord }
  | { kind: 'meta'; id: string; plugin: string; text: string }
  | { kind: 'error'; id: string; plugin: string; text: string }
  | { kind: 'effect'; id: string; plugin: string; def: PluginEffectDef }
  | { kind: 'preset'; id: string; plugin: string; preset: PluginPreset; effectLabel: string }
  | { kind: 'panel'; id: string; plugin: string; entry: PluginPanelEntry; docked: boolean };

/** The rows the keyboard can land on (meta and error lines are captions). */
export function isSelectableRow(row: PluginPanelRow): boolean {
  return row.kind !== 'meta' && row.kind !== 'error';
}

export interface PluginPanelRowInputs {
  plugins: readonly NativePlugin[];
  effects: readonly PluginEffectDef[];
  presets: readonly PluginPreset[];
  panels: readonly PluginPanelEntry[];
  /** Plugin ids the user twirled shut (everything is open by default). */
  collapsed: ReadonlySet<string>;
  /** Dock panel ids currently docked on a side. */
  docked: ReadonlySet<string>;
  /** Available store updates: plugin id → latest version. */
  updates: ReadonlyMap<string, string>;
  /** Plugin ids queued for removal on the next start. */
  uninstalling: ReadonlySet<string>;
  query: string;
}

export function pluginRowId(plugin: string): string {
  return `plugin:${plugin}`;
}

/** Locked plugins, and those whose engine message names it, are Premation Cloud plugins. */
function isCloudPlugin(p: NativePlugin): boolean {
  return p.status === 'locked' || /premation cloud/i.test(p.error);
}

export function pluginStatusWord(p: NativePlugin, update: string | undefined, uninstalling: boolean): PluginStatusWord {
  if (uninstalling) return { text: t('plugins.list.removedOnRestart', 'Removed on restart'), tone: 'dim' };
  if (update) return { text: t('plugins.rows.update', 'Update {version}', { version: update }), tone: 'warning' };
  switch (p.status) {
    case 'loaded': return { text: t('plugins.rows.loaded', 'Loaded'), tone: 'ok' };
    case 'disabled': return { text: t('plugins.rows.disabled', 'Disabled'), tone: 'dim' };
    // The long form ("Requires Premation Cloud") is the error line under the row.
    case 'locked': return { text: t('plugins.rows.locked', 'Locked'), tone: 'danger' };
    default: return { text: nativePluginStatusLabel(p.status), tone: 'danger' };
  }
}

function metaLine(p: NativePlugin): string {
  const parts = [p.vendor, p.version && `v${p.version}`, isCloudPlugin(p) ? 'Premation Cloud' : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : p.id;
}

const has = (text: string, q: string): boolean => text.toLowerCase().includes(q);

export function buildPluginPanelRows(input: PluginPanelRowInputs): PluginPanelRow[] {
  const q = input.query.trim().toLowerCase();
  const rows: PluginPanelRow[] = [];
  for (const p of input.plugins) {
    const name = p.name || p.id;
    const effects = input.effects.filter((d) => d.provider === p.id);
    const panels = input.panels.filter((e) => e.plugin === p.id);
    const presetsOf = (type: string): PluginPreset[] =>
      input.presets.filter((s) => s.plugin === p.id && s.effect === type);

    // A search matching the plugin itself shows all it brings; otherwise only
    // the effects, presets and panels that match (and the plugin above them).
    const pluginHit = !q || has(name, q) || has(p.id, q) || has(p.vendor, q);
    const effectRows: PluginPanelRow[] = [];
    for (const d of effects) {
      const presets = presetsOf(d.type);
      const effectHit = pluginHit || has(d.label, q);
      const presetRows = presets
        .filter((s) => effectHit || has(s.name, q))
        .map((s): PluginPanelRow => ({ kind: 'preset', id: `preset:${p.id}:${d.type}#${s.name}`, plugin: p.id, preset: s, effectLabel: d.label }));
      if (!effectHit && presetRows.length === 0) continue;
      effectRows.push({ kind: 'effect', id: `effect:${p.id}:${d.type}`, plugin: p.id, def: d }, ...presetRows);
    }
    const panelRows = panels
      .filter((e) => pluginHit || has(e.panel.name, q))
      .map((e): PluginPanelRow => ({ kind: 'panel', id: `panel:${e.panelId}`, plugin: p.id, entry: e, docked: input.docked.has(e.panelId) }));
    if (!pluginHit && effectRows.length === 0 && panelRows.length === 0) continue;

    // A search opens every plugin it found something in.
    const open = q ? true : !input.collapsed.has(p.id);
    rows.push({
      kind: 'plugin',
      id: pluginRowId(p.id),
      plugin: p,
      open,
      status: pluginStatusWord(p, input.updates.get(p.id), input.uninstalling.has(p.id)),
    });
    if (!open) continue;
    rows.push({ kind: 'meta', id: `meta:${p.id}`, plugin: p.id, text: metaLine(p) });
    if (p.error) rows.push({ kind: 'error', id: `error:${p.id}`, plugin: p.id, text: p.error });
    rows.push(...effectRows, ...panelRows);
  }
  return rows;
}

/** The plugin row a child row sits under (itself for a plugin row). */
export function parentRowIndex(rows: readonly PluginPanelRow[], index: number): number {
  for (let i = index; i >= 0; i--) if (rows[i]?.kind === 'plugin') return i;
  return -1;
}
