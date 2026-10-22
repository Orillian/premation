/**
 * The Fill half of the Fill & Stroke section: paint type, colour, gradient
 * geometry, the on-canvas gradient gizmo, the stop list and the extra fills.
 *
 * Split out of `AppearanceSection.tsx` (2026-09-04); the markup and every
 * write path are what the section drew inline. The gradient-geometry rows
 * (angle, centre, radius) are the one thing that changed: each is now a
 * per-node accessor, so with three gradient layers selected "Angle" reads
 * `—` where they disagree and a drag turns all three.
 */

import { useMemo, useState } from 'react';
import { Icon } from '@components/Icon';
import { ColorPicker } from '@components/ColorPicker';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch } from '@hooks/useMirror';
import { mirrorFill, mirrorFills } from '@core/mirror/paintFields';
import { isTrackAnimated } from '@core/mirror/selection';
import {
  convertFill,
  sortedStops,
  solidFill,
  type FillType,
  type FillPaint,
} from '@core/paint/fill';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { normalizePaintOpOptions, type PaintOpOptions } from '@core/paint/stroke';
import { useGradientEditStore } from '@layout/Workspace/gradientEditStore';
import { ColorKfRow } from '../ColorKfRow';
import { setFillPaintEdit, setFillsEdit } from './paintEdits';
import { AnimatablePaintRow } from './AnimatablePaintRow';
import { PaintOpRows } from './PaintOpRows';
import { t } from '@core/i18n';

/**
 * A fill with its Composite/Blend Mode replaced — defaults normalised AWAY, so a
 * fill set back to Below/Normal is the exact object (and raster cache key) it
 * was before. The fields ride the paint object structurally; `FillPaint` itself
 * does not declare them.
 */
function withPaintOp<T extends FillPaint>(paint: T, opts: PaintOpOptions): T {
  const { composite: _c, blendMode: _b, ...rest } = paint as T & PaintOpOptions;
  return { ...rest, ...normalizePaintOpOptions(opts) } as T;
}
import { StopList } from './StopLists';
import { SummaryChip, TwirlGroup } from './TwirlGroup';
import styles from '../TransformSection.module.css';
import effStyles from '../../Effects/EffectsPanel.module.css';

/**
 * Per-node READ accessors for the gradient geometry — module constants so
 * their identity is stable across renders (the row memoises its aggregate on
 * them). A layer whose fill is not of the right type has no such value. The
 * writes are the engine's `layer/fillAngle` / `fillCenterX|Y` / `fillRadius`
 * (static value inside the paint; latentPropSpecs.ts on a shape).
 */
const FILL_ANGLE: PropertyAccess = {
  read: (id) => {
    const f = mirrorFill(documentMirror(), id);
    return f?.type === 'linear' ? f.angle : undefined;
  },
};

function radialAccess(field: 'cx' | 'cy' | 'radius'): PropertyAccess {
  return {
    read: (id) => {
      const f = mirrorFill(documentMirror(), id);
      return f?.type === 'radial' ? f[field] : undefined;
    },
  };
}

const FILL_CX = radialAccess('cx');
const FILL_CY = radialAccess('cy');
const FILL_RADIUS = radialAccess('radius');

/** What the rows read: the primary paint, the fill stack and the plain fill colour (paths — the track index answers paths too). */
const WATCHED: ReadonlyArray<string> = ['layer/fill', 'layer/fillPaint', 'layer/fills'];

