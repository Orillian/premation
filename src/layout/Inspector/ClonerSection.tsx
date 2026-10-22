/**
 * Cloner controls.
 *
 * Rendered authentically as an AE Effect Card inside Effect Controls.
 */

import { t } from '@core/i18n';
import { useState } from 'react';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { Icon } from '@components/Icon';
import { useMirrorLayer } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { useMirrorSiblings } from '@hooks/useMirrorSiblings';
import { edit } from '@core/engine/uiEdits';
import { useEngineEdit } from './useEngineEdit';
import { jsonFieldCommands } from './layerFieldEdits';
import {
  cloneCount,
  MAX_CLONES,
  DEFAULT_CLONER,
  type ClonerConfig,
  type ClonerMode,
  type FalloffShape,
  type FalloffSource,
} from '@core/scene/cloner';
import panel from '@layout/Effects/EffectsPanel.module.css';
import tStyles from './TransformSection.module.css';

function modes(): ReadonlyArray<{ value: ClonerMode; label: string }> {
  return [
    { value: 'linear', label: t('inspector.cloner.modeLinear', 'Linear') },
    { value: 'grid', label: t('inspector.cloner.modeGrid', 'Grid') },
    { value: 'radial', label: t('inspector.cloner.modeRadial', 'Radial') },
    { value: 'path', label: t('inspector.cloner.modePath', 'Path') },
  ];
}

function falloffs(): ReadonlyArray<{ value: FalloffShape; label: string }> {
  return [
    { value: 'none', label: t('inspector.cloner.falloffNone', 'None') },
    { value: 'linear', label: t('inspector.cloner.modeLinear', 'Linear') },
    { value: 'radial', label: t('inspector.cloner.modeRadial', 'Radial') },
  ];
}

const CLONER_PATH = 'layer/cloner';
const EDIT_LABEL = 'Edit Cloner';

/**
 * The stored config including a disabled one, over the defaults — nested
 * objects merge too, or a config saved before a field existed would arrive
 * with `step`/`random`/`falloff` partially undefined (clonerExpand's
 * `readNodeClonerRaw` rule, applied to the mirror's json value).
 */
function clonerConfigOf(raw: Partial<ClonerConfig> | undefined): ClonerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CLONER };
  const cfg = { ...DEFAULT_CLONER, ...raw };
  cfg.step = { ...DEFAULT_CLONER.step, ...(cfg.step ?? {}) };
  cfg.random = { ...DEFAULT_CLONER.random, ...(cfg.random ?? {}) };
  cfg.falloff = { ...DEFAULT_CLONER.falloff, ...(cfg.falloff ?? {}) };
  return cfg;
}

