/**
 * ThreeDControl — the layer's "3D Layer" switch and its Geometry Options. It
 * is the body of the inspector's Geometry Options section (AE's group of that
 * name), so it draws no heading of its own.
 *
 * Turning it on adds depth props (Z, X-rotation, Y-rotation) to the layer, so
 * the NodeInspector below renders keyframeable rows for them and the renderer
 * projects the layer through the composition camera (perspective scale +
 * parallax + tilt). Turning it off removes them and the layer is flat 2D again.
 *
 * GEOMETRY ONLY. Material Options, the per-face colour overrides and the
 * material library all moved to `MaterialSection`, which the inspector mounts
 * as its own section directly after this one. They were nested two levels deep
 * inside this panel's 3D sub-panel, under a "Geometry Options" heading they had
 * nothing to do with — so "what this layer is shaped like" and "what it is made
 * of" were one scroll of one collapsed group, and the material presets were in
 * a third panel entirely.
 *
 * Geometry Options follows AE's group: Bevel Style, Bevel Depth, Hole Bevel
 * Depth (text and paths — the only outlines with counters) and Extrusion
 * Depth. The three depths are keyframeable exactly as the renderer reads them
 * (`a.get('extrusionDepth' | 'bevelDepth' | 'holeBevelDepth')`), so each row
 * carries a stopwatch and writes a keyframe at the playhead once animated —
 * a static write under a live track would be invisible.
 */

import { type ReactNode } from 'react';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useThrottledTime } from '@stores/playbackClockStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, useMirrorLayer, useMirrorTrackWatch } from '@hooks/useMirror';
import { isTrackAnimated, readTrack } from '@core/mirror/selection';
import { plainValue, trackRefIn } from '@core/mirror/trackIndex';
import { edit } from '@core/engine/uiEdits';
import { fieldCommands } from '@layout/Text/textEdits';
import { BEVEL_STYLES } from '@core/scene/threeD';
import type { BevelStyle } from '@core/scene/extrusion';
import { compHasKind } from '@core/mirror/deviceNames';
import { useUIStore } from '@stores/uiStore';
import { AnimToggle } from './AnimToggle';
import { allAddressable, scalarValueCommands, setLayersSwitch, stopwatchCommands } from './inspectorEdits';
import { useEngineEdit } from './useEngineEdit';
import { canBe3DLayer, inspectorKindOf } from './inspectorMirror';
import { t } from '@core/i18n';
import s from './ThreeDControl.module.css';

function cameraTip(): string {
  return t('inspector.threeD.cameraTip', 'Tip: add a Camera (+ camera button in the viewport bar) to move in 3D');
}

/** Menu labels for the bevel profiles — the union stays the source of truth. */
function bevelStyleLabels(): Record<BevelStyle, string> {
  return {
    angular: t('inspector.threeD.bevel.angular', 'Angular'),
    concave: t('inspector.threeD.bevel.concave', 'Concave'),
    convex: t('inspector.threeD.bevel.convex', 'Convex'),
  };
}

/** The depth rows' names in undo labels — English always. */
const DEPTH_UNDO_NAME: Readonly<Record<DepthRowProps['prop'], string>> = {
  extrusionDepth: 'Extrusion Depth',
  bevelDepth: 'Bevel Depth',
  holeBevelDepth: 'Hole Bevel Depth',
};

interface DepthRowProps {
  nodeId: string;
  prop: 'extrusionDepth' | 'bevelDepth' | 'holeBevelDepth';
  label: string;
  ariaLabel: string;
  /** The value at the playhead (mirror). */
  value: number;
  /** Whether the property is keyframed (mirror). */
  animated: boolean;
  min: number;
  max: number;
  unit: string;
  /** Playhead, comp seconds (every write). */
  time: number;
  autoKeyframe: boolean;
}

/**
 * One keyframeable geometry row. The set of rows changes with the layer's
 * state (no bevel ⇒ no hole row); each row is its own component, so its one
 * hook (the scrub gesture) never shifts the section's hook count.
 *
 * B3z: through the engine API (`geometry/<prop>`, listed on every layer that
 * shows the row — a 3D layer that can have a body). A value is a key at the
 * playhead where animated / under auto-keyframe, else the static value; a scrub
 * is ONE gesture; the stopwatch is `setAnimated`.
 */
