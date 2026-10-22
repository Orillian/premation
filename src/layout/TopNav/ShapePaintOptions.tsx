/**
 * The tool-options bar's Fill and Stroke swatches for the shape and pen tools —
 * AE's toolbar Fill / Stroke: a type (None / Solid / Linear / Radial) and a
 * colour for each, and the stroke width as a scrubbable px field. They set what
 * the NEXT drawn shape is born with (`shapeToolPaint`); they never edit a layer.
 */

import { useReducer } from 'react';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { setShapeToolPaint, shapeToolPaint, type ShapeToolPaint, type ToolPaintType } from '@core/workspace/shapeToolPaint';
import { t } from '@core/i18n';
import styles from './ToolOptionsBar.module.css';

/** A function, not a constant: `t()` must run at render time. */
function paintTypes(): ReadonlyArray<{ value: ToolPaintType; label: string }> {
  return [
    { value: 'none', label: t('topNav.shapePaint.none', 'None') },
    { value: 'solid', label: t('topNav.shapePaint.solid', 'Solid') },
    { value: 'linear', label: t('topNav.shapePaint.linear', 'Linear') },
    { value: 'radial', label: t('topNav.shapePaint.radial', 'Radial') },
  ];
}

export function ShapePaintOptions(): JSX.Element {
  // The state is a framework-free singleton; this only re-renders the bar.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const set = (patch: Partial<ShapeToolPaint>): void => {
    setShapeToolPaint(patch);
    bump();
  };
  const p = shapeToolPaint;
  const types = paintTypes();

  return (
    <>
      <div className={styles.opt}>
        <span className={styles.optLabel}>{t('topNav.shapePaint.fill', 'Fill')}</span>
        <select
          className={styles.paintSelect}
          value={p.fillType}
          onChange={(e) => set({ fillType: e.target.value as ToolPaintType })}
          aria-label={t('topNav.shapePaint.fillTypeAria', 'New shape fill type')}
          title={t('topNav.shapePaint.fillTitle', 'Fill for newly drawn shapes')}
        >
          {types.map((ty) => <option key={ty.value} value={ty.value}>{ty.label}</option>)}
        </select>
        {p.fillType !== 'none' && (
          <ColorPicker
            compact
            className={styles.paintSwatchTrigger}
            value={p.fillColor}
            onChange={(hex) => set({ fillColor: hex })}
            aria-label={t('topNav.shapePaint.fillColorAria', 'New shape fill color')}
          />
        )}
      </div>
      <div className={styles.opt}>
        <span className={styles.optLabel}>{t('topNav.shapePaint.stroke', 'Stroke')}</span>
        <select
          className={styles.paintSelect}
          value={p.strokeType}
          onChange={(e) => set({ strokeType: e.target.value as ToolPaintType })}
          aria-label={t('topNav.shapePaint.strokeTypeAria', 'New shape stroke type')}
          title={t('topNav.shapePaint.strokeTitle', 'Stroke for newly drawn shapes')}
        >
          {types.map((ty) => <option key={ty.value} value={ty.value}>{ty.label}</option>)}
        </select>
        {p.strokeType !== 'none' && (
          <>
            <ColorPicker
              compact
              className={styles.paintSwatchTrigger}
              value={p.strokeColor}
              onChange={(hex) => set({ strokeColor: hex })}
              aria-label={t('topNav.shapePaint.strokeColorAria', 'New shape stroke color')}
            />
            <ValueField
              value={p.strokeWidth}
              unit="px"
              min={0}
              max={400}
              onChange={(v) => set({ strokeWidth: Number(v) })}
              aria-label={t('topNav.shapePaint.strokeWidthAria', 'New shape stroke width')}
            />
          </>
        )}
      </div>
    </>
  );
}

export default ShapePaintOptions;