export function ClonerSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const eng = useEngineEdit();
  // B4: the layer header, its `layer/cloner` json field and its siblings (the
  // path / field layer pickers) from the document mirror.
  const layer = useMirrorLayer(nodeId);
  const cfg = clonerConfigOf(useMirrorJson<Partial<ClonerConfig>>(nodeId, CLONER_PATH));
  const siblings = useMirrorSiblings(nodeId);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [stepCollapsed, setStepCollapsed] = useState(false);
  const [randomCollapsed, setRandomCollapsed] = useState(false);
  const [falloffCollapsed, setFalloffCollapsed] = useState(false);

  if (!layer) return null;

  const off = !cfg.enabled;

  // `layer/cloner` (json, fx.__cloner): the whole next config per write; a
  // scrub is one gesture, a typed value / pick / checkbox one entry.
  const write = (patch: Partial<ClonerConfig>, label = EDIT_LABEL): void => {
    eng.send(label, jsonFieldCommands(nodeId, CLONER_PATH, { ...cfg, ...patch }));
  };

  const removeCloner = (): void => {
    void edit('Remove Cloner', jsonFieldCommands(nodeId, CLONER_PATH, null));
  };

  // AE's Reset restores the parameters, not the effect switch: `enabled` is kept.
  const resetCloner = (): void => {
    void edit('Reset Cloner', jsonFieldCommands(nodeId, CLONER_PATH, { ...DEFAULT_CLONER, enabled: cfg.enabled }));
  };
  const scrub = eng.scrub(EDIT_LABEL);

  const count = cloneCount({ ...cfg, enabled: true });
  const capped = count >= MAX_CLONES;

  return (
    <div className={panel.effectCardItem}>
      {/* AE Effect Controls header: ▾ fx Cloner .......... Reset */}
      <div className={panel.effectCardHead}>
        <span className={panel.dragGrip} aria-hidden title={t('inspector.cloner.dragToReorder', 'Drag to reorder')}>
          <Icon name="grip-vertical" size="sm" />
        </span>
        <button
          type="button"
          className={panel.disclosureBtn}
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? t('inspector.cloner.expand', 'Expand effect parameters') : t('inspector.cloner.collapse', 'Collapse effect parameters')}
        >
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
        </button>

        <Checkbox
          checked={!off}
          onChange={(ev) => write({ enabled: ev.target.checked }, ev.target.checked ? 'Enable Cloner' : 'Disable Cloner')}
          title={off ? t('inspector.cloner.enable', 'Enable cloner') : t('inspector.cloner.disable', 'Disable cloner')}
          style={{ width: 15, height: 15, flexShrink: 0 }}
        />

        <span className={panel.fxMark} aria-hidden>fx</span>

        <span
          className={off ? panel.itemLabelOff : panel.itemLabel}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {capped
            ? t('inspector.cloner.titleMax', 'Cloner ({n} clones max)', { n: count })
            : count === 1
              ? t('inspector.cloner.titleOne', 'Cloner ({n} clone)', { n: count })
              : t('inspector.cloner.titleOther', 'Cloner ({n} clones)', { n: count })}
        </span>

        <div className={panel.itemActions}>
          <button
            type="button"
            className={panel.remove}
            aria-label={t('inspector.cloner.removeCloner', 'Remove Cloner')}
            title={t('inspector.cloner.removeClonerEffect', 'Remove Cloner effect')}
            onClick={removeCloner}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>

        <button
          type="button"
          className={panel.resetLink}
          title={t('inspector.cloner.restoreClonerParametersToDefault', 'Restore cloner parameters to default')}
          onClick={resetCloner}
        >
          {t('inspector.cloner.reset', 'Reset')}
        </button>
      </div>

      {/* Parameters Accordion Body */}
      {!isCollapsed && !off && (
        <div className={panel.effectParamsBody}>
          <PropertyRow label={t('inspector.cloner.mode', 'Mode')} compact>
            <select
              className={panel.paramSelect}
              value={cfg.mode}
              onChange={(e) => write({ mode: e.target.value as ClonerMode })}
              aria-label={t('inspector.cloner.clonerMode', 'Cloner mode')}
            >
              {modes().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </PropertyRow>

          {cfg.mode === 'grid' ? (
            <>
              <PropertyRow label={t('inspector.cloner.columns', 'Columns')} compact><ValueField value={cfg.countX} min={0} precision={0} {...scrub} onChange={(v) => write({ countX: v })} aria-label={t('inspector.cloner.columns', 'Columns')} /></PropertyRow>
              <PropertyRow label={t('inspector.cloner.rows', 'Rows')} compact><ValueField value={cfg.countY} min={0} precision={0} {...scrub} onChange={(v) => write({ countY: v })} aria-label={t('inspector.cloner.rows', 'Rows')} /></PropertyRow>
              <PropertyRow label={t('inspector.cloner.cellX', 'Cell X')} compact><ValueField value={cfg.offsetX} precision={1} {...scrub} onChange={(v) => write({ offsetX: v })} aria-label={t('inspector.cloner.cellWidth', 'Cell width')} /></PropertyRow>
              <PropertyRow label={t('inspector.cloner.cellY', 'Cell Y')} compact><ValueField value={cfg.offsetY} precision={1} {...scrub} onChange={(v) => write({ offsetY: v })} aria-label={t('inspector.cloner.cellHeight', 'Cell height')} /></PropertyRow>
            </>
          ) : (
            <PropertyRow label={t('inspector.cloner.count', 'Count')} compact><ValueField value={cfg.count} min={0} precision={0} {...scrub} onChange={(v) => write({ count: v })} aria-label={t('inspector.cloner.cloneCount', 'Clone count')} /></PropertyRow>
          )}

          {cfg.mode === 'linear' && (
            <>
              <PropertyRow label={t('inspector.cloner.offsetX', 'Offset X')} compact><ValueField value={cfg.offsetX} precision={1} {...scrub} onChange={(v) => write({ offsetX: v })} aria-label={t('inspector.cloner.offsetX', 'Offset X')} /></PropertyRow>
              <PropertyRow label={t('inspector.cloner.offsetY', 'Offset Y')} compact><ValueField value={cfg.offsetY} precision={1} {...scrub} onChange={(v) => write({ offsetY: v })} aria-label={t('inspector.cloner.offsetY', 'Offset Y')} /></PropertyRow>
            </>
          )}

          {cfg.mode === 'path' && (
            <>
              <PropertyRow label={t('inspector.cloner.path', 'Path')} compact>
                <select
                  className={panel.paramSelect}
                  value={cfg.pathLayerId}
                  onChange={(e) => write({ pathLayerId: e.target.value })}
                  aria-label={t('inspector.cloner.pathLayer', 'Path layer')}
                >
                  <option value="">{t('inspector.cloner.noneOption', '— none —')}</option>
                  {siblings.map((sib) => <option key={sib.id} value={sib.id}>{sib.name ?? sib.id}</option>)}
                </select>
              </PropertyRow>
              <PropertyRow label={t('inspector.cloner.follow', 'Follow')} compact>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <Checkbox checked={cfg.alignToRadius} onChange={(e) => write({ alignToRadius: e.target.checked })} aria-label={t('inspector.cloner.followPathTangent', 'Follow path tangent')} />
                  <span className={tStyles.helpLine}>
                    {cfg.alignToRadius ? t('inspector.cloner.facesPath', 'Faces path') : t('inspector.cloner.keepRotation', 'Keep rotation')}
                  </span>
                </div>
              </PropertyRow>
            </>
          )}

          {cfg.mode === 'radial' && (
            <>
              <PropertyRow label={t('inspector.cloner.radius', 'Radius')} compact><ValueField value={cfg.radius} precision={1} {...scrub} onChange={(v) => write({ radius: v })} aria-label={t('inspector.cloner.radius', 'Radius')} /></PropertyRow>
              <PropertyRow label={t('inspector.cloner.start', 'Start')} compact><ValueField value={cfg.startAngle} unit="°" precision={1} {...scrub} onChange={(v) => write({ startAngle: v })} aria-label={t('inspector.cloner.startAngle', 'Start angle')} /></PropertyRow>
              <PropertyRow label={t('inspector.cloner.arc', 'Arc')} compact><ValueField value={cfg.arc} unit="°" precision={1} {...scrub} onChange={(v) => write({ arc: v })} aria-label={t('inspector.cloner.arc', 'Arc')} /></PropertyRow>
              <PropertyRow label={t('inspector.cloner.faceOut', 'Face Out')} compact>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <Checkbox checked={cfg.alignToRadius} onChange={(e) => write({ alignToRadius: e.target.checked })} aria-label={t('inspector.cloner.alignToRadius', 'Align to radius')} />
                </div>
              </PropertyRow>
            </>
          )}

          {/* Step Ramp */}
          <div className={panel.paramGroup}>
            <button
              type="button"
              className={panel.paramGroupHead}
              onClick={() => setStepCollapsed(!stepCollapsed)}
            >
              <Icon name={stepCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              <span>{t('inspector.cloner.stepGroup', 'Step (Transform Ramp)')}</span>
            </button>
            {!stepCollapsed && (
              <div className={panel.paramGroupBody}>
                <PropertyRow label={t('inspector.cloner.positionX', 'Position X')} compact><ValueField value={cfg.step.x} precision={1} {...scrub} onChange={(v) => write({ step: { ...cfg.step, x: v } })} aria-label={t('inspector.cloner.stepPositionX', 'Step position X')} /></PropertyRow>
                <PropertyRow label={t('inspector.cloner.positionY', 'Position Y')} compact><ValueField value={cfg.step.y} precision={1} {...scrub} onChange={(v) => write({ step: { ...cfg.step, y: v } })} aria-label={t('inspector.cloner.stepPositionY', 'Step position Y')} /></PropertyRow>
                <PropertyRow label={t('inspector.cloner.rotation', 'Rotation')} compact><ValueField value={cfg.step.rotation} unit="°" precision={1} {...scrub} onChange={(v) => write({ step: { ...cfg.step, rotation: v } })} aria-label={t('inspector.cloner.stepRotation', 'Step rotation')} /></PropertyRow>
                <PropertyRow label={t('inspector.cloner.scale', 'Scale')} compact><ValueField value={cfg.step.scale} precision={2} {...scrub} onChange={(v) => write({ step: { ...cfg.step, scale: v } })} aria-label={t('inspector.cloner.stepScale', 'Step scale')} /></PropertyRow>
                <PropertyRow label={t('inspector.cloner.opacity', 'Opacity')} compact><ValueField value={cfg.step.opacity} unit="%" precision={0} {...scrub} onChange={(v) => write({ step: { ...cfg.step, opacity: v } })} aria-label={t('inspector.cloner.stepOpacity', 'Step opacity')} /></PropertyRow>
                <PropertyRow label={t('inspector.cloner.timeCascade', 'Time (Cascade)')} compact><ValueField value={cfg.step.time} unit="s" precision={2} {...scrub} onChange={(v) => write({ step: { ...cfg.step, time: v } })} aria-label={t('inspector.cloner.stepTimeCascade', 'Step time (cascade)')} /></PropertyRow>
              </div>
            )}
          </div>

          {/* Random Scatter */}
          <div className={panel.paramGroup}>
            <button
              type="button"
              className={panel.paramGroupHead}
              onClick={() => setRandomCollapsed(!randomCollapsed)}
            >
              <Icon name={randomCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              <span>{t('inspector.cloner.randomGroup', 'Random Scatter')}</span>
            </button>
            {!randomCollapsed && (
              <div className={panel.paramGroupBody}>
                <PropertyRow label={t('inspector.cloner.seed', 'Seed')} compact><ValueField value={cfg.random.seed} precision={0} {...scrub} onChange={(v) => write({ random: { ...cfg.random, seed: v } })} aria-label={t('inspector.cloner.randomSeed', 'Random seed')} /></PropertyRow>
                <PropertyRow label={t('inspector.cloner.position', 'Position')} compact><ValueField value={cfg.random.position} min={0} precision={1} {...scrub} onChange={(v) => write({ random: { ...cfg.random, position: v } })} aria-label={t('inspector.cloner.randomPosition', 'Random position')} /></PropertyRow>
                <PropertyRow label={t('inspector.cloner.rotation', 'Rotation')} compact><ValueField value={cfg.random.rotation} min={0} unit="°" precision={1} {...scrub} onChange={(v) => write({ random: { ...cfg.random, rotation: v } })} aria-label={t('inspector.cloner.randomRotation', 'Random rotation')} /></PropertyRow>
                <PropertyRow label={t('inspector.cloner.scale', 'Scale')} compact><ValueField value={cfg.random.scale} min={0} precision={2} {...scrub} onChange={(v) => write({ random: { ...cfg.random, scale: v } })} aria-label={t('inspector.cloner.randomScale', 'Random scale')} /></PropertyRow>
              </div>
            )}
          </div>

          {/* Falloff */}
          <div className={panel.paramGroup}>
            <button
              type="button"
              className={panel.paramGroupHead}
              onClick={() => setFalloffCollapsed(!falloffCollapsed)}
            >
              <Icon name={falloffCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              <span>{t('inspector.cloner.falloffGroup', 'Falloff Mask')}</span>
            </button>
            {!falloffCollapsed && (
              <div className={panel.paramGroupBody}>
                <PropertyRow label={t('inspector.cloner.shape', 'Shape')} compact>
                  <select
                    className={panel.paramSelect}
                    value={cfg.falloff.shape}
                    onChange={(e) => write({ falloff: { ...cfg.falloff, shape: e.target.value as FalloffShape } })}
                    aria-label={t('inspector.cloner.falloffShape', 'Falloff shape')}
                  >
                    {falloffs().map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </PropertyRow>
                {cfg.falloff.shape !== 'none' && (
                  <>
                    <PropertyRow label={t('inspector.cloner.drivenBy', 'Driven By')} compact>
                      <select
                        className={panel.paramSelect}
                        value={cfg.falloff.source}
                        onChange={(e) => write({ falloff: { ...cfg.falloff, source: e.target.value as FalloffSource } })}
                        aria-label={t('inspector.cloner.falloffSource', 'Falloff source')}
                      >
                        <option value="order">{t('inspector.cloner.cloneOrder', 'Clone Order')}</option>
                        <option value="layer">{t('inspector.cloner.layer', 'Layer')}</option>
                      </select>
                    </PropertyRow>

                    {cfg.falloff.source === 'layer' ? (
                      <>
                        <PropertyRow label={t('inspector.cloner.layer', 'Layer')} compact>
                          <select
                            className={panel.paramSelect}
                            value={cfg.falloff.layerId}
                            onChange={(e) => write({ falloff: { ...cfg.falloff, layerId: e.target.value } })}
                            aria-label={t('inspector.cloner.fieldLayer', 'Field layer')}
                          >
                            <option value="">{t('inspector.cloner.noneOption', '— none —')}</option>
                            {siblings.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.id}</option>)}
                          </select>
                        </PropertyRow>
                        <PropertyRow label={t('inspector.cloner.radius', 'Radius')} compact><ValueField value={cfg.falloff.radius} min={0} precision={1} {...scrub} onChange={(v) => write({ falloff: { ...cfg.falloff, radius: v } })} aria-label={t('inspector.cloner.fieldRadius', 'Field radius')} /></PropertyRow>
                        <PropertyRow label={t('inspector.cloner.push', 'Push')} compact><ValueField value={cfg.falloff.push} precision={1} {...scrub} onChange={(v) => write({ falloff: { ...cfg.falloff, push: v } })} aria-label={t('inspector.cloner.fieldPush', 'Field push')} /></PropertyRow>
                      </>
                    ) : (
                      <>
                        <PropertyRow label={t('inspector.cloner.center', 'Center')} compact><ValueField value={cfg.falloff.position} min={0} max={1} precision={2} {...scrub} onChange={(v) => write({ falloff: { ...cfg.falloff, position: v } })} aria-label={t('inspector.cloner.falloffCenter', 'Falloff center')} /></PropertyRow>
                        <PropertyRow label={t('inspector.cloner.width', 'Width')} compact><ValueField value={cfg.falloff.width} min={0} max={1} precision={2} {...scrub} onChange={(v) => write({ falloff: { ...cfg.falloff, width: v } })} aria-label={t('inspector.cloner.falloffWidth', 'Falloff width')} /></PropertyRow>
                      </>
                    )}
                    <PropertyRow label={t('inspector.cloner.invert', 'Invert')} compact>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                        <Checkbox checked={cfg.falloff.invert} onChange={(e) => write({ falloff: { ...cfg.falloff, invert: e.target.checked } })} aria-label={t('inspector.cloner.invertFalloff', 'Invert falloff')} />
                      </div>
                    </PropertyRow>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ClonerSection;