export function FillRows({ nodeId }: { nodeId: string }): JSX.Element | null {
  const [, setSavedFill] = useState<FillPaint | null>(null);

  /**
   * On-canvas gradient editing, armed from here as well as from the canvas.
   *
   * This panel is exactly where you are standing when you decide that typing an
   * angle and four stop percentages is the wrong way to place a gradient, so it
   * is the second door into the gizmo — the first being a double-click on the
   * swatch chip the overlay draws at the layer's centre.
   */
  const gradientArmedId = useGradientEditStore((s) => s.nodeId);
  const armGradient = useGradientEditStore((s) => s.arm);
  const disarmGradient = useGradientEditStore((s) => s.disarm);
  const gradientArmed = gradientArmedId === nodeId;
  // B4: wake on this layer's header and its fill properties (info, keys, value).
  const watchIds = useMemo(() => [nodeId], [nodeId]);
  useMirrorTrackWatch(watchIds, WATCHED);

  const m = documentMirror();
  if (!m.layer(nodeId)) return null;

  const fill = mirrorFill(m, nodeId);
  const fills = mirrorFills(m, nodeId);

  const handleFillTypeChange = (type: FillType | 'none') => {
    if (type === 'none') {
      if (fill) setSavedFill(fill);
      void setFillPaintEdit('Fill Type', nodeId, undefined);
    } else {
      // Composite / blend survive a type switch — they belong to the paint
      // operation, not to whichever kind of paint it currently is.
      const next = convertFill(fill, type);
      void setFillPaintEdit('Fill Type', nodeId, fill ? withPaintOp(next, fill as PaintOpOptions) : next);
      setSavedFill(null);
    }
  };

  const handleFillColorChange = (color: string) => {
    const label = 'Fill Color';
    if (fill && fill.type === 'solid') {
      void setFillPaintEdit(label, nodeId, { ...fill, color });
    } else if (fill) {
      const newStops = [...fill.stops];
      if (newStops[0]) {
        newStops[0] = { ...newStops[0], color };
      }
      void setFillPaintEdit(label, nodeId, { ...fill, stops: newStops });
    } else {
      void setFillPaintEdit(label, nodeId, { type: 'solid', color });
    }
  };

  const isFillAnimated = ['fill', 'fill_r', 'fill_g', 'fill_b'].some((tr) => isTrackAnimated(m, nodeId, tr));

  const typeLabel = (f: FillPaint | undefined): string =>
    !f
      ? t('inspector.fill.none', 'None')
      : f.type === 'solid'
        ? t('inspector.fill.solid', 'Solid')
        : f.type === 'linear'
          ? t('inspector.fill.linear', 'Linear')
          : t('inspector.fill.radial', 'Radial');
  const chipColor = (f: FillPaint): string =>
    f.type === 'solid' ? f.color : sortedStops(f.stops)[0]?.color ?? '#ffffff';
  const blendNote = (f: FillPaint): string => {
    const mode = (f as PaintOpOptions).blendMode;
    return mode && mode !== 'normal' ? ` · ${mode}` : '';
  };

  return (
    <>
      {/* AE's Fill group: one twirl row, its paint summarised while closed. */}
      <TwirlGroup
        prefKey="contents.fill.0"
        label={<>{t('inspector.fill.nth', 'Fill {n}', { n: 1 })}{isFillAnimated && <span className={styles.animatedDot} />}</>}
        defaultOpen
        summary={fill
          ? <><SummaryChip color={chipColor(fill)} />{typeLabel(fill)}{blendNote(fill)}</>
          : t('inspector.fill.none', 'None')}
      >
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>{t('inspector.fill.type', 'Type')}</span>
              <select
                value={fill?.type ?? 'none'}
                onChange={(e) => handleFillTypeChange(e.target.value as FillType | 'none')}
                className={styles.select}
                style={{ width: 110 }}
                aria-label={t('inspector.fill.typeAria', 'Fill type')}
              >
                <option value="none">{t('inspector.fill.none', 'None')}</option>
                <option value="solid">{t('inspector.fill.solid', 'Solid')}</option>
                <option value="linear">{t('inspector.fill.linear', 'Linear')}</option>
                <option value="radial">{t('inspector.fill.radial', 'Radial')}</option>
              </select>
            </div>

            {fill && (
              <PaintOpRows
                label={t('inspector.fill.nth', 'Fill {n}', { n: 1 })}
                value={fill as PaintOpOptions}
                onChange={(next) => { void setFillPaintEdit('Fill Compositing', nodeId, withPaintOp(fill, next)); }}
              />
            )}

            {fill && fill.type === 'solid' && (
              <ColorKfRow
                nodeId={nodeId}
                propPrefix="fill"
                label={t('inspector.fill.color', 'Color')}
                value={fill.color}
                setValue={handleFillColorChange}
              />
            )}

            {fill && fill.type === 'linear' && (
              <AnimatablePaintRow nodeId={nodeId} prop="fillAngle" label={t('inspector.fill.angle', 'Angle')} access={FILL_ANGLE} />
            )}

            {fill && fill.type === 'radial' && (
              <>
                <AnimatablePaintRow nodeId={nodeId} prop="fillCenterX" label={t('inspector.fill.centerX', 'Center X')} access={FILL_CX} />
                <AnimatablePaintRow nodeId={nodeId} prop="fillCenterY" label={t('inspector.fill.centerY', 'Center Y')} access={FILL_CY} />
                <AnimatablePaintRow nodeId={nodeId} prop="fillRadius" label={t('inspector.fill.radius', 'Radius')} access={FILL_RADIUS} />
              </>
            )}

            {fill && (fill.type === 'linear' || fill.type === 'radial') && (
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button
                  type="button"
                  className={effStyles.addChip}
                  style={{ gap: 5, ...(gradientArmed ? { color: 'var(--color-primary)' } : {}) }}
                  aria-pressed={gradientArmed}
                  title={gradientArmed
                    ? t('inspector.fill.editingOnCanvasHint', 'Editing this gradient on the canvas — click to put the handles away (or press Escape)')
                    : t('inspector.fill.editOnCanvasHint', 'Drag the gradient axis and its stops directly on the canvas')}
                  onClick={() => (gradientArmed ? disarmGradient() : armGradient(nodeId, 0))}
                >
                  <Icon name="gradient" size="sm" />
                  <span>{gradientArmed ? t('inspector.fill.editingOnCanvas', 'Editing on canvas') : t('inspector.fill.editOnCanvas', 'Edit on canvas')}</span>
                </button>
                <span className={styles.popoverLabel}>{t('inspector.fill.stops', 'Stops')}</span>
                <StopList nodeId={nodeId} paint={fill} />
              </div>
            )}
      </TwirlGroup>

        {/* Extra fills (multi-fill stack, drawn over the primary), each its own
            closed twirl. Animated fill tracks bind to the primary only, so
            extras stay simple rows. */}
        {fills.slice(1).map((f, i) => (
          <TwirlGroup
            key={`xfill_${i}`}
            prefKey={`contents.fill.${i + 1}`}
            label={t('inspector.fill.nth', 'Fill {n}', { n: i + 2 })}
            defaultOpen={false}
            summary={<><SummaryChip color={chipColor(f)} />{typeLabel(f)}{blendNote(f)}</>}
            trailing={(
              <button
                type="button"
                className={effStyles.remove}
                aria-label={t('inspector.fill.removeNth', 'Remove fill {n}', { n: i + 2 })}
                onClick={() => { void setFillsEdit('Remove Fill', nodeId, fills.filter((_, fi) => fi !== i + 1)); }}
              >
                <Icon name="close" size="sm" />
              </button>
            )}
          >
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>{t('inspector.fill.type', 'Type')}</span>
            <select
              className={styles.select}
              style={{ width: 74 }}
              value={f.type}
              onChange={(e) => {
                const next = [...fills];
                next[i + 1] = convertFill(f, e.target.value as FillType);
                void setFillsEdit(`Fill ${i + 2} Type`, nodeId, next);
              }}
              aria-label={t('inspector.fill.nthTypeAria', 'Fill {n} type', { n: i + 2 })}
            >
              <option value="solid">{t('inspector.fill.solid', 'Solid')}</option>
              <option value="linear">{t('inspector.fill.linear', 'Linear')}</option>
              <option value="radial">{t('inspector.fill.radial', 'Radial')}</option>
            </select>
            <ColorPicker
              compact
              value={chipColor(f)}
              onChange={(hex) => {
                const next = [...fills];
                next[i + 1] =
                  f.type === 'solid'
                    ? solidFill(hex)
                    : { ...f, stops: f.stops.map((s, si) => (si === 0 ? { ...s, color: hex } : s)) };
                void setFillsEdit(`Fill ${i + 2} Color`, nodeId, next);
              }}
              aria-label={t('inspector.fill.nthColorAria', 'Fill {n} color', { n: i + 2 })}
            />
          </div>
          <PaintOpRows
            label={t('inspector.fill.nth', 'Fill {n}', { n: i + 2 })}
            value={f as PaintOpOptions}
            onChange={(opts) => {
              const next = [...fills];
              next[i + 1] = withPaintOp(f, opts);
              void setFillsEdit(`Fill ${i + 2} Compositing`, nodeId, next);
            }}
          />
          </TwirlGroup>
        ))}
        {fill && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ gap: 5 }}
            onClick={() => { void setFillsEdit('Add Fill', nodeId, [...fills, solidFill('#ffffff')]); }}
          >
            <Icon name="plus" size="sm" />
            <span>{t('inspector.fill.add', 'Add fill')}</span>
          </button>
        )}
    </>
  );
}

export default FillRows;
