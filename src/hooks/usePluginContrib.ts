/**
 * P7: re-render when what the native plugins contribute (commands, importers,
 * output modules, panels — core/nativePlugins/pluginContrib.ts) changes. Asks
 * the engine once on mount and again on every document reset (an engine
 * restart, another project); an
 * install, a rescan or enable / disable refreshes it from pluginStore.ts.
 * Returns the cache's revision (a memo key).
 */

import { useEffect, useSyncExternalStore } from 'react';
import { engine, subscribeEngine } from '@core/engine/engineInstance';
import { pluginContribRevision, refreshPluginContrib, subscribePluginContrib } from '@core/nativePlugins/pluginContrib';

export function usePluginContrib(): number {
  const revision = useSyncExternalStore(subscribePluginContrib, pluginContribRevision, pluginContribRevision);
  useEffect(() => {
    const refresh = () => {
      try {
        void refreshPluginContrib(engine());
      } catch {
        // No engine yet: the subscription below asks when it boots.
      }
    };
    refresh();
    // A restarted engine (or another project) answers with a reset: its plugins may differ.
    return subscribeEngine((batch) => {
      if (batch.events.some((e) => e.type === 'documentReset')) refresh();
    });
  }, []);
  return revision;
}
