/**
 * One row of Effects ▸ Object Matte ▸ Selections (After Effects lists each
 * selection of an Object Matte there): the selection's name and whether it
 * adds to or subtracts from the matte. A selection is drawn as an outline mask
 * on the layer; clicking the row selects the layer and picks that mask (the
 * Layer panel's mask selection), as clicking a selection in AE does.
 */

import type { CSSProperties } from 'react';
import { cn } from '@utils/cn';
import { useLayerViewerStore } from '@stores/layerViewerStore';
import { useSelectionStore } from '@stores/selectionStore';
import { t } from '@core/i18n';
import styles from './Timeline.module.css';

export function SelectionRowHeader({ nodeId, maskId, label, mode, style }: {
  nodeId: string;
  maskId: string;
  label: string;
  mode: 'add' | 'subtract';
  style: CSSProperties;
}): JSX.Element {
  const selected = useLayerViewerStore((s) => s.maskSelection?.pathId === maskId);
  const pick = (): void => {
    const sel = useSelectionStore.getState();
    if (sel.ids.length !== 1 || sel.ids[0] !== nodeId) sel.set([nodeId]);
    useLayerViewerStore.getState().selectMask({ pathId: maskId, point: null });
  };
  const modeLabel = mode === 'subtract' ? t('timeline.objectMatte.subtract', 'Subtract') : t('timeline.objectMatte.add', 'Add');
  return (
    <div className={cn(styles.propHeader, selected && styles.propHeaderSelected)} style={style}>
      <span
        className={cn(styles.propName, styles.propNameSelectable, selected && styles.propNameSelected)}
        title={t('timeline.objectMatte.selectionTitle', '{name}: click to select its mask', { name: label })}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={(e) => { e.stopPropagation(); pick(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        }}
      >
        {label}
      </span>
      <div className={styles.propValues}>
        <span className={styles.selectionMode}>{modeLabel}</span>
      </div>
    </div>
  );
}
