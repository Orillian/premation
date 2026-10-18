/**
 * An effect plugin's own sidebar panel (`plugin:<id>`, owner 2026-10-14): the
 * bundle's page (`ui/index.html`) docked as a panel of its own, the way After
 * Effects gives Element 3D or Optical Flares a window of their own instead of
 * folding them into Effect Controls.
 *
 * The page edits one effect instance, so the panel follows the selection: the
 * first selected layer's first effect from this plugin. With none, it says so
 * and offers to apply the plugin's effect to the selected layer. The frame is
 * the same one the effect card's "Open Panel…" window shows
 * (Effects/PluginPanel.tsx): one protocol, every edit an engine command.
 */

import { useSyncExternalStore } from 'react';
import { Button } from '@components/Button';
import { EmptyState } from '@components/EmptyState';
import { Icon } from '@components/Icon';
import { effectDefFor } from '@core/inspector/effectCatalog';
import {
  isPluginEffectDef,
  pluginEffectDefs,
  pluginEffectDefsRevision,
  subscribePluginEffectDefs,
  type PluginEffectDef,
} from '@core/inspector/pluginEffectDefs';
import { mirrorEffects } from '@core/mirror/effects';
import { useMirrorLayer, useMirrorTreeGroups } from '@hooks/useMirror';
import { PluginEffectFrame } from '@layout/Effects/PluginPanel';
import { addEffectEdit } from '@layout/Effects/effectEdits';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import styles from './PluginEffectHomePanel.module.css';

const EFFECTS_ROOT: readonly string[] = ['effects'];

export function PluginEffectHomePanel({ plugin, pluginName }: { plugin: string; pluginName: string }): JSX.Element {
  // A plugin's effect definitions can arrive after the panel drew.
  useSyncExternalStore(subscribePluginEffectDefs, pluginEffectDefsRevision, pluginEffectDefsRevision);
  const layerId = useSelectionStore((s) => s.ids[0] ?? null);
  const layer = useMirrorLayer(layerId);
  const tree = useMirrorTreeGroups(layerId, EFFECTS_ROOT);
  const time = useActiveWorkspace()?.time ?? 0;

  const own = (type: string): PluginEffectDef | undefined => {
    const def = effectDefFor(type);
    return isPluginEffectDef(def) && def.provider === plugin ? def : undefined;
  };
  const effect = layerId ? mirrorEffects(tree).find((e) => own(e.type)) : undefined;
  const def = effect ? own(effect.type) : undefined;

  if (layerId && effect && def) {
    return (
      <div className={styles.panel}>
        <div className={styles.context}>
          <Icon name="layers" size="sm" className={styles.contextIcon} />
          <span className={styles.contextText} title={layer?.name}>{layer?.name ?? 'Layer'}</span>
          <span className={styles.contextMeta}>{def.label}</span>
        </div>
        <div className={styles.frame}>
          <PluginEffectFrame key={`${layerId}:${effect.id}`} nodeId={layerId} effect={effect} def={def} time={time} plugin={plugin} />
        </div>
      </div>
    );
  }

  const offered = pluginEffectDefs().filter((d) => d.provider === plugin);
  const apply = (d: PluginEffectDef): void => {
    if (!layerId) return;
    void addEffectEdit([layerId], d.type).then((added) => {
      if (added.length > 0) useUIStore.getState().notify({ level: 'success', message: `Added ${d.label}`, durationMs: 2400 });
    });
  };
  return (
    <div className={styles.panel}>
      <EmptyState
        icon="plugin"
        message={
          layerId
            ? `${layer?.name ?? 'This layer'} has no ${pluginName} effect. Apply it to edit the layer here.`
            : `Select a layer with ${pluginName} applied to edit it here.`
        }
        action={
          layerId && offered.length > 0 ? (
            <>
              {offered.map((d) => (
                <Button key={d.type} size="sm" variant="secondary" leftIcon={<Icon name="plus" size="sm" />} onClick={() => apply(d)}>
                  Apply {d.label}
                </Button>
              ))}
            </>
          ) : undefined
        }
      />
    </div>
  );
}
