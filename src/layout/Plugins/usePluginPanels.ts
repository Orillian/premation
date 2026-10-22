/**
 * P7d: register the loaded native plugins' panels with the dock — each effect
 * plugin's own panel (its `ui/index.html`) and every manifest panel. Called
 * once by the editor shell; re-runs when the plugin list changes, and the
 * shell re-renders, so the dock renderers (panelRenderers.ts) pick up a newly
 * installed plugin's panel.
 *
 * Installed plugins have ONE home in the sidebar, the Plugins tab (owner
 * 2026-10-20): it lists each plugin's effects, presets and panels
 * (NativePluginsPanel.tsx). So a plugin's panel is registered but not docked; a
 * double-click on its row there (or Plugins menu ▸ Panels, Window ▸
 * Extensions) docks it, and from then
 * on the saved layout decides. The Plugins tab itself is on demand, so the
 * first time this machine has an installed plugin it is docked once; a user
 * who closes it keeps it closed. The "seen" list is editor state on this
 * machine (localStorage, every access wrapped), never the project document.
 */

import { useEffect } from 'react';
import { hasLoadedPlugins, pluginPanels } from '@core/nativePlugins/pluginContrib';
import { usePluginContrib } from '@hooks/usePluginContrib';
import { useLayoutStore } from '@stores/layoutStore';

export const SEEN_PLUGIN_PANELS_KEY = 'premation.pluginPanels.seen.v1';
/** In the seen list once the Plugins tab has been docked for this machine's first plugin. */
export const PLUGINS_TAB_SEEN = 'plugins';

function readSeen(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_PLUGIN_PANELS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(SEEN_PLUGIN_PANELS_KEY, JSON.stringify([...seen]));
  } catch {
    // A blocked store: the Plugins tab is docked again next launch, which is harmless.
  }
}

export function usePluginPanels(): number {
  const revision = usePluginContrib();
  useEffect(() => {
    const store = useLayoutStore.getState();
    const openBefore = new Set(Object.values(store.panelOrder).flat());
    for (const p of pluginPanels()) {
      if (store.panels[p.panelId]) continue;
      // registerPanel docks the panel (at its saved place, else appended to the right sidebar).
      store.registerPanel({
        id: p.panelId,
        title: p.kind === 'effect' ? p.pluginName : p.panel.name,
        icon: 'plugin',
        region: 'rightInspector',
        weight: 4,
        closable: true,
        onDemand: true,
      });
      // Not in the saved layout: it opens from the Plugins tab, it does not add a tab of its own.
      if (!openBefore.has(p.panelId)) useLayoutStore.getState().closePanel(p.panelId);
    }
    if (!hasLoadedPlugins()) return;
    const seen = readSeen();
    if (seen.has(PLUGINS_TAB_SEEN)) return;
    if (!openBefore.has('plugins')) useLayoutStore.getState().openPanel('plugins');
    seen.add(PLUGINS_TAB_SEEN);
    writeSeen(seen);
  }, [revision]);
  return revision;
}
