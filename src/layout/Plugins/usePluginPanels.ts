/**
 * P7d: register the loaded native plugins' panels with the dock (on demand,
 * like the built-in on-demand panels: closed unless a saved layout had them
 * open; the Plugins menu ▸ Panels opens one). Called once by the editor shell;
 * re-runs when the plugin list changes, and the shell re-renders, so the dock
 * renderers (panelRenderers.ts) pick up a newly installed plugin's panel.
 */

import { useEffect } from 'react';
import { pluginPanels } from '@core/nativePlugins/pluginContrib';
import { usePluginContrib } from '@hooks/usePluginContrib';
import { useLayoutStore } from '@stores/layoutStore';

export function usePluginPanels(): number {
  const revision = usePluginContrib();
  useEffect(() => {
    const store = useLayoutStore.getState();
    const openBefore = new Set(Object.values(store.panelOrder).flat());
    for (const p of pluginPanels()) {
      if (store.panels[p.panelId]) continue;
      store.registerPanel({
        id: p.panelId,
        title: p.panel.name,
        icon: 'plugin',
        region: 'rightInspector',
        weight: 4,
        closable: true,
        onDemand: true,
      });
      if (!openBefore.has(p.panelId)) useLayoutStore.getState().closePanel(p.panelId);
    }
  }, [revision]);
  return revision;
}
