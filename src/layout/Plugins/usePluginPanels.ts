/**
 * P7d: register the loaded native plugins' panels with the dock — each effect
 * plugin's own panel (its `ui/index.html`) and every manifest panel. Called
 * once by the editor shell; re-runs when the plugin list changes, and the
 * shell re-renders, so the dock renderers (panelRenderers.ts) pick up a newly
 * installed plugin's panel.
 *
 * A plugin's panels are its own sidebar items (owner 2026-10-14, AE's model:
 * an installed plugin brings its window, it is not folded into the Effects
 * panel). The FIRST time this machine sees a panel it is docked on the right
 * sidebar as a tab of its own; from then on the saved layout decides — a panel
 * the user closed stays closed (Plugins menu ▸ Panels brings it back). The
 * "seen" list is editor state on this machine (localStorage, every access
 * wrapped), never the project document.
 */

import { useEffect } from 'react';
import { pluginPanels } from '@core/nativePlugins/pluginContrib';
import { usePluginContrib } from '@hooks/usePluginContrib';
import { useLayoutStore } from '@stores/layoutStore';

export const SEEN_PLUGIN_PANELS_KEY = 'premation.pluginPanels.seen.v1';

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
    // A blocked store: the panel is docked again next launch, which is harmless.
  }
}

export function usePluginPanels(): number {
  const revision = usePluginContrib();
  useEffect(() => {
    const store = useLayoutStore.getState();
    const openBefore = new Set(Object.values(store.panelOrder).flat());
    const seen = readSeen();
    let seenChanged = false;
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
      if (!seen.has(p.panelId)) {
        // New on this machine: keep it docked as its own sidebar tab.
        seen.add(p.panelId);
        seenChanged = true;
      } else if (!openBefore.has(p.panelId)) {
        // Seen before and not in the saved layout: the user closed it.
        useLayoutStore.getState().closePanel(p.panelId);
      }
    }
    if (seenChanged) writeSeen(seen);
  }, [revision]);
  return revision;
}
