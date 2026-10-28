/**
 * The Project Health verdict for the active composition (`projectHealth.ts`),
 * wired to its sources: the engine memory poll (2 s, shared with the memory
 * meter), the document mirror's comp / layers / items / layer errors, and the
 * Use Proxies preference.
 *
 * Wakes on the mirror keys it reads — the comp, its layer headers, the items,
 * `errors:<comp>` and the structure counter — never on a property value write
 * or a played frame.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { LayerInfo } from '@motion/engine-api';
import { compFps, useActiveCompId, useActiveMirrorComp, useMirror, useMirrorKeys, type DocumentMirror } from '@hooks/useMirror';
import { usePreferenceStore } from '@stores/preferenceStore';
import { engineMemorySnapshot, subscribeEngineMemory, type EngineMemorySnapshot } from './engineMemory';
import { compFootageFacts, projectHealth, type CompFootageFacts, type ProjectHealth } from './projectHealth';

/** The comp's layers, group children included (each is decoded on its own). */
function compLayers(m: DocumentMirror, roots: readonly string[]): LayerInfo[] {
  const out: LayerInfo[] = [];
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      const l = m.layer(id);
      if (!l) continue;
      out.push(l);
      if (l.children.length > 0) walk(l.children);
    }
  };
  walk(roots);
  return out;
}

export interface ProjectHealthState {
  health: ProjectHealth;
  footage: CompFootageFacts | null;
  mem: EngineMemorySnapshot;
  frameBudgetMs: number;
}

export function useProjectHealth(cache: { cached: number; total: number } | null = null): ProjectHealthState {
  const mem = useSyncExternalStore(subscribeEngineMemory, engineMemorySnapshot, engineMemorySnapshot);
  const useProxies = usePreferenceStore((s) => s.useProxies);
  const compId = useActiveCompId();
  const comp = useActiveMirrorComp();
  const m = useMirror();
  const id = comp?.id ?? compId;

  const layers = useMemo(() => (comp ? compLayers(m, comp.layers) : []), [m, comp]);
  const keys = useMemo(
    () => (id ? ['docStruct', 'items', `comp:${id}`, `errors:${id}`, ...layers.map((l) => `layer:${l.id}`)] : []),
    [id, layers],
  );
  const ver = useMirrorKeys(keys);

  const footage = useMemo(() => {
    if (!id || !comp) return null;
    return compFootageFacts(compLayers(m, comp.layers), (item) => m.item(item), m.layerErrors(id));
    // `ver` moves when any key read here changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, comp, m, ver]);

  const frameBudgetMs = 1000 / (compFps(comp) || 30);
  const s = mem.stats;
  const frameMs = s ? Math.max(s.cpuFrameMs, s.gpuFrameMs) : null;
  const cached = cache?.cached ?? 0;
  const total = cache?.total ?? 0;
  const hasCache = cache !== null;

  const health = useMemo(
    () => projectHealth({
      readout: mem.readout,
      memory: mem.health,
      footage,
      useProxies,
      frameMs,
      frameBudgetMs,
      cache: hasCache ? { cached, total } : null,
    }),
    [mem.readout, mem.health, footage, useProxies, frameMs, frameBudgetMs, hasCache, cached, total],
  );

  return { health, footage, mem, frameBudgetMs };
}
