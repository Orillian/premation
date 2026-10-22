/**
 * D5: what the C++ engine could not draw in the active composition.
 *
 * With the engine as the viewport, a layer that uses a feature its scene
 * builder has not ported yet is drawn WITHOUT that feature (the engine reports
 * it on `layerErrors` with stage 'unported'; a failed effect / decode / plugin
 * reports its own stage). The frame still shows everything else — never a blank
 * viewport — and this says, without blocking anything, what is missing and on
 * how many layers. Dismissable until the set changes.
 *
 * Reads: the `errors:<comp>` mirror key as the trigger (the engine announces
 * changes only), `getLayerErrors` for the set (so a notice mounted after the
 * announcement still knows it). React renders only when the set changes.
 */

import { useEffect, useMemo, useState } from 'react';
import type { LayerError } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { useActiveCompId, useMirrorKeys, useMirror } from '@hooks/useMirror';
import styles from './EngineUnportedNotice.module.css';
import { t } from '@core/i18n';

export interface Group {
  what: string;
  /** Stage 'unported': a feature the C++ engine does not render. */
  unported: boolean;
  /** Stage 'warning': something the layer draws without (a missing plugin, an unreadable asset …); exports complete. */
  warning?: boolean;
  layers: number;
  names: string[];
}

function groupErrors(errors: readonly LayerError[], nameOf: (id: string) => string): Group[] {
  const by = new Map<string, Group & { ids: Set<string> }>();
  for (const e of errors) {
    // Failing expressions have their own bar (ExpressionErrorBar): the frame is not drawn without anything.
    if (e.stage === 'expression') continue;
    const unported = e.stage === 'unported';
    const warning = e.stage === 'warning';
    const what = unported || warning ? e.message : `${e.stage}: ${e.message}`;
    let g = by.get(what);
    if (!g) {
      g = { what, unported, warning, layers: 0, names: [], ids: new Set() };
      by.set(what, g);
    }
    if (!g.ids.has(e.layer)) {
      g.ids.add(e.layer);
      g.layers += 1;
      if (g.names.length < 3) g.names.push(nameOf(e.layer));
    }
  }
  return [...by.values()]
    .map(({ ids: _ids, ...g }) => g)
    .sort((a, b) => Number(b.unported) - Number(a.unported) || b.layers - a.layers || a.what.localeCompare(b.what));
}

/** What the engine says for a Premation Cloud plugin it found but may not load (effects_port.hpp kPluginLockedReason). */
const CLOUD_LOCKED = /^requires Premation Cloud /;
/** …and for an effect whose plugin is not installed, or failed to load. */
const MISSING_PLUGIN = /^missing plugin /;

/**
 * The notice's heading. "The C++ engine does not render yet" is true only of an unported feature:
 * a Cloud-locked plugin is not a gap in the engine (2026-10-13 QA: a locked plugin's notice said it
 * was), nor is a plugin that is not installed.
 */
export function noticeHeading(groups: readonly Group[], layerCount: number): string {
  const layers = layerCount === 1
    ? t('workspace.unportedNotice.layerCountOne', '({n} layer)', { n: layerCount })
    : t('workspace.unportedNotice.layerCountOther', '({n} layers)', { n: layerCount });
  const n = groups.length;
  // The engine's own words (stage 'unported' or 'warning'), not another stage's prefixed message.
  const engineSaid = (g: Group): boolean => g.unported || g.warning === true;
  if (n > 0 && groups.every((g) => engineSaid(g) && CLOUD_LOCKED.test(g.what))) {
    return n === 1
      ? t('workspace.unportedNotice.cloudOne', 'Needs Premation Cloud: an effect drawn without its plugin {layers}', { layers })
      : t('workspace.unportedNotice.cloudOther', 'Needs Premation Cloud: {n} effects drawn without their plugin {layers}', { n, layers });
  }
  if (n > 0 && groups.every((g) => engineSaid(g) && MISSING_PLUGIN.test(g.what))) {
    return n === 1
      ? t('workspace.unportedNotice.missingPluginOne', 'Missing plugin: an effect drawn without it {layers}', { layers })
      : t('workspace.unportedNotice.missingPluginOther', 'Missing plugin: {n} effects drawn without them {layers}', { n, layers });
  }
  if (n > 0 && groups.every((g) => g.unported && !CLOUD_LOCKED.test(g.what) && !MISSING_PLUGIN.test(g.what))) {
    return n === 1
      ? t('workspace.unportedNotice.unportedOne', 'Drawn without one feature the C++ engine does not render yet {layers}', { layers })
      : t('workspace.unportedNotice.unportedOther', 'Drawn without {n} features the C++ engine does not render yet {layers}', { n, layers });
  }
  return n === 1
    ? t('workspace.unportedNotice.genericOne', 'Drawn without one feature {layers}', { layers })
    : t('workspace.unportedNotice.genericOther', 'Drawn without {n} features {layers}', { n, layers });
}

export function EngineUnportedNotice(): JSX.Element | null {
  const comp = useActiveCompId();
  const mirror = useMirror();
  const trigger = useMirrorKeys(comp ? [`errors:${comp}`] : []);
  const [errors, setErrors] = useState<readonly LayerError[]>([]);
  const [dismissed, setDismissed] = useState('');

  useEffect(() => {
    if (!comp) {
      setErrors([]);
      return;
    }
    let live = true;
    void engine().query({ type: 'getLayerErrors', comp }).then((r) => {
      if (!live) return;
      // The mirror's copy when the query cannot answer (an older engine).
      setErrors(r.ok && r.value.errors.length > 0 ? r.value.errors : mirror.layerErrors(comp));
    });
    return () => {
      live = false;
    };
  }, [comp, trigger, mirror]);

  const groups = useMemo(
    () => groupErrors(errors, (id) => mirror.layer(id)?.name ?? id),
    [errors, mirror],
  );
  const signature = groups.map((g) => `${g.what}×${g.layers}`).join('|');
  if (groups.length === 0 || dismissed === signature) return null;

  const layerCount = new Set(errors.filter((e) => e.stage !== 'expression').map((e) => e.layer)).size;
  return (
    <div className={styles.notice} role="status" data-engine-unported="">
      <div className={styles.head}>
        <span className={styles.title}>{noticeHeading(groups, layerCount)}</span>
        <button type="button" className={styles.close} onClick={() => setDismissed(signature)} aria-label={t('workspace.unportedNotice.dismiss', 'Dismiss')}>×</button>
      </div>
      <ul className={styles.list}>
        {groups.slice(0, 6).map((g) => (
          <li key={g.what}>
            <span className={styles.what}>{g.what}</span>
            <span className={styles.layers}>
              {g.layers === 1
                ? t('workspace.unportedNotice.layersListOne', '{n} layer: {names}', { n: g.layers, names: g.names.join(', ') })
                : t('workspace.unportedNotice.layersListOther', '{n} layers: {names}', { n: g.layers, names: g.names.join(', ') })}
              {g.layers > g.names.length ? ', …' : ''}
            </span>
          </li>
        ))}
        {groups.length > 6 && <li className={styles.layers}>{t('workspace.unportedNotice.andMore', 'and {n} more', { n: groups.length - 6 })}</li>}
      </ul>
    </div>
  );
}
