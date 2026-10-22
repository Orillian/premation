/**
 * An effect parameter's expression in Effect Controls (After Effects shows the
 * expression switch and editor on effect parameters exactly as on transform
 * properties). Below the parameter's row: nothing while the parameter has no
 * expression; a one-line `=` summary of the source while one is attached;
 * the full ExpressionEditor while open.
 *
 * Opens on the same REQUEST every other surface answers
 * (`requestExpressionEditor`: Alt-click on the stopwatch, the row menu's Add /
 * Edit Expression, Alt+Shift+=), so this panel and the timeline's floating
 * editor open in step.
 */

import { useEffect, useState } from 'react';
import { cn } from '@utils/cn';
import { t } from '@core/i18n';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch } from '@hooks/useMirror';
import { trackExpressionFacts } from '@core/mirror/memberExpressions';
import {
  consumeExpressionEditorRequest,
  onExpressionEditorRequest,
} from '@core/animation/expressionEditorRequests';
import { ExpressionEditor } from '@layout/Motion/ExpressionEditor';
import styles from './ParamExpression.module.css';

function useParamExpressionOpen(nodeId: string, track: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (consumeExpressionEditorRequest(nodeId, track)) setOpen(true);
    return onExpressionEditorRequest((ref) => {
      if (ref.nodeId === nodeId && ref.prop === track && consumeExpressionEditorRequest(nodeId, track)) setOpen(true);
    });
  }, [nodeId, track]);
  return [open, setOpen];
}

export function ParamExpression({ nodeId, track, label }: { nodeId: string; track: string; label: string }): JSX.Element | null {
  useMirrorTrackWatch([nodeId], [track]);
  const [open, setOpen] = useParamExpressionOpen(nodeId, track);
  const facts = trackExpressionFacts(documentMirror(), nodeId, track);
  if (!facts && !open) return null;
  if (open) {
    return (
      <div className={styles.editor}>
        <ExpressionEditor nodeId={nodeId} prop={track} label={label} />
        <button type="button" className={styles.close} onClick={() => setOpen(false)}>
          {t('effects.expression.close', 'Done')}
        </button>
      </div>
    );
  }
  const firstLine = facts!.source.split('\n').find((l) => l.trim() !== '') ?? '';
  return (
    <button
      type="button"
      className={cn(styles.summary, !facts!.enabled && styles.off, facts!.error && styles.error)}
      title={facts!.error || t('effects.expression.edit', 'Edit expression')}
      onClick={() => setOpen(true)}
    >
      <span className={styles.eq}>=</span>
      <span className={styles.source}>{firstLine}</span>
    </button>
  );
}