function DepthRow({ nodeId, prop, label, ariaLabel, value, animated, min, max, unit, time, autoKeyframe }: DepthRowProps): JSX.Element {
  const e = useEngineEdit();
  // History labels stay English: the row's display label may be translated.
  const undoName = DEPTH_UNDO_NAME[prop];
  const onEngine = (): boolean => allAddressable([nodeId], [prop]);
  const write = (v: number): void => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(min, Math.min(max, v));
    e.send(`Set ${undoName}`, scalarValueCommands(prop, [{ nodeId, value: clamped }], { seconds: time, autoKeyframe }));
  };
  return (
    <div className={s.row}>
      <AnimToggle
        nodeId={nodeId}
        tracks={[prop]}
        label={label}
        animated={animated}
        values={() => [value]}
        onToggle={() => {
          if (onEngine()) e.send(animated
            ? `Remove ${undoName} animation`
            : `Animate ${undoName}`, stopwatchCommands([nodeId], [prop], time));
        }}
      />
      <span className={`${s.label}${animated ? ` ${s.labelAnimated}` : ''}`}>{label}</span>
      <ValueField
        value={Math.round(value * 10) / 10}
        min={min}
        max={max}
        step={1}
        unit={unit}
        onChange={write}
        {...e.scrub(`Set ${undoName}`, onEngine)}
        aria-label={ariaLabel}
      />
    </div>
  );
}

/** The geometry properties this control draws (mirror watch). */
const GEOMETRY_TRACKS: readonly string[] = ['extrusionDepth', 'bevelDepth', 'holeBevelDepth', 'bevelStyle', 'perChar3D'];

export interface ThreeDControlProps {
  nodeId: string;
  children?: ReactNode;
}

