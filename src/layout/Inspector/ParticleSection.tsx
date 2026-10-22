/**
 * ParticleSection — controls for a particle emitter. The whole config is one
 * object on the layer's `fx` component. Through the engine API (B3z):
 *
 *   • every keyframeable number is the property `layer/particle.<key>`
 *     (particleProps.ts) — a typed value / scrub sets its static value, or keys
 *     it at the playhead when animated (auto-keyframe as elsewhere); the
 *     stopwatch is `setAnimated`; a scrub is ONE gesture;
 *   • the colours are `layer/particle.<colour>` colour properties (ColorKfRow);
 *   • every other setting (emitter type, shape, sim mode, trails, sub-emit,
 *     caps, seed…) is the json field `layer/particle`: the whole next config.
 */

import { useMemo, useState } from 'react';
import { t } from '@core/i18n';
import { ValueField } from '@components/ValueField';
import { AnimToggle } from './AnimToggle';
import {
  DEFAULT_PARTICLE_CONFIG,
  PARTICLE_NUMERIC_KEYS,
  particlePropPath,
  type ParticleConfig,
  type ParticleNumericKey,
} from '@core/particles/particleSim';
import { edit } from '@core/engine/uiEdits';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorFootage, useMirrorLayer, useMirrorTrackWatch } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { isTrackAnimated, readTrack } from '@core/mirror/selection';
import { ColorKfRow } from './ColorKfRow';
import { useEngineEdit } from './useEngineEdit';
import { useGesture } from '@hooks/useGesture';
import { jsonFieldCommands } from './layerFieldEdits';
import { stopwatchCommands, valueCommands } from './inspectorEdits';
import { runParticleBake } from './bakeEdits';
import { BakeDialog } from './BakeDialog';
import styles from './TransformSection.module.css';

/** The keyframeable numbers the rows draw (mirror watch: info, keys, value). */
const NUMERIC_TRACKS: readonly string[] = PARTICLE_NUMERIC_KEYS.map(particlePropPath);
const PARTICLE_PATH = 'layer/particle';

