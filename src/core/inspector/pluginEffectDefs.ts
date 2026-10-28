/**
 * Native plugin effects as editor effect definitions (AE parity 2.9).
 *
 * Built-in effects come from the generated catalog at build time; a plugin's
 * effects exist only while it is installed and loaded, so their definitions
 * come from the engine's `listEffects` (provider ≠ 'builtin') and are replaced
 * whenever plugins change (an install, a rescan, enable / disable). The
 * engine already describes plugin params in the catalog's own types (a point
 * is two numbers `p<id>X` / `p<id>Y`, a popup an `enum`), so the Effects
 * panel, the Add menu and the effect cards read them like any built-in.
 *
 * Pure registry with listeners: no React, no zustand (src/core). The React
 * read is `useAllEffectDefs` (layout/Effects/effectCatalog.ts).
 */

import type { EffectInfo, EngineClient } from '@motion/engine-api';
import { refreshPluginPresets } from '@core/nativePlugins/pluginPresets';
import type { EffectDef, EffectParamDef } from './effectCatalog';

/** A plugin effect's definition, with what only plugins have. */
export type PluginEffectDef = EffectDef & {
  /** The plugin id that provides it. */
  readonly provider: string;
  readonly category: string;
  /**
   * Buttons: invokeEffectAction's action keys, each drawn where the plugin
   * declared it — inside `group` ('' = top level), before `params[at]`.
   */
  readonly actions: ReadonlyArray<PluginEffectAction>;
  /** Twirl-down groups (GROUP_START), in declaration order. */
  readonly groups: ReadonlyArray<PluginEffectGroup>;
  /** Param keys the plugin declared CANNOT_ANIMATE (a point's axes included): no stopwatch. */
  readonly fixed: ReadonlySet<string>;
  /** SDK 1.2 PrParamDef.description by param key (a point's axes included): the label's tooltip. */
  readonly descriptions: ReadonlyMap<string, string>;
  /** PR_CMD_ABOUT's text ('' = none): the card's About. */
  readonly about: string;
  /** SDK 1.3 PR_PARAM_CUSTOM_UI boxes the plugin draws (drawEffectParamUi), placed like buttons. */
  readonly customUis: ReadonlyArray<PluginEffectCustomUi>;
};

export interface PluginEffectCustomUi {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly at: number;
  /** The box's height, px (the plugin's; the width is the card's). */
  readonly height: number;
  readonly description: string;
  /** How many of the buttons at the same `at` come before it (declaration order). */
  readonly afterButtons: number;
}

export interface PluginEffectAction {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly at: number;
}

/** `name`: the path its params' `group` spells; `key`: the GROUP_START param's; `collapsed`: START_COLLAPSED. */
export interface PluginEffectGroup {
  readonly name: string;
  readonly key: string;
  readonly collapsed: boolean;
  /** The GROUP_START's description: the header's tooltip ('' = none). */
  readonly description: string;
}

let defs: readonly PluginEffectDef[] = [];
let byType = new Map<string, PluginEffectDef>();
let revision = 0;
const listeners = new Set<() => void>();

const TYPE_OF: Record<string, EffectParamDef['type'] | undefined> = {
  scalar: 'number',
  int: 'number',
  color: 'color',
  bool: 'checkbox',
  choice: 'enum',
  layer: 'layer',
  string: 'maskPath',
};

/** Plugin SDK 1.1 `EffectParamInfo.kind` → the editor's control. */
const KIND_OF: Record<string, EffectParamDef['type'] | undefined> = {
  text: 'text',
  curve: 'curve',
  gradient: 'gradient',
  file: 'file',
};

