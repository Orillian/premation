/**
 * After Effects' expression error bar, over the viewport: while any
 * expression in the active composition fails, one line names the layer, the
 * property, the line and the engine's message, with ◀ ▶ through the failures
 * and Edit, which opens that expression. The frame keeps rendering — a failing
 * expression falls back to the property's own value (CLAUDE.md: isolate,
 * record, continue).
 *
 * Reads the engine's `layerErrors` (stage 'expression', path = the property)
 * through the same mirror trigger as EngineUnportedNotice; React renders only
 * when the set changes.
 */

import { useEffect, useState } from 'react';
import type { LayerError } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { useActiveCompId, useMirrorKeys, useMirror } from '@hooks/useMirror';
import { requestExpressionEditor } from '@core/animation/expressionEditorRequests';
import { openTimelineExpressionEditor } from '@layout/Timeline/timelineExpressionEditor';
import { useSelectionStore } from '@stores/selectionStore';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { TooltipProvider } from '@components/Tooltip';
import { t } from '@core/i18n';
import styles from './ExpressionErrorBar.module.css';

export function expressionErrorsOf(errors: readonly LayerError[]): LayerError[] {
  return errors.filter((e) => e.stage === 'expression');
}

export function ExpressionErrorBar(): JSX.Element | null {
  const comp = useActiveCompId();
  const mirror = useMirror();
  const trigger = useMirrorKeys(comp ? [`errors:${comp}`] : []);
  const [errors, setErrors] = useState<readonly LayerError[]>([]);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState('');

  useEffect(() => {
    if (!comp) {
      setErrors([]);
      return;
    }
    let live = true;
    void engine().query({ type: 'getLayerErrors', comp }).then((r) => {
      if (!live) return;
      setErrors(expressionErrorsOf(r.ok ? r.value.errors : mirror.layerErrors(comp)));
    });
    return () => {
      live = false;
    };
  }, [comp, trigger, mirror]);

  const signature = errors.map((e) => `${e.layer}|${e.path ?? ''}|${e.message}`).join('\n');
  if (errors.length === 0 || dismissed === signature) return null;

  const at = Math.min(index, errors.length - 1);
  const e = errors[at]!;
  const layerName = mirror.layer(e.layer)?.name ?? e.layer;
  const propName = e.path ? (mirror.tree(e.layer)?.nodes.get(e.path)?.name ?? e.path) : '';

  const edit = (): void => {
    if (!e.path) return;
    const selection = useSelectionStore.getState();
    if (!selection.ids.includes(e.layer)) selection.set([e.layer]);
    requestExpressionEditor({ nodeId: e.layer, prop: e.path });
    openTimelineExpressionEditor(e.layer, e.path);
  };

  return (
    // Its own tooltip provider (the icon buttons' labels): the viewport must not need the app root's.
    <TooltipProvider>
    <div className={styles.bar} role="alert" data-expression-errors="">
      <Icon name="warning" size="sm" className={styles.icon} />
      <span className={styles.where}>{propName ? `${layerName} · ${propName}` : layerName}</span>
      <span className={styles.message}>{e.message}</span>
      {errors.length > 1 && (
        <span className={styles.nav}>
          <IconButton
            size="xs"
            aria-label={t('workspace.expressionErrors.previous', 'Previous expression error')}
            onClick={() => setIndex((at - 1 + errors.length) % errors.length)}
          >
            <Icon name="chevron-left" size="sm" />
          </IconButton>
          <span className={styles.count}>{t('workspace.expressionErrors.count', '{n} of {total}', { n: at + 1, total: errors.length })}</span>
          <IconButton
            size="xs"
            aria-label={t('workspace.expressionErrors.next', 'Next expression error')}
            onClick={() => setIndex((at + 1) % errors.length)}
          >
            <Icon name="chevron-right" size="sm" />
          </IconButton>
        </span>
      )}
      {e.path ? (
        <Button size="xs" variant="ghost" onClick={edit}>
          {t('workspace.expressionErrors.edit', 'Edit')}
        </Button>
      ) : null}
      <IconButton
        size="xs"
        aria-label={t('workspace.expressionErrors.dismiss', 'Dismiss')}
        onClick={() => setDismissed(signature)}
      >
        <Icon name="close" size="sm" />
      </IconButton>
    </div>
    </TooltipProvider>
  );
}