export function ParticleSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // B4: the layer header, the `layer/particle` json config and the numeric
  // `layer/particle.<key>` properties, from the document mirror.
  const layer = useMirrorLayer(nodeId);
  const stored = useMirrorJson<Partial<ParticleConfig>>(nodeId, PARTICLE_PATH);
  const watchIds = useMemo(() => [nodeId], [nodeId]);
  useMirrorTrackWatch(watchIds, NUMERIC_TRACKS);
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const eng = useEngineEdit();
  const picking = useGesture();
  const [bakeOpen, setBakeOpen] = useState(false);
  // Image assets for the sprite picker — a hook, so it sits above the early return.
  // B4: the project's still images (`ItemInfo.mediaType`).
  const imageAssets = useMirrorFootage('image');
  if (!layer) return null;
  // The stored config over the defaults (`readNodeParticle`'s rule).
  const cfg: ParticleConfig = stored && typeof stored === 'object' ? { ...DEFAULT_PARTICLE_CONFIG, ...stored } : DEFAULT_PARTICLE_CONFIG;
  const m = documentMirror();

  /**
   * A non-keyframeable setting: the json field `layer/particle` with that key
   * changed (the whole config, as the editor always stored it). Inside a scrub
   * it goes into the open gesture.
   */
  const set = <K extends keyof ParticleConfig>(key: K, value: ParticleConfig[K], label = 'Edit Particle Emitter'): void => {
    eng.send(label, jsonFieldCommands(nodeId, 'layer/particle', { ...cfg, [key]: value }));
  };
  const scrub = eng.scrub('Edit Particle Emitter');

  const Num = (key: ParticleNumericKey, label: string, unit = '', min?: number, max?: number): JSX.Element => {
    const prop = particlePropPath(key);
    const animated = isTrackAnimated(m, nodeId, prop);
    // DISPLAY only: an animated param's value at the playhead (comp time).
    const shown = animated
      ? readTrack(m, nodeId, prop, time) ?? (cfg[key] as number)
      : (cfg[key] as number);
    const toggle = (): void => {
      void edit(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [prop], time));
    };
    // `layer/particle.<key>` (a key at the playhead when animated or under
    // auto-keyframe, else the static value). The emitter box mirrors the
    // layer's Width / Height: a static emitter size writes both in ONE entry.
    const write = (v: number): void => {
      const values: Record<string, number> = { [prop]: v };
      if (!animated && key === 'emitterWidth') values.width = v;
      if (!animated && key === 'emitterHeight') values.height = v;
      eng.send(`Set ${label}`, valueCommands([{ nodeId, values }], { seconds: time, autoKeyframe }));
    };
    return (
      <div className={styles.popoverRow}>
        <AnimToggle nodeId={nodeId} tracks={[prop]} label={label} animated={animated} onToggle={toggle} values={() => [shown]} />
        <span className={styles.popoverLabel}>{label}</span>
        <ValueField
          value={shown}
          unit={unit}
          {...(min !== undefined ? { min } : {})}
          {...(max !== undefined ? { max } : {})}
          {...eng.scrub(`Set ${label}`)}
          onChange={(v) => write(Number(v))}
          aria-label={label}
        />
      </div>
    );
  };

  // Structural fields (particle cap, RNG seed) — not keyframeable: they change
  // the particle INDEXING itself, so animating them would reshuffle every
  // particle each frame.
  const StaticNum = (key: 'maxParticles' | 'seed', label: string, min?: number): JSX.Element => (
    <div className={styles.popoverRow}>
      <div style={{ width: 13 }} />
      <span className={styles.popoverLabel}>{label}</span>
      <ValueField
        value={cfg[key]}
        {...(min !== undefined ? { min } : {})}
        {...scrub}
        onChange={(v) => set(key, Number(v) as ParticleConfig[typeof key])}
        aria-label={label}
      />
    </div>
  );

  const Color = (key: 'colorStart' | 'colorEnd' | 'colorMid', label: string): JSX.Element => (
    <ColorKfRow
      nodeId={nodeId}
      propPrefix={particlePropPath(key)}
      label={label}
      value={cfg[key] ?? cfg.colorStart}
      setValue={(hex) => set(key, hex)}
    />
  );

  return (
    <div className={styles.section}>
      <div className={styles.inlineRows}>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{t('inspector.particle.emitter', 'Emitter')}</span>
          <select className={styles.select} style={{ width: 110 }} value={cfg.emitterType} onChange={(e) => set('emitterType', e.target.value as ParticleConfig['emitterType'])} aria-label={t('inspector.particle.emitterType', 'Emitter type')}>
            <option value="point">{t('inspector.particle.point', 'Point')}</option>
            <option value="box">{t('inspector.particle.box', 'Box')}</option>
            <option value="circle">{t('inspector.particle.circle', 'Circle')}</option>
            <option value="sphere">{t('inspector.particle.sphere', 'Sphere')}</option>
          </select>
        </div>
        {cfg.emitterType !== 'point' && (
          <>
            {Num('emitterWidth', cfg.emitterType === 'circle' || cfg.emitterType === 'sphere' ? t('inspector.particle.diameter', 'Diameter') : t('inspector.particle.width', 'Width'), 'px', 0)}
            {cfg.emitterType === 'box' && Num('emitterHeight', t('inspector.particle.height', 'Height'), 'px', 0)}
          </>
        )}
        {Num('birthRate', t('inspector.particle.birthRate', 'Birth Rate'), '/s', 0)}
        {StaticNum('maxParticles', t('inspector.particle.maxParticles', 'Max Particles'), 1)}
        {Num('lifetime', t('inspector.particle.lifetime', 'Lifetime'), 's', 0)}
        {Num('lifetimeRandom', t('inspector.particle.lifeRandom', 'Life Random'), '', 0, 1)}

        {Num('speed', t('inspector.particle.speed', 'Speed'), 'px/s')}
        {Num('speedRandom', t('inspector.particle.speedRandom', 'Speed Random'), '', 0, 1)}
        {Num('direction', t('inspector.particle.direction', 'Direction'), '°')}
        {Num('spread', t('inspector.particle.spread', 'Spread'), '°', 0, 360)}
        {Num('gravityX', t('inspector.particle.gravityX', 'Gravity X'), 'px/s²')}
        {Num('gravityY', t('inspector.particle.gravityY', 'Gravity Y'), 'px/s²')}
        {/* Wind is constant acceleration like gravity — a separate pair rather
            than "just add it to gravity" because wind is the thing you animate
            and zero out, and gravity is the thing you set once. */}
        {Num('windX', t('inspector.particle.windX', 'Wind X'), 'px/s²')}
        {Num('windY', t('inspector.particle.windY', 'Wind Y'), 'px/s²')}
        {/* Linear drag, folded into the closed form exactly — scrubs free. */}
        {Num('drag', t('inspector.particle.drag', 'Drag'), '/s', 0)}
        {/* Velocity streaks: a fraction of the comp shutter, applied only when
            this layer's motion-blur switch is on (buildSnapshot hands the
            shutter to the field). */}
        {Num('motionBlur', t('inspector.particle.motionBlur', 'Motion Blur'), '', 0, 1)}
        {/* One amplitude, two characters: ballistic mode wanders (closed-form,
            scrub-free), stateful mode swirls (real curl-noise force). Scale is
            stateful-only — the wander has no spatial field to scale. */}
        {Num('turbulence', t('inspector.particle.turbulence', 'Turbulence'), cfg.simMode === 'stateful' ? 'px/s²' : 'px')}
        {/* Depth axis — simulated always, PROJECTED only when Perspective is
            on, so flipping perspective changes the look, never the motion. */}
        {Num('emitterDepth', t('inspector.particle.depth', 'Depth'), 'px')}
        {Num('speedZ', t('inspector.particle.speedZ', 'Speed Z'), 'px/s')}
        {Num('perspective', t('inspector.particle.perspective', 'Perspective'), 'px')}
        {/* Collisions and sub-emit are plain rows like the bounce params —
            both shape the stateful HISTORY, and their toggles/selects have no
            meaningful in-between to keyframe anyway. */}
        {cfg.simMode === 'stateful' && (
          <div className={styles.popoverRow}>
            <div style={{ width: 13 }} />
            <span className={styles.popoverLabel}>{t('inspector.particle.collide', 'Collide')}</span>
            <input
              type="checkbox"
              checked={cfg.collide ?? false}
              onChange={(e) => set('collide', e.target.checked)}
              aria-label={t('inspector.particle.particleCollisions', 'Particle collisions')}
            />
          </div>
        )}
        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>{t('inspector.particle.subEmit', 'Sub-Emit')}</span>
          <select
            className={styles.select}
            style={{ width: 110 }}
            value={cfg.subEmit ?? 'off'}
            onChange={(e) => set('subEmit', e.target.value as ParticleConfig['subEmit'])}
            aria-label={t('inspector.particle.subEmitterTrigger', 'Sub-emitter trigger')}
          >
            <option value="off">{t('inspector.particle.off', 'Off')}</option>
            <option value="death">{t('inspector.particle.onDeath', 'On Death')}</option>
            {/* A bounce is history — the closed-form emitter has none;
                continuous shedding is a closed form and so ballistic-only. */}
            {cfg.simMode === 'stateful' && <option value="bounce">{t('inspector.particle.onBounce', 'On Bounce')}</option>}
            {cfg.simMode !== 'stateful' && <option value="continuous">{t('inspector.particle.continuous', 'Continuous')}</option>}
          </select>
        </div>
        {cfg.subEmit === 'continuous' && Num('subRate', t('inspector.particle.subRate', 'Sub Rate'), '/s', 0)}
        {(cfg.subEmit ?? 'off') !== 'off' && (
          <>
            {cfg.subEmit !== 'continuous' && (
              <div className={styles.popoverRow}>
                <div style={{ width: 13 }} />
                <span className={styles.popoverLabel}>{t('inspector.particle.burst', 'Burst')}</span>
                <ValueField value={cfg.subCount ?? 8} min={0} max={16} precision={0} {...scrub} onChange={(v) => set('subCount', Number(v))} aria-label={t('inspector.particle.childrenPerBurst', 'Children per burst')} />
              </div>
            )}
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.burstSpeed', 'Burst Speed')}</span>
              <ValueField value={cfg.subSpeed ?? 120} min={0} precision={0} unit="px/s" {...scrub} onChange={(v) => set('subSpeed', Number(v))} aria-label={t('inspector.particle.childSpeed', 'Child speed')} />
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.burstLife', 'Burst Life')}</span>
              <ValueField value={cfg.subLifetime ?? 0.6} min={0.05} precision={2} unit="s" {...scrub} onChange={(v) => set('subLifetime', Number(v))} aria-label={t('inspector.particle.childLifetime', 'Child lifetime')} />
            </div>
          </>
        )}
        {/* Trails are plain rows, not Num rows, on purpose: Num makes a param
            KEYFRAMEABLE, and in stateful mode the trail ring is part of the
            state shape — animating its length would rebuild the sim on every
            frame of the ramp. Same reasoning as the bounce params above. */}
        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>{t('inspector.particle.trail', 'Trail')}</span>
          <ValueField
            value={cfg.trailLength ?? 0}
            min={0}
            max={24}
            precision={0}
            {...scrub}
            onChange={(v) => set('trailLength', Number(v))}
            aria-label={t('inspector.particle.trailPoints', 'Trail points')}
          />
        </div>
        {(cfg.trailLength ?? 0) > 0 && (
          <div className={styles.popoverRow}>
            <div style={{ width: 13 }} />
            <span className={styles.popoverLabel}>{t('inspector.particle.trailGap', 'Trail Gap')}</span>
            <ValueField
              value={cfg.trailSpacing ?? 1 / 30}
              min={1 / 240}
              precision={3}
              unit="s"
              {...scrub}
              onChange={(v) => set('trailSpacing', Number(v))}
              aria-label={t('inspector.particle.trailSpacingSeconds', 'Trail spacing seconds')}
            />
          </div>
        )}
        {cfg.simMode === 'stateful' && Num('turbulenceScale', t('inspector.particle.turbScale', 'Turb. Scale'), 'px')}
        {Num('turbulenceSpeed', t('inspector.particle.turbSpeed', 'Turb. Speed'), '×')}
        {Num('spin', t('inspector.particle.spin', 'Spin'), '°/s')}
        {/* Plexus over the live particles: 0 distance = off. */}
        {Num('plexusDistance', t('inspector.particle.plexusDist', 'Plexus Dist.'), 'px', 0)}
        {(cfg.plexusDistance ?? 0) > 0 && (
          <>
            {Num('plexusWidth', t('inspector.particle.plexusWidth', 'Plexus Width'), 'px', 0)}
            {Num('plexusOpacity', t('inspector.particle.plexusOpacity', 'Plexus Opacity'), '', 0, 1)}
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.plexusColor', 'Plexus Color')}</span>
              <input
                type="color"
                value={cfg.plexusColor ?? DEFAULT_PARTICLE_CONFIG.plexusColor}
                // The OS picker fires on every move: one gesture until it closes (blur).
                onChange={(e) => {
                  if (!picking.isActive()) picking.begin('Set Plexus Color');
                  picking.send(jsonFieldCommands(nodeId, 'layer/particle', { ...cfg, plexusColor: e.target.value }));
                }}
                onBlur={() => { void picking.end(); }}
                aria-label={t('inspector.particle.plexusLineColour', 'Plexus line colour')}
              />
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.triangles', 'Triangles')}</span>
              <input
                type="checkbox"
                checked={cfg.plexusTriangles ?? false}
                onChange={(e) => set('plexusTriangles', e.target.checked)}
                aria-label={t('inspector.particle.plexusTriangles', 'Plexus triangles')}
              />
            </div>
            {cfg.plexusTriangles && Num('plexusTriangleOpacity', t('inspector.particle.triOpacity', 'Tri. Opacity'), '', 0, 1)}
          </>
        )}

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{t('inspector.particle.shape', 'Shape')}</span>
          <select className={styles.select} style={{ width: 110 }} value={cfg.shape} onChange={(e) => set('shape', e.target.value as ParticleConfig['shape'])} aria-label={t('inspector.particle.particleShape', 'Particle shape')}>
            <option value="circle">{t('inspector.particle.circle', 'Circle')}</option>
            <option value="square">{t('inspector.particle.square', 'Square')}</option>
            <option value="line">{t('inspector.particle.line', 'Line')}</option>
            <option value="star">{t('inspector.particle.star', 'Star')}</option>
            <option value="sprite">{t('inspector.particle.spriteImage', 'Sprite (image)')}</option>
          </select>
        </div>
        {cfg.shape === 'sprite' && (
          <>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.image', 'Image')}</span>
              <select
                className={styles.select}
                style={{ width: 110 }}
                value={cfg.spriteAssetId ?? ''}
                onChange={(e) => set('spriteAssetId', e.target.value)}
                aria-label={t('inspector.particle.spriteImageAsset', 'Sprite image asset')}
              >
                <option value="">{t('inspector.particle.noneCircles', '(none — circles)')}</option>
                {imageAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.sheetFrames', 'Sheet Frames')}</span>
              <ValueField value={cfg.spriteFrames ?? 1} min={1} max={256} precision={0} {...scrub} onChange={(v) => set('spriteFrames', Number(v))} aria-label={t('inspector.particle.spriteSheetFrames', 'Sprite sheet frames')} />
            </div>
            {(cfg.spriteFrames ?? 1) > 1 && (
              <div className={styles.popoverRow}>
                <div style={{ width: 13 }} />
                <span className={styles.popoverLabel}>{t('inspector.particle.sheetFps', 'Sheet FPS')}</span>
                <ValueField value={cfg.spriteFps ?? 0} min={0} max={120} precision={0} unit="fps" {...scrub} onChange={(v) => set('spriteFps', Number(v))} aria-label={t('inspector.particle.spriteFpsAria', 'Sprite sheet frames per second (0 = by age)')} />
              </div>
            )}
          </>
        )}
        {Num('sizeStart', t('inspector.particle.sizeBirth', 'Size Birth'), 'px', 0)}
        {/* The mid-point rows: unset until touched, so old systems keep their
            straight two-point ramps byte for byte. */}
        {Num('sizeMid', t('inspector.particle.sizeMid', 'Size Mid'), 'px', 0)}
        {Num('sizeEnd', t('inspector.particle.sizeDeath', 'Size Death'), 'px', 0)}
        {Num('midAge', t('inspector.particle.midAge', 'Mid Age'), '', 0.01, 0.99)}
        {Color('colorStart', t('inspector.particle.colorBirth', 'Color Birth'))}
        {Color('colorMid', t('inspector.particle.colorMid', 'Color Mid'))}
        {Color('colorEnd', t('inspector.particle.colorDeath', 'Color Death'))}
        {Num('opacityStart', t('inspector.particle.opacityBirth', 'Opacity Birth'), '', 0, 1)}
        {Num('opacityMid', t('inspector.particle.opacityMid', 'Opacity Mid'), '', 0, 1)}
        {Num('opacityEnd', t('inspector.particle.opacityDeath', 'Opacity Death'), '', 0, 1)}

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{t('inspector.particle.transfer', 'Transfer')}</span>
          <select className={styles.select} style={{ width: 110 }} value={cfg.blend} onChange={(e) => set('blend', e.target.value as ParticleConfig['blend'])} aria-label={t('inspector.particle.transferMode', 'Transfer mode')}>
            <option value="add">{t('inspector.particle.addGlow', 'Add (glow)')}</option>
            <option value="normal">{t('inspector.particle.normal', 'Normal')}</option>
          </select>
        </div>
        {StaticNum('seed', t('inspector.particle.randomSeed', 'Random Seed'), 0)}

        <div className={styles.popoverRow}>
          <span
            className={styles.popoverLabel}
            title={(cfg.simMode ?? 'ballistic') === 'stateful'
              ? t('inspector.particle.simStatefulTitle', 'Stateful emitter with floor bounce — scrubbing replays from snapshots, identical every time. The layer transform moves the whole system.')
              : t('inspector.particle.simBallisticTitle', 'Deterministic ballistic emitter — scrubbing is stable. Switch to Stateful for floor bounce. The layer transform moves the whole system.')}
          >
            {t('inspector.particle.sim', 'Sim')}
          </span>
          <select
            className={styles.select}
            style={{ width: 110 }}
            value={cfg.simMode ?? 'ballistic'}
            onChange={(e) => set('simMode', e.target.value as ParticleConfig['simMode'])}
            aria-label={t('inspector.particle.simulationMode', 'Simulation mode')}
          >
            <option value="ballistic">{t('inspector.particle.ballistic', 'Ballistic')}</option>
            <option value="stateful">{t('inspector.particle.stateful', 'Stateful')}</option>
          </select>
        </div>
        {(cfg.simMode ?? 'ballistic') === 'stateful' && (
          <>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.floorY', 'Floor Y')}</span>
              <ValueField
                value={cfg.bounceFloor ?? 160}
                {...scrub}
                onChange={(v) => set('bounceFloor', Number(v))}
                aria-label={t('inspector.particle.floorY', 'Floor Y')}
              />
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.bounce', 'Bounce')}</span>
              <ValueField
                value={cfg.bounceRestitution ?? 0.65}
                min={0}
                max={1}
                {...scrub}
                onChange={(v) => set('bounceRestitution', Number(v))}
                aria-label={t('inspector.particle.bounceRestitution', 'Bounce restitution')}
              />
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>{t('inspector.particle.damping', 'Damping')}</span>
              <ValueField
                value={cfg.bounceDamping ?? 0.998}
                min={0}
                max={1}
                {...scrub}
                onChange={(v) => set('bounceDamping', Number(v))}
                aria-label={t('inspector.particle.airDamping', 'Air damping')}
              />
            </div>
          </>
        )}

        {/* Bake: one layer per particle. A refusal above the cap rather than a
            silent trim — see `bakeParticlesToLayers`. */}
        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>{t('inspector.particle.bake', 'Bake')}</span>
          <button
            type="button"
            className={styles.select}
            style={{ width: 110, textAlign: 'left', cursor: 'pointer' }}
            onClick={() => setBakeOpen(true)}
            title={t('inspector.particle.bakeTitle', 'Convert each particle into its own keyframed layer and hide the emitter')}
          >
            {t('inspector.particle.bakeToKeyframes', 'Bake to keyframes…')}
          </button>
        </div>

        {bakeOpen && (
          <BakeDialog
            open
            onClose={() => setBakeOpen(false)}
            title={t('inspector.particle.bakeDialogTitle', 'Bake Particles to Layers')}
            withParticleCap
            onBake={(opts) => { void runParticleBake(nodeId, opts); }}
          />
        )}

      </div>
    </div>
  );
}

export default ParticleSection;