/** One engine `EffectInfo` (a plugin's) → an editor effect definition. */
export function effectInfoToDef(info: EffectInfo): PluginEffectDef {
  const params: EffectParamDef[] = [];
  const fixed = new Set<string>();
  const descriptions = new Map<string, string>();
  // A button's `at` counts the engine's params; this list may skip some (not controls).
  const uiIndexOf: number[] = [];
  for (const p of info.params) {
    uiIndexOf.push(params.length);
    // Plugin SDK 1.1: the control the param needs beyond its value type.
    const kind = KIND_OF[p.kind ?? ''];
    const type = kind ?? TYPE_OF[p.valueType];
    if (!type) continue; // arbitrary data and the like: not a control
    // Numbers and colours are keyframeable unless the plugin said CANNOT_ANIMATE.
    if ((type === 'number' || type === 'color') && p.animatable === false) fixed.add(p.matchName);
    if (p.description) descriptions.set(p.matchName, p.description);
    const dv = p.defaultValue;
    const def = dv?.kind === 'scalar' || dv?.kind === 'int' ? dv.value : dv?.kind === 'bool' ? dv.value : dv?.kind === 'string' && type === 'text' ? dv.value : undefined;
    params.push({
      key: p.matchName,
      label: p.name,
      type,
      ...(p.choices.length > 0 ? { options: p.choices.map((label, i) => ({ value: i + 1, label })) } : {}),
      ...(p.group ? { group: p.group } : {}),
      ...(p.unit ? { unit: p.unit } : {}),
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.precision !== undefined ? { precision: p.precision } : {}),
      ...(type === 'file' ? { fileTypes: p.fileTypes ?? '' } : {}),
      ...(def !== undefined ? { default: def } : type === 'checkbox' ? { default: false } : type === 'enum' ? { default: 1 } : {}),
    });
  }
  return {
    type: info.matchName,
    label: info.displayName,
    params,
    ...(info.gpu ? { gpuOnly: true as const } : {}),
    provider: info.provider,
    category: info.category,
    actions: (info.actions ?? []).map((a) => ({
      key: a.key,
      label: a.label,
      group: a.group ?? '',
      at: a.at !== undefined && a.at < uiIndexOf.length ? uiIndexOf[a.at]! : params.length,
    })),
    groups: (info.groups ?? []).map((g) => ({ name: g.name, key: g.key, collapsed: g.collapsed === true, description: g.description ?? '' })),
    fixed,
    descriptions,
    about: info.about ?? '',
    customUis: (info.customUis ?? []).map((u) => ({
      key: u.key,
      label: u.label,
      group: u.group ?? '',
      at: u.at !== undefined && u.at < uiIndexOf.length ? uiIndexOf[u.at]! : params.length,
      height: u.height,
      description: u.description ?? '',
      afterButtons: u.afterButtons ?? 0,
    })),
  };
}

export function setPluginEffectDefs(infos: readonly EffectInfo[]): void {
  defs = infos.filter((e) => e.provider !== 'builtin' && !e.audio).map(effectInfoToDef);
  byType = new Map(defs.map((d) => [d.type, d]));
  revision += 1;
  for (const l of listeners) l();
}

export function pluginEffectDefs(): readonly PluginEffectDef[] {
  return defs;
}

/** Bumps whenever the plugin effect definitions are replaced (a cache key for what is derived from them). */
export function pluginEffectDefsRevision(): number {
  return revision;
}

export function pluginEffectDefFor(type: string): PluginEffectDef | undefined {
  return byType.get(type);
}

export function isPluginEffectDef(def: EffectDef | undefined): def is PluginEffectDef {
  return !!def && typeof (def as Partial<PluginEffectDef>).provider === 'string';
}

export function subscribePluginEffectDefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Ask the engine again (after an install, a rescan, enable / disable). Never throws. */
export async function refreshPluginEffectDefs(client: Pick<EngineClient, 'query'>): Promise<void> {
  try {
    const res = await client.query({ type: 'listEffects', category: '' });
    if (res.ok) setPluginEffectDefs(res.value.effects);
    await refreshPluginPresets(client);  // SDK 1.2: what the plugins ship with their effects
  } catch {
    // The engine is restarting: the next refresh fills it in.
  }
}
