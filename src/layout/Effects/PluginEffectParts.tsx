/**
 * The parts of an effect card only native plugin effects have (AE parity 2.9):
 *
 *   - the plugin's own parameter UI state (UPDATE_PARAMS_UI through the
 *     engine's `getEffectUi`): a param it hides is not drawn, one it renames
 *     shows its new name, one it disables is greyed out;
 *   - its buttons (PR_PARAM_BUTTON), each `invokeEffectAction` — one undo entry;
 *   - a card for an effect whose plugin is missing, instead of no card at all.
 *
 * The UI state is asked again when the time or the effect's values change; a
 * failed query leaves every param as declared (the plugin may be disabled).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { EffectParamUi, EffectUi, PluginInfo } from '@motion/engine-api';
import { secondsToFlicks } from '@motion/engine-api';
import { Button } from '@components/Button';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { paths, ref } from '@core/engine/propRefs';
import type { Effect } from '@core/inspector/effectCatalog';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import { pluginOfType } from '@core/project/missingPluginContent';
import { pluginContribRevision, pluginForEffect, subscribePluginContrib } from '@core/nativePlugins/pluginContrib';
import panel from './EffectsPanel.module.css';
import row from '@layout/Inspector/TextAnimatorControls.module.css';
import { t } from '@core/i18n';

/** The plugin's UI state: `byKey` (key → that param's state) and the whole answer (panel, plugin). Null until the engine answers (or when it cannot). */
export function usePluginEffectUi(
  nodeId: string,
  effect: Effect,
  time: number,
): { byKey: Map<string, EffectParamUi>; ui: EffectUi } | null {
  const [ui, setUi] = useState<{ byKey: Map<string, EffectParamUi>; ui: EffectUi } | null>(null);
  const valuesKey = JSON.stringify(effect.params ?? {});
  useEffect(() => {
    let alive = true;
    void engine()
      .query({ type: 'getEffectUi', layer: nodeId, effect: paths.effectGroup(effect.id), time: secondsToFlicks(time) })
      .then((res) => {
        if (!alive) return;
        setUi(res.ok ? { byKey: new Map(res.value.params.map((p) => [p.key, p])), ui: res.value } : null);
      })
      .catch(() => { if (alive) setUi(null); });
    return () => { alive = false; };
  }, [nodeId, effect.id, time, valuesKey]);
  return ui;
}

/**
 * One plugin button (PR_PARAM_BUTTON), drawn at its place in the param list —
 * AE's Effect Controls puts a plugin's button on its own row where the plugin
 * declared it, label in the value column. A press is ONE undo entry.
 */
export function PluginEffectButton({
  nodeId,
  effect,
  def,
  action,
  label,
  disabled = false,
}: {
  nodeId: string;
  effect: Effect;
  def: PluginEffectDef;
  action: string;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={row.paramRow} style={{ flexWrap: 'wrap', gap: 6, paddingLeft: 22 }}>
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={() => {
          setError(null);
          void edit(`${def.label}: ${label}`, {
            type: 'invokeEffectAction',
            group: ref(nodeId, paths.effectGroup(effect.id)),
            action,
          }).then((r) => { if (!r.ok) setError(r.error.message); });
        }}
      >
        {label}
      </Button>
      {error ? <span className={panel.hint} role="alert">{error}</span> : null}
    </div>
  );
}

/**
 * Why an effect has no definition, as the card says it: its plugin is installed
 * but not loaded (requires Premation Cloud, turned off, failed), or missing.
 */
export function missingPluginReason(type: string, plugin: PluginInfo | undefined): string {
  if (!plugin) {
    return t(
      'effects.missingPlugin.missing',
      'Missing plugin {plugin}. The effect is kept and passes the layer through until the plugin is installed (Dashboard ▸ Plugins).',
      { plugin: pluginOfType(type) },
    );
  }
  const who = plugin.name || plugin.id;
  switch (plugin.status) {
    case 'locked':
      return t(
        'effects.missingPlugin.locked',
        '{plugin} requires Premation Cloud. The effect is kept and passes the layer through until the plan is active (Dashboard ▸ Plugins ▸ Installed ▸ Check plan).',
        { plugin: who },
      );
    case 'disabled':
      return t(
        'effects.missingPlugin.disabled',
        '{plugin} is turned off. The effect is kept and passes the layer through until it is turned on (Dashboard ▸ Plugins ▸ Installed).',
        { plugin: who },
      );
    case 'loaded':
      // Loaded, yet this effect is not one of its own (an older version's effect).
      return t(
        'effects.missingPlugin.notProvided',
        '{plugin} does not provide this effect. The effect is kept and passes the layer through.',
        { plugin: who },
      );
    default:
      return plugin.error
        ? t('effects.missingPlugin.failedReason', '{plugin} did not load: {error}. The effect is kept and passes the layer through.', { plugin: who, error: plugin.error })
        : t('effects.missingPlugin.failed', '{plugin} did not load. The effect is kept and passes the layer through.', { plugin: who });
  }
}

/** An effect whose definition is unknown: its plugin is missing, or installed but not loaded. */
export function MissingPluginCard({ effect, name }: { effect: Effect; name?: string }): JSX.Element {
  useSyncExternalStore(subscribePluginContrib, pluginContribRevision, pluginContribRevision);
  return (
    <div className={panel.effectCardItem}>
      <div className={panel.effectCardHead}>
        <span className={panel.fxMark} aria-hidden>fx</span>
        <span className={panel.itemLabelOff}>{name ?? effect.type}</span>
      </div>
      <div className={panel.hint} style={{ padding: '4px 8px 8px' }}>
        {missingPluginReason(effect.type, pluginForEffect(effect.type))}
      </div>
    </div>
  );
}
