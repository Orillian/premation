/**
 * Physics controls — per-layer body settings, plus the shared world.
 *
 * Rendered authentically as an AE Effect Card inside Effect Controls.
 */

import { useState } from 'react';
import { t } from '@core/i18n';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { Icon } from '@components/Icon';
import { usePhysicsStore } from '@stores/physicsStore';
import { DEFAULT_PHYSICS_BODY } from '@core/simulation/physicsBodies';
import { useMirrorLayer } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { edit } from '@core/engine/uiEdits';
import { useEngineEdit } from './useEngineEdit';
import { jsonFieldCommands } from './layerFieldEdits';
import type { BodyKind, ColliderShape, PhysicsBodyConfig } from '@core/simulation/rigidBody';
import { runPhysicsBake } from './bakeEdits';
import { BakeDialog } from './BakeDialog';
import panel from '@layout/Effects/EffectsPanel.module.css';
import tStyles from './TransformSection.module.css';

const PHYSICS_PATH = 'layer/physics';
const EDIT_LABEL = 'Edit Physics';

export function PhysicsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const eng = useEngineEdit();
  // B4: the layer header and its `layer/physics` json field from the document mirror.
  const layer = useMirrorLayer(nodeId);
  const stored = useMirrorJson<Partial<PhysicsBodyConfig>>(nodeId, PHYSICS_PATH);
  const w = usePhysicsStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [worldCollapsed, setWorldCollapsed] = useState(false);
  const [bakeOpen, setBakeOpen] = useState(false);

  if (!layer) return null;

  // The stored config including a disabled one, over the defaults (readNodePhysicsRaw's rule).
  const cfg: PhysicsBodyConfig = stored && typeof stored === 'object' ? { ...DEFAULT_PHYSICS_BODY, ...stored } : DEFAULT_PHYSICS_BODY;
  const off = !cfg.enabled;

  // `layer/physics` (json, fx.__physics): the whole next config per write; a
  // scrub is one gesture, a typed value / pick / checkbox one entry.
  const write = (patch: Partial<PhysicsBodyConfig>, label = EDIT_LABEL): void => {
    eng.send(label, jsonFieldCommands(nodeId, PHYSICS_PATH, { ...cfg, ...patch }));
  };

  const removePhysics = (): void => {
    void edit('Remove Physics', jsonFieldCommands(nodeId, PHYSICS_PATH, null));
  };

  // AE's Reset restores the parameters, not the effect switch: `enabled` is kept.
  const resetPhysics = (): void => {
    void edit('Reset Physics', jsonFieldCommands(nodeId, PHYSICS_PATH, { ...DEFAULT_PHYSICS_BODY, enabled: cfg.enabled }));
  };
  const scrub = eng.scrub(EDIT_LABEL);

  return (
    <div className={panel.effectCardItem}>
      {/* AE Effect Controls header: ▾ fx Physics (Rigid Body) .......... Reset */}
      <div className={panel.effectCardHead}>
        <span className={panel.dragGrip} aria-hidden title={t('inspector.physics.dragToReorder', 'Drag to reorder')}>
          <Icon name="grip-vertical" size="sm" />
        </span>
        <button
          type="button"
          className={panel.disclosureBtn}
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? t('inspector.physics.expandEffectParameters', 'Expand effect parameters') : t('inspector.physics.collapseEffectParameters', 'Collapse effect parameters')}
        >
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
        </button>

        <Checkbox
          checked={!off}
          onChange={(ev) => write({ enabled: ev.target.checked }, ev.target.checked ? 'Enable Physics' : 'Disable Physics')}
          title={off ? t('inspector.physics.enablePhysics', 'Enable physics') : t('inspector.physics.disablePhysics', 'Disable physics')}
          style={{ width: 15, height: 15, flexShrink: 0 }}
        />

        <span className={panel.fxMark} aria-hidden>fx</span>

        <span
          className={off ? panel.itemLabelOff : panel.itemLabel}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {t('inspector.physics.title', 'Physics (Rigid Body)')}
        </span>

        <div className={panel.itemActions}>
          <button
            type="button"
            className={panel.remove}
            aria-label={t('inspector.physics.removePhysics', 'Remove Physics')}
            title={t('inspector.physics.removePhysicsEffect', 'Remove Physics effect')}
            onClick={removePhysics}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>

        <button
          type="button"
          className={panel.resetLink}
          title={t('inspector.physics.restorePhysicsParametersToDefault', 'Restore physics parameters to default')}
          onClick={resetPhysics}
        >
          {t('inspector.physics.reset', 'Reset')}
        </button>
      </div>

      {/* Parameters Accordion Body */}
      {!isCollapsed && !off && (
        <div className={panel.effectParamsBody}>
          <PropertyRow label={t('inspector.physics.bodyType', 'Body Type')} compact>
            <select
              className={panel.paramSelect}
              value={cfg.kind}
              onChange={(e) => write({ kind: e.target.value as BodyKind })}
              aria-label={t('inspector.physics.bodyTypeAria', 'Body type')}
            >
              <option value="dynamic">{t('inspector.physics.dynamic', 'Dynamic')}</option>
              <option value="static">{t('inspector.physics.static', 'Static')}</option>
            </select>
          </PropertyRow>

          <PropertyRow label={t('inspector.physics.collider', 'Collider')} compact>
            <select
              className={panel.paramSelect}
              value={cfg.shape}
              onChange={(e) => write({ shape: e.target.value as ColliderShape })}
              aria-label={t('inspector.physics.colliderShape', 'Collider shape')}
            >
              <option value="box">{t('inspector.physics.box', 'Box')}</option>
              <option value="circle">{t('inspector.physics.circle', 'Circle')}</option>
            </select>
          </PropertyRow>

          {cfg.kind === 'dynamic' && (
            <>
              <PropertyRow label={t('inspector.physics.allowSpin', 'Allow Spin')} compact>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <Checkbox
                    checked={cfg.rotate}
                    onChange={(e) => write({ rotate: e.target.checked })}
                    aria-label={t('inspector.physics.allowRotation', 'Allow rotation')}
                  />
                  <span className={tStyles.helpLine}>
                    {cfg.rotate ? t('inspector.physics.tumblesRolls', 'Tumbles & rolls') : t('inspector.physics.translatesOnly', 'Translates only')}
                  </span>
                </div>
              </PropertyRow>
              <PropertyRow label={t('inspector.physics.mass', 'Mass')} compact>
                <ValueField value={cfg.mass} min={0.01} precision={2} {...scrub} onChange={(v) => write({ mass: v })} aria-label={t('inspector.physics.mass', 'Mass')} />
              </PropertyRow>
              <PropertyRow label={t('inspector.physics.bounce', 'Bounce')} compact>
                <ValueField value={cfg.restitution} min={0} max={1} precision={2} {...scrub} onChange={(v) => write({ restitution: v })} aria-label={t('inspector.physics.restitution', 'Restitution')} />
              </PropertyRow>
              <PropertyRow label={t('inspector.physics.friction', 'Friction')} compact>
                <ValueField value={cfg.friction} min={0} max={1} precision={2} {...scrub} onChange={(v) => write({ friction: v })} aria-label={t('inspector.physics.friction', 'Friction')} />
              </PropertyRow>
              <PropertyRow label={t('inspector.physics.damping', 'Damping')} compact>
                <ValueField value={cfg.damping} min={0} max={1} precision={3} {...scrub} onChange={(v) => write({ damping: v })} aria-label={t('inspector.physics.damping', 'Damping')} />
              </PropertyRow>
            </>
          )}

          {/* Bake — the escape hatch out of live solve, for DYNAMIC bodies only:
              a static body's pose is its own transform and the solver never
              overrides it, so there is nothing of it to write down. */}
          {cfg.kind === 'dynamic' && (
            <PropertyRow label={t('inspector.physics.bake', 'Bake')} compact>
              <button
                type="button"
                className={panel.paramSelect}
                style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setBakeOpen(true)}
                title={t('inspector.physics.bakeTitle', 'Convert this simulation into editable keyframes and switch physics off')}
              >
                {t('inspector.physics.bakeToKeyframes', 'Bake to keyframes…')}
              </button>
            </PropertyRow>
          )}

          {/* Simulation World (shared across composition) */}
          <div className={panel.paramGroup}>
            <button
              type="button"
              className={panel.paramGroupHead}
              onClick={() => setWorldCollapsed(!worldCollapsed)}
            >
              <Icon name={worldCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              <span>{t('inspector.physics.world', 'World (Simulation Scope)')}</span>
            </button>
            {!worldCollapsed && (
              <div className={panel.paramGroupBody}>
                <PropertyRow label={t('inspector.physics.gravityX', 'Gravity X')} compact>
                  <ValueField value={w.gravityX} precision={0} onChange={(v) => w.set({ gravityX: v })} aria-label={t('inspector.physics.gravityX', 'Gravity X')} />
                </PropertyRow>
                <PropertyRow label={t('inspector.physics.gravityY', 'Gravity Y')} compact>
                  <ValueField value={w.gravityY} precision={0} onChange={(v) => w.set({ gravityY: v })} aria-label={t('inspector.physics.gravityY', 'Gravity Y')} />
                </PropertyRow>
                <PropertyRow label={t('inspector.physics.compBounds', 'Comp Bounds')} compact>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                    <Checkbox
                      checked={w.useCompBounds}
                      onChange={(e) => w.set({ useCompBounds: e.target.checked })}
                      aria-label={t('inspector.physics.useCompositionBounds', 'Use composition bounds')}
                    />
                    <span className={tStyles.helpLine}>
                      {w.useCompBounds ? t('inspector.physics.compEdges', 'Comp edges') : t('inspector.physics.openLeavesFrame', 'Open (leaves frame)')}
                    </span>
                  </div>
                </PropertyRow>
                <PropertyRow label={t('inspector.physics.solverSteps', 'Solver Steps')} compact>
                  <ValueField value={w.iterations} min={1} max={20} precision={0} onChange={(v) => w.set({ iterations: v })} aria-label={t('inspector.physics.solverIterations', 'Solver iterations')} />
                </PropertyRow>
              </div>
            )}
          </div>
        </div>
      )}

      {bakeOpen && (
        <BakeDialog
          open
          onClose={() => setBakeOpen(false)}
          title={t('inspector.physics.bakeDialogTitle', 'Bake Physics to Keyframes')}
          onBake={(opts) => { void runPhysicsBake([nodeId], opts); }}
        />
      )}
    </div>
  );
}

export default PhysicsSection;

