/**
 * SelectionAlignRow — align and distribute as ONE compact row at the top of
 * the Properties panel, shown whenever two or more layers are selected.
 *
 * Align otherwise lives only in its own dock panel, which nobody opens for a
 * two-click job. Selecting several layers is exactly the moment you want it,
 * so the inspector offers it then, and only then.
 *
 * Same `alignNodes` / `distributeMinimum` as `AlignPanel`, so the maths, the
 * enablement rule and the undo entry are shared. The "relative to" choice is a
 * single toggle at the end of the row rather than a segmented control, which
 * keeps the whole thing one line at the panel's narrowest width; the full
 * distribute-by-edge set stays in the Align panel.
 */

import { useState } from 'react';
import { useActiveCompSize } from './inspectorMirror';
import { distributeMinimum, type AlignMode } from '@core/scene/alignNodes';
import { alignLayers } from './inspectorEdits';
import { Icon, type IconName } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { t } from '@core/i18n';
import styles from './SelectionAlignRow.module.css';

function alignButtons(): ReadonlyArray<{ id: AlignMode; icon: IconName; label: string }> {
  return [
    { id: 'left', icon: 'align-left', label: t('inspector.selectionAlign.align.alignLeft', 'Align left') },
    { id: 'center-h', icon: 'align-center', label: t('inspector.selectionAlign.align.alignHorizontalCenters', 'Align horizontal centers') },
    { id: 'right', icon: 'align-right', label: t('inspector.selectionAlign.align.alignRight', 'Align right') },
    { id: 'top', icon: 'align-top', label: t('inspector.selectionAlign.align.alignTop', 'Align top') },
    { id: 'middle-v', icon: 'align-middle', label: t('inspector.selectionAlign.align.alignVerticalCenters', 'Align vertical centers') },
    { id: 'bottom', icon: 'align-bottom', label: t('inspector.selectionAlign.align.alignBottom', 'Align bottom') },
  ];
}

function distributeButtons(): ReadonlyArray<{ id: AlignMode; icon: IconName; label: string }> {
  return [
    { id: 'distribute-space-h', icon: 'distribute-horizontal', label: t('inspector.selectionAlign.distribute.distributeHorizontalSpacing', 'Distribute horizontal spacing') },
    { id: 'distribute-space-v', icon: 'distribute-vertical', label: t('inspector.selectionAlign.distribute.distributeVerticalSpacing', 'Distribute vertical spacing') },
  ];
}

export function SelectionAlignRow({ nodeIds = [] }: { nodeIds?: ReadonlyArray<string> }): JSX.Element | null {
  const [alignTo, setAlignTo] = useState<'selection' | 'composition'>('selection');
  const { width: compWidth, height: compHeight } = useActiveCompSize();
  if (nodeIds.length < 2) return null;

  const count = nodeIds.length;
  const button = (a: { id: AlignMode; icon: IconName; label: string }, min: number): JSX.Element => {
    const disabled = count < min;
    return (
      <IconButton
        key={a.id}
        size="sm"
        aria-label={a.label}
        tooltip={disabled ? t('inspector.selectionAlign.needMore', '{name} — select {n}+ layers', { name: a.label, n: min }) : a.label}
        disabled={disabled}
        onClick={() => { void alignLayers(nodeIds, a.id, alignTo, compWidth, compHeight); }}
      >
        <Icon name={a.icon} size="sm" />
      </IconButton>
    );
  };

  const toComp = alignTo === 'composition';
  return (
    <div className={styles.row} role="toolbar" aria-label={t('inspector.selectionAlign.toolbar', 'Align selected layers')}>
      {alignButtons().map((a) => button(a, toComp ? 1 : 2))}
      <span className={styles.divider} aria-hidden="true" />
      {/* B3-legacy: not a write — `distributeMinimum` is a pure count the ratchet's verb match flags (rule false positive). */}
      {distributeButtons().map((a) => button(a, distributeMinimum(alignTo)))}
      <span className={styles.divider} aria-hidden="true" />
      <IconButton
        size="sm"
        active={toComp}
        aria-pressed={toComp}
        aria-label={t('inspector.selectionAlign.toComp', 'Align to composition')}
        tooltip={toComp ? t('inspector.selectionAlign.toCompOn', 'Aligning to the composition frame') : t('inspector.selectionAlign.toCompOff', 'Aligning to the selection — click to align to the composition')}
        onClick={() => setAlignTo(toComp ? 'selection' : 'composition')}
      >
        <Icon name={toComp ? 'solid' : 'select-all'} size="sm" />
      </IconButton>
    </div>
  );
}

export default SelectionAlignRow;
