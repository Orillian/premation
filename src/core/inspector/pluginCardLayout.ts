/**
 * How a native plugin effect's card is laid out right now (plugin SDK flags +
 * UPDATE_PARAMS_UI), as AE's Effect Controls draws a plugin:
 *
 *   - params and buttons in the plugin's own declaration order — a button sits
 *     where PARAMS_SETUP declared it, inside its group, not in a row under
 *     every param;
 *   - a group opens unless the plugin declared it START_COLLAPSED;
 *   - `set_param_ui` hiding a GROUP_START hides the whole group (nested groups
 *     included), and a point's axes (`p<id>X` / `Y` / `Z`) follow what the
 *     plugin said about `p<id>` — hidden, disabled, renamed;
 *   - a disabled param or button is drawn greyed out.
 *
 * Pure: no React (src/core). The card (EffectStack's PluginEffectBody) draws
 * the sections it returns.
 */

import type { EffectParamUi } from '@motion/engine-api';
import type { EffectParamDef } from './effectCatalog';
import type { PluginEffectDef } from './pluginEffectDefs';

export type PluginCardItem =
  | { readonly kind: 'param'; readonly param: EffectParamDef; readonly disabled: boolean }
  | { readonly kind: 'button'; readonly key: string; readonly label: string; readonly disabled: boolean }
  /** SDK 1.3: a box the plugin draws (PR_PARAM_CUSTOM_UI), `height` px. */
  | { readonly kind: 'customUi'; readonly key: string; readonly label: string; readonly height: number; readonly description: string; readonly disabled: boolean };

export interface PluginCardSection {
  /** The group's path ("Glow / Advanced"); absent for top-level items. */
  readonly group?: string;
  /** Whether the group opens twirled up (START_COLLAPSED). */
  readonly collapsed: boolean;
  /** The group's description (its header's tooltip, '' = none). */
  readonly description: string;
  readonly items: readonly PluginCardItem[];
}

const AXIS = /^(p\d+)([XYZ])$/;

/** The plugin's UI state for a document key: its own entry, else (a point's axis) its point's, renamed with the axis. */
export function paramUiFor(key: string, ui: ReadonlyMap<string, EffectParamUi> | null | undefined): EffectParamUi | undefined {
  if (!ui) return undefined;
  const own = ui.get(key);
  if (own) return own;
  const m = AXIS.exec(key);
  const point = m ? ui.get(m[1]!) : undefined;
  return point && m ? { ...point, key, name: point.name ? `${point.name} ${m[2]}` : point.name } : undefined;
}

const inside = (group: string | undefined, path: string): boolean => !!group && (group === path || group.startsWith(`${path} / `));

/** The card's sections for `def` under the plugin's current UI state (`ui` null = every item as declared). */
export function pluginCardSections(def: PluginEffectDef, ui: ReadonlyMap<string, EffectParamUi> | null | undefined): PluginCardSection[] {
  const hiddenGroups = def.groups.filter((g) => ui?.get(g.key)?.hidden).map((g) => g.name);
  const hiddenByGroup = (group: string | undefined): boolean => hiddenGroups.some((path) => inside(group, path));

  // Declaration order: each button / box before the param it was declared ahead of.
  const ordered: Array<{ group?: string; item: PluginCardItem }> = [];
  const buttonsAt = (i: number, last: boolean): void => {
    const here = (at: number): boolean => at === i || (last && at > i);
    const buttons = def.actions.filter((a) => here(a.at));
    const boxes = (def.customUis ?? []).filter((u) => here(u.at));
    const box = (u: (typeof boxes)[number]): void => {
      ordered.push({
        group: u.group || undefined,
        item: { kind: 'customUi', key: u.key, label: u.label, height: u.height, description: u.description, disabled: false },
      });
    };
    // A box sits after the `afterButtons` buttons declared before it at the same place.
    buttons.forEach((a, n) => {
      for (const u of boxes) if (u.afterButtons === n) box(u);
      ordered.push({ group: a.group || undefined, item: { kind: 'button', key: a.key, label: a.label, disabled: false } });
    });
    for (const u of boxes) if (u.afterButtons >= buttons.length) box(u);
  };
  def.params.forEach((p, i) => {
    buttonsAt(i, false);
    ordered.push({ group: p.group, item: { kind: 'param', param: p, disabled: false } });
  });
  buttonsAt(def.params.length, true);

  const out: Array<{ group?: string; collapsed: boolean; description: string; items: PluginCardItem[] }> = [];
  for (const { group, item } of ordered) {
    if (hiddenByGroup(group)) continue;
    const key = item.kind === 'param' ? item.param.key : item.key;
    const u = paramUiFor(key, ui);
    if (u?.hidden) continue;
    const disabled = u?.enabled === false;
    const shown: PluginCardItem = item.kind === 'param'
      ? { kind: 'param', param: u?.name && u.name !== item.param.label ? { ...item.param, label: u.name } : item.param, disabled }
      : item.kind === 'button'
        ? { kind: 'button', key: item.key, label: u?.name || item.label, disabled }
        : { ...item, label: u?.name || item.label, disabled };
    // Contiguity, as splitParamGroups: a group interrupted by top-level items is two sections.
    const last = out[out.length - 1];
    if (last && last.group === group) last.items.push(shown);
    else {
      const g = def.groups.find((x) => x.name === group);
      out.push({ group, collapsed: g?.collapsed ?? false, description: g?.description ?? '', items: [shown] });
    }
  }
  return out;
}