export function ThreeDControl({ nodeId, children }: ThreeDControlProps): JSX.Element | null {
  // Every hook before the early returns (conditionalHooks.test.tsx).
  // B4: the layer's mirror header (the 3D switch) and the geometry properties
  // it draws (keys, values, infos), at the THROTTLED playhead, never the clock.
  const layer = useMirrorLayer(nodeId);
  useMirrorTrackWatch([nodeId], GEOMETRY_TRACKS);
  const time = useThrottledTime();
  const autoKeyframe = usePreferenceStore((st) => st.timelineAutoKeyframe);

  if (!layer) return null;
  // Only kinds the renderer can actually project in 3D get the switch —
  // groups / nulls / cameras / lights / solids / particles etc. are excluded
  // (the mirror twin of the shared canBe3D predicate).
  if (!canBe3DLayer(nodeId)) return null;

  const m = documentMirror();
  const tree = m.tree(nodeId);
  const on = layer.switches.threeD;
  const depth = (prop: string): number => Math.max(0, readTrack(m, nodeId, prop, time) ?? 0);
  const animatedNow = (prop: string): boolean => isTrackAnimated(m, nodeId, prop);
  // Per-character 3D is a text-only affordance (AE parity).
  const isTextLayer = inspectorKindOf(nodeId) === 'text';
  // Counters exist only on traced outlines: text and free paths (the catalog
  // lists Hole Bevel Depth exactly there).
  const hasHoles = isTextLayer || layer.kind === 'path' || layer.kind === 'polygon'
    || trackRefIn(tree, 'holeBevelDepth') !== null;
  // Animated depths decide visibility by the value drawn NOW, like the renderer.
  const extrusionNow = depth('extrusionDepth');
  const bevelNow = depth('bevelDepth');
  const holeNow = readTrack(m, nodeId, 'holeBevelDepth', time) ?? 100;
  const extrudedAtAll = extrusionNow > 0 || animatedNow('extrusionDepth');
  const bevelledAtAll = bevelNow > 0 || animatedNow('bevelDepth');
  const bevelStyleRaw = plainValue(trackRefIn(tree, 'bevelStyle')?.info.value);
  const bevelStyle: BevelStyle = BEVEL_STYLES.includes(bevelStyleRaw as BevelStyle) ? (bevelStyleRaw as BevelStyle) : 'angular';
  const perChar3D = plainValue(trackRefIn(tree, 'perChar3D')?.info.value) === true;
  // Layer styles live under the tree's `styles` group.
  const hasStyles = tree !== undefined && [...tree.nodes.keys()].some((p) => p === 'styles' || p.startsWith('styles/'));
  const styled = hasHoles && extrudedAtAll && hasStyles;

  return (
    <div className={s.stack}>
      <div className={s.switchRow}>
        <span className={s.switchLabel}>{t('inspector.threeD.layer', '3D Layer')}</span>
        <Switch
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            void setLayersSwitch([nodeId], { threeD: next }, next ? 'Enable 3D Layer' : 'Disable 3D Layer');
            // Without a camera, 3D depth does not move — surface the one-step fix
            // (cameraNav's `notifyCameraTipIfMissing`, asked of the mirror).
            if (next && !compHasKind(documentMirror(), activeCompIdNow(), 'camera')) {
              useUIStore.getState().notify({ level: 'info', message: cameraTip(), durationMs: 3200 });
            }
          }}
          aria-label={t('inspector.threeD.layerLabel', '3D layer')}
        />
      </div>

      {on && (
        <div className={s.items}>
          {children}
          {isTextLayer && (
            <div className={s.row}>
              <span className={s.label}>{t('inspector.threeD.perChar', 'Per-character 3D')}</span>
              <Switch
                checked={perChar3D}
                // `text/perCharacter3D` (a layer field).
                onChange={(e) => {
                  const next = e.currentTarget.checked;
                  void edit(next ? 'Enable Per-character 3D' : 'Disable Per-character 3D', fieldCommands(nodeId, 'text/perCharacter3D', next));
                }}
                aria-label={t('inspector.threeD.perCharLabel', 'Enable per-character 3D')}
              />
            </div>
          )}

          {/* Bevel PROFILE. Only meaningful once there is a chamfer to shape,
              so it rides with Bevel Depth rather than standing alone above a
              depth of 0 where every option would look identical. */}
          {extrudedAtAll && bevelledAtAll && (
            <div className={s.row}>
              <span className={s.label}>{t('inspector.threeD.bevelStyle', 'Bevel Style')}</span>
              <select
                className={s.select}
                value={bevelStyle}
                // `geometry/bevelStyle` (a layer field).
                onChange={(e) => { void edit('Bevel Style', fieldCommands(nodeId, 'geometry/bevelStyle', e.currentTarget.value as BevelStyle)); }}
                aria-label={t('inspector.threeD.bevelStyleLabel', 'Bevel style')}
              >
                {BEVEL_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {bevelStyleLabels()[style]}
                  </option>
                ))}
              </select>
            </div>
          )}
          {extrudedAtAll && (
            <DepthRow
              nodeId={nodeId}
              prop="bevelDepth"
              label={t('inspector.threeD.bevelDepth', 'Bevel Depth')}
              ariaLabel={t('inspector.threeD.bevelDepthLabel', 'Bevel depth')}
              value={bevelNow}
              animated={animatedNow('bevelDepth')}
              min={0}
              max={200}
              unit="px"
              time={time}
              autoKeyframe={autoKeyframe}
            />
          )}
          {extrudedAtAll && bevelledAtAll && hasHoles && (
            <DepthRow
              nodeId={nodeId}
              prop="holeBevelDepth"
              label={t('inspector.threeD.holeBevelDepth', 'Hole Bevel Depth')}
              ariaLabel={t('inspector.threeD.holeBevelDepthLabel', 'Hole bevel depth')}
              value={holeNow}
              animated={animatedNow('holeBevelDepth')}
              min={0}
              max={100}
              unit="%"
              time={time}
              autoKeyframe={autoKeyframe}
            />
          )}
          <DepthRow
            nodeId={nodeId}
            prop="extrusionDepth"
            label={t('inspector.threeD.extrusionDepth', 'Extrusion Depth')}
            ariaLabel={t('inspector.threeD.extrusionDepthLabel', 'Extrusion depth')}
            value={extrusionNow}
            animated={animatedNow('extrusionDepth')}
            min={0}
            max={1000}
            unit="px"
            time={time}
            autoKeyframe={autoKeyframe}
          />
          {styled && (
            <p className={s.hint}>
              {t('inspector.threeD.stylesHint', 'Layer styles draw on the front face; the sides and bevels take the fill and material colours.')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default ThreeDControl;
