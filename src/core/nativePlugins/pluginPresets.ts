/**
 * Native plugin presets (plugin SDK 1.2, docs/PLUGIN_SDK.md "Presets" — AE's
 * .ffx). A plugin bundle ships named starting points for its effects; the
 * engine reads them with the manifest and lists them on `listPlugins`, its
 * values already checked against the effect's params and in the API's
 * encoding. Applying one is ONE `addEffect` with those values as its params:
 * one undo entry, no plugin code beyond what adding the effect runs.
 *
 * Pure registry with listeners: no React, no zustand (src/core). Refreshed with
 * the plugin effect definitions (pluginEffectDefs.ts), so an install, a rescan
 * or enable / disable replaces them too.
 */

import type { Command, EngineClient, PluginPresetInfo, PropertyInit } from '@motion/engine-api';

/** One preset as the Effects & Presets panel lists it. */
export interface PluginPreset {
  /** The plugin that ships it. */
  readonly plugin: string;
  readonly name: string;
  /** The effect it adds (a match name of the same plugin). */
  readonly effect: string;
  readonly category: string;
  /** addEffect's params: property paths under the effect (`p2`, `p1X`) and values. */
  readonly values: readonly PropertyInit[];
}

let presets: readonly PluginPreset[] = [];
const listeners = new Set<() => void>();

export function setPluginPresets(list: ReadonlyArray<{ id: string; presets?: readonly PluginPresetInfo[] }>): void {
  const next: PluginPreset[] = [];
  for (const p of list) {
    for (const pr of p.presets ?? []) {
      next.push({ plugin: p.id, name: pr.name, effect: pr.effect, category: pr.category, values: pr.values });
    }
  }
  presets = next;
  for (const l of listeners) l();
}

export function pluginPresets(): readonly PluginPreset[] {
  return presets;
}

/** The presets that add `effectType`, in the order the plugin lists them. */
export function pluginPresetsFor(effectType: string): readonly PluginPreset[] {
  return presets.filter((p) => p.effect === effectType);
}

export function subscribePluginPresets(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Ask the engine again. Never throws. */
export async function refreshPluginPresets(client: Pick<EngineClient, 'query'>): Promise<void> {
  try {
    const res = await client.query({ type: 'listPlugins' });
    if (res.ok) setPluginPresets(res.value.plugins);
  } catch {
    // The engine is restarting: the next refresh fills it in.
  }
}

/** The command that applies `preset` to `layers`: addEffect with its values, one undo entry. */
export function applyPluginPresetCommand(preset: PluginPreset, layers: readonly string[]): Command {
  return { type: 'addEffect', layers: [...layers], effect: preset.effect, params: [...preset.values] } as Command;
}
