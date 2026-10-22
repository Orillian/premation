/**
 * CameraSection — After Effects' Camera Options for a camera layer
 * (2026-10-08), in the panel grammar LightSection follows:
 *
 *   Shot: [no-3D warning · Make All 3D] · Lens ▾ · camera-move buttons ·
 *         Distribute in Z · Create Orbit Null       (CameraShotHeader, U3)
 *   Zoom · Angle of View
 *   ▶ Film Size: Film Size · Focal Length (a read-only value)
 *   Point of Interest X Y Z  [Remove Point of Interest]   (two-node)
 *     — or [Add Point of Interest]                         (one-node)
 *   ▶ Orbit around target: Orbit Yaw · Orbit Pitch    (what the Orbit tool writes)
 *   ▶ Turn on the spot: X Rotation · Y Rotation · Z Rotation   (U7: the two
 *     used to read "Orbit" / "Rotation" and looked like one thing twice)
 *   ▶ Shake: Amount · Rotation · Frequency · Seed   (CameraShakeRows, R1)
 *   Depth of Field  On/Off
 *     Focus Distance [pick on canvas] · Lens Model Classic|Physical ·
 *     F-Stop (Physical) · Blur Level
 *     ▶ Bokeh: Iris Blades (+ the iris / highlight rows at 5–11 blades)
 *     ▶ Advanced: Aperture
 *   ▶ View: [Reset Camera] · 3D Layers  n of m  [Make All 3D]
 *
 * Position X/Y/Z live in the Transform section above; here we own the LENS.
 * Focal length is in comp-space px (pinhole model — see Project3D).
 *
 * The grammar (typography.css, "Panel type roles"): a twirl only opens and
 * closes, so Depth of Field is a ROW whose value reads On / Off, not a twirl
 * header with a checkbox; explanations are tooltips, not paragraphs — the one
 * help line left is the "no 3D layers" warning, and it leads the section
 * when it applies — it is the reason a camera "does nothing"; buttons are
 * bordered verbs. The lens is picked in the Shot header (camera program U3:
 * the shot-making verbs were scattered over three menus) and still from "Lens
 * Presets ▸" in the Properties ≡ menu (`LensPresetsMenu`, sectionMenu.tsx).
 */

import { t } from '@core/i18n';
import { useComponentProp, writeComponentProps } from './useComponentProp';
import { setLayersSwitch } from './inspectorEdits';
import { edit } from '@core/engine/uiEdits';
import { componentOfType, values } from '@core/engine/propRefs';
import { POI_PATH } from '@core/engine/pointOfInterest';
import { Project3D } from '@motion/scene';
import { DEFAULT_FILM_SIZE_MM, mmForFov } from '@core/scene/lensPresets';
import { useMirrorLayer, useMirrorProperty } from '@hooks/useMirror';
import { useActiveCompLayers } from '@hooks/useMirrorFields';
import { canBe3DLayer, useActiveCompSize } from './inspectorMirror';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { TwirlGroup } from './appearance/TwirlGroup';
import { MultiPropertyPairRow, type PairFieldSpec } from './MultiPropertyPairRow';
import { OnOffRow } from './OnOffRow';
import { useSectionMenuRows } from './sectionMenu';
import styles from './TransformSection.module.css';
import { KeyframeRow } from './KeyframeRow';
import { FocusPickButton } from './FocusPickButton';
import { Segmented } from '@components/Segmented';
import { CameraShotHeader, lensItems } from './CameraShotHeader';
import { CameraShakeRows } from './CameraShakeRows';

/** The rows' component: the layer's Transform, resolved by the write seam when a row writes (the reads are the mirror's). */
const TRANSFORM = { type: 'Transform' } as const;

/** Point of Interest as Position draws its axes: one row, three fields, each keyframed on its own track. */
const POI_FIELDS: readonly PairFieldSpec[] = [
  { prop: 'poiX', prefix: 'X' },
  { prop: 'poiY', prefix: 'Y' },
  { prop: 'poiZ', prefix: 'Z' },
];

/** The camera's focal length in comp px — its stored Zoom, or a 50mm-ish default for the comp. */
function focalOf(focalRaw: unknown, compWidth: number): number {
  return typeof focalRaw === 'number' && focalRaw > 0 ? focalRaw : Project3D.focalLengthForFov(compWidth, 39.6);
}

/**
 * "Lens Presets ▸" in the Properties ≡ menu — Camera Options' `menu` in the
 * section registry (see sectionMenu.tsx). A pick sets Zoom to the preset's
 * angle of view (one undo entry); the lens in force is ticked. Draws nothing.
 */
export function LensPresetsMenu({ nodeId }: { nodeId: string; nodeIds?: ReadonlyArray<string> }): null {
  const { width: compWidth } = useActiveCompSize();
  const [focalRaw, setFocal] = useComponentProp(nodeId, TRANSFORM, 'focalLength');
  useSectionMenuRows([{
    type: 'item',
    id: 'lens-presets',
    label: t('inspector.camera.lensPresets', 'Lens Presets'),
    submenu: lensItems(compWidth, focalOf(focalRaw, compWidth), (px) => setFocal(px)),
  }]);
  return null;
}

export function CameraSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // The layer's header and the active comp from the document mirror (B4).
  const layer = useMirrorLayer(nodeId);
  const { width: compWidth, height: compHeight } = useActiveCompSize();
  const compLayers = useActiveCompLayers();
  const [focalRaw, setFocal, focalField] = useComponentProp(nodeId, TRANSFORM, 'focalLength');
  const [filmSizeRaw, setFilmSize] = useComponentProp(nodeId, TRANSFORM, 'filmSize');
  const [yawRaw, setYaw] = useComponentProp(nodeId, TRANSFORM, 'orbitYaw');
  const [pitchRaw, setPitch] = useComponentProp(nodeId, TRANSFORM, 'orbitPitch');
  const [rollRaw, setRoll] = useComponentProp(nodeId, TRANSFORM, 'orientationZ');
  const [oriXRaw, setOriX] = useComponentProp(nodeId, TRANSFORM, 'orientationX');
  const [oriYRaw, setOriY] = useComponentProp(nodeId, TRANSFORM, 'orientationY');
  const [dofRaw, setDofStrength] = useComponentProp(nodeId, TRANSFORM, 'dofStrength');
  const [focusRaw, setFocusDistance] = useComponentProp(nodeId, TRANSFORM, 'focusDistance');
  const [apertureRaw, setAperture] = useComponentProp(nodeId, TRANSFORM, 'dofAperture');
  const [fStopRaw, setFStop] = useComponentProp(nodeId, TRANSFORM, 'fStop');
  const [irisBladesRaw, setIrisBlades] = useComponentProp(nodeId, TRANSFORM, 'irisBlades');
  const [irisRoundnessRaw, setIrisRoundness] = useComponentProp(nodeId, TRANSFORM, 'irisRoundness');
  const [highlightGainRaw, setHighlightGain] = useComponentProp(nodeId, TRANSFORM, 'highlightGain');
  const [irisRotationRaw, setIrisRotation] = useComponentProp(nodeId, TRANSFORM, 'irisRotation');
  const [irisAspectRaw, setIrisAspect] = useComponentProp(nodeId, TRANSFORM, 'irisAspect');
  const [highlightThresholdRaw, setHighlightThreshold] = useComponentProp(nodeId, TRANSFORM, 'highlightThreshold');
  const [highlightSaturationRaw, setHighlightSaturation] = useComponentProp(nodeId, TRANSFORM, 'highlightSaturation');
  const [diffractionFringeRaw, setDiffractionFringe] = useComponentProp(nodeId, TRANSFORM, 'diffractionFringe');
  // Two-node or one-node: AE's Orient Towards Point of Interest, as the engine
  // reports it. Not "is poiX a number" — the mirror lists a one-node camera's
  // Point of Interest as a latent property reading 0, so that test called every
  // camera two-node and "Add Point of Interest" could never be reached (the
  // same bug LightSection had). The Point of Interest row reads and writes its
  // three fields itself.
  const orientInfo = useMirrorProperty(nodeId, POI_PATH);
  if (!layer) return null;

  const focal = focalOf(focalRaw, compWidth);
  const fovDeg = Project3D.fovForFocalLength(compWidth, focal);
  // AE's Film Size is the virtual sensor width; the millimetre focal length is
  // derived from it and the angle of view. Changing it re-labels the lens
  // without touching what the camera actually sees, which is exactly what a
  // real sensor swap does.
  const filmSize = typeof filmSizeRaw === 'number' && filmSizeRaw > 0 ? filmSizeRaw : DEFAULT_FILM_SIZE_MM;
  const focalMm = mmForFov(fovDeg, filmSize);

  // The #1 "camera does nothing" trap: it only moves layers whose 3D switch
  // is ON. Show the live count and offer the one-click fix right here.
  // canBe3D = the shared "renderer can actually project this in 3D" predicate
  // — it also excludes solids/particles, which the old kind list let through
  // ("Make all 3D" lit switches that changed no pixel on those).
  // Scoped to the ACTIVE comp, not the scene. Comps are separate root subtrees,
  // so `flattenScene` here meant one click flipped the 3D switch on layers in
  // every other composition too — a persisted write (writeProp + autosave) that
  // no render-path fix undoes. Worse for solids: set3DEnabled seeds their
  // placement from the ACTIVE comp's dimensions, so a solid in a comp of a
  // different size was repositioned and resized as well.
  const contentLayers = compLayers.filter((l) => canBe3DLayer(l.id));
  const threeDCount = contentLayers.filter((l) => l.switches.threeD).length;
  const enableAll3D = (): void => {
    void setLayersSwitch(contentLayers.filter((l) => !l.switches.threeD).map((l) => l.id), { threeD: true }, 'Make All Layers 3D');
  };

  const orient = orientInfo?.value;
  const hasPOI = orient?.kind === 'bool' && orient.value;
  const dofOn = typeof dofRaw === 'number' && dofRaw > 0;
  const orbited = [yawRaw, pitchRaw].some((v) => typeof v === 'number' && v !== 0);
  const rotated = [oriXRaw, oriYRaw, rollRaw].some((v) => typeof v === 'number' && v !== 0);
  const allThreeD = contentLayers.length === 0 || threeDCount === contentLayers.length;
  const threeDStatus = threeDCount === 0
    ? t('inspector.camera.no3dLayers', 'No 3D layers — the camera moves nothing yet')
    : t('inspector.camera.layersAre3d', '{count} of {total} layers are 3D', { count: threeDCount, total: contentLayers.length });
  const physical = typeof fStopRaw === 'number' && fStopRaw > 0;
  const irisShaped = typeof irisBladesRaw === 'number' && irisBladesRaw >= 3;

  return (
    <div className={styles.section}>
      <div className={styles.inlineRows}>
        <CameraShotHeader
          nodeId={nodeId}
          compWidth={compWidth}
          focal={focal}
          setFocal={(v) => setFocal(v)}
          no3D={threeDCount === 0 && contentLayers.length > 0}
          makeAll3D={enableAll3D}
        />
        {/* AE calls this Zoom: the distance at which a layer renders 1:1. It
            and Angle of View are two views of ONE value, so editing either has
            to move the other — showing the angle as read-only text (which is
            what this was) makes it look like a separate, broken control. */}
        <KeyframeRow nodeId={nodeId} prop="focalLength" label={t('inspector.camera.zoom', 'Zoom')} value={focal} unit="px" min={50} onStatic={(v) => setFocal(v)} />
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{t('inspector.camera.angleOfView', 'Angle of View')}</span>
          <ValueField
            value={Number(fovDeg.toFixed(2))}
            min={1}
            max={179}
            step={0.5}
            unit="°"
            onChange={(v) => setFocal(Math.round(Project3D.focalLengthForFov(compWidth, v)))}
            {...focalField.scrub}
            aria-label={t('inspector.camera.angleOfView', 'Angle of View')}
          />
        </div>
        <TwirlGroup
          prefKey="camera.film"
          label={<span title={t('inspector.camera.filmSizeTip', 'Film Size is the virtual sensor width. It changes the millimetre reading only — the view itself is set by Zoom / Angle of View.')}>{t('inspector.camera.filmSize', 'Film Size')}</span>}
          defaultOpen={false}
          summary={t('inspector.camera.filmSummary', '{film} mm · {focal} mm lens', { film: filmSize, focal: focalMm.toFixed(1) })}
        >
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>{t('inspector.camera.filmSize', 'Film Size')}</span>
            <ValueField
              value={filmSize}
              min={1}
              step={1}
              unit="mm"
              onChange={(v) => setFilmSize(v !== DEFAULT_FILM_SIZE_MM ? v : undefined)}
              aria-label={t('inspector.camera.filmSize', 'Film Size')}
            />
          </div>
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>{t('inspector.camera.focalLength', 'Focal Length')}</span>
            <span className={styles.valueText}>{`${focalMm.toFixed(1)} mm`}</span>
          </div>
        </TwirlGroup>

        {hasPOI ? (
          <>
            <MultiPropertyPairRow nodeId={nodeId} label={t('inspector.camera.pointOfInterest', 'Point of Interest')} props={POI_FIELDS} />
            <div className={styles.actionRow}>
              <Button
                size="sm"
                variant="secondary"
                title={t('inspector.camera.removePoiTip', 'Make this a one-node camera: it stops aiming at a target and looks where it is turned')}
                // AE's Orient Towards Point of Interest off (`transform/orientTowardsPointOfInterest`).
                onClick={() => { void edit('Remove Point of Interest', { type: 'setProperty', prop: { layer: nodeId, path: POI_PATH }, value: values.bool(false) }); }}
              >
                {t('inspector.camera.removePoi', 'Remove Point of Interest')}
              </Button>
            </div>
          </>
        ) : (
          <div className={styles.actionRow}>
            <Button
              size="sm"
              variant="secondary"
              title={t('inspector.camera.addPoiTip', 'Make this a two-node camera: it always aims at a Point of Interest, so moving it re-frames the target. Keyframe the point to lead a shot across the scene.')}
              // On: the target lands at the composition centre (w/2, h/2, 0).
              onClick={() => { void edit('Enable Point of Interest', { type: 'setProperty', prop: { layer: nodeId, path: POI_PATH }, value: values.bool(true) }); }}
            >
              {t('inspector.camera.addPoi', 'Add Point of Interest')}
            </Button>
          </div>
        )}

        <TwirlGroup
          prefKey="camera.orbit"
          label={<span title={t('inspector.camera.orbitTip', "Swings the camera around its point of interest, keeping it framed (Orbit Yaw / Pitch). The viewer's Orbit tool and Alt+drag write these. On canvas: Alt+drag orbits, Shift+Alt+drag (or Alt+middle-drag) tracks XY, Alt+wheel dollies.")}>{t('inspector.camera.orbitAroundTarget', 'Orbit around target')}</span>}
          defaultOpen={orbited}
          summary={orbited ? t('inspector.camera.turned', 'Turned') : t('inspector.camera.level', 'Level')}
        >
          <KeyframeRow nodeId={nodeId} prop="orbitYaw" label={t('inspector.camera.orbitYaw', 'Orbit Yaw')} value={typeof yawRaw === 'number' ? yawRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setYaw(v)} />
          <KeyframeRow nodeId={nodeId} prop="orbitPitch" label={t('inspector.camera.orbitPitch', 'Orbit Pitch')} value={typeof pitchRaw === 'number' ? pitchRaw : 0} unit="°" min={-89} max={89} onStatic={(v) => setPitch(v)} />
        </TwirlGroup>

        {/* IN-PLACE rotation, its own twirl and NOT mixed in with Orbit above:
            the two look alike and do opposite things. Orbit moves the eye along
            an arc around the target; these turn the camera where it stands.
            Conflating them is what made a tripod pan unexpressible. */}
        <TwirlGroup
          prefKey="camera.rotation"
          label={<span title={t('inspector.camera.turnTip', 'Turns the camera on the spot without moving it — a tripod pan or tilt (X / Y / Z Rotation). No viewer tool writes these. On a two-node camera they offset the tracked aim, so it keeps following its Point of Interest while looking off to the side.')}>{t('inspector.camera.turnOnSpot', 'Turn on the spot')}</span>}
          defaultOpen={rotated}
          summary={rotated ? t('inspector.camera.turned', 'Turned') : t('inspector.camera.level', 'Level')}
        >
          <KeyframeRow nodeId={nodeId} prop="orientationX" label={t('inspector.camera.xRotation', 'X Rotation')} value={typeof oriXRaw === 'number' ? oriXRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setOriX(v)} />
          <KeyframeRow nodeId={nodeId} prop="orientationY" label={t('inspector.camera.yRotation', 'Y Rotation')} value={typeof oriYRaw === 'number' ? oriYRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setOriY(v)} />
          {/* Roll spins the frame about the view axis (a dutch angle) without
              re-aiming the camera — the third orientation axis, which the yaw +
              pitch pair alone could not express. */}
          <KeyframeRow nodeId={nodeId} prop="orientationZ" label={t('inspector.camera.zRotation', 'Z Rotation')} value={typeof rollRaw === 'number' ? rollRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setRoll(v)} />
        </TwirlGroup>

        <CameraShakeRows nodeId={nodeId} />

        {/*
          A real on/off. Depth of field used to be switched on by typing a
          number into "Blur strength" — nothing on screen said that was the
          switch, so the camera effect people reach for first looked absent.
          On starts at a blur you can SEE (20px) focused on the comp plane; off
          is strength 0, which is what "off" has always meant to the renderer.
        */}
        <OnOffRow
          label={t('inspector.camera.depthOfField', 'Depth of Field')}
          on={dofOn}
          onToggle={() => setDofStrength(dofOn ? 0 : 20)}
          title={t('inspector.camera.dofTip', 'Blur layers by their distance from the focus plane. Layers must be 3D.')}
        />
        {dofOn && (
          <>
            <KeyframeRow
              nodeId={nodeId}
              prop="focusDistance"
              label={t('inspector.camera.focusDistance', 'Focus Distance')}
              value={typeof focusRaw === 'number' ? focusRaw : focal}
              unit="px"
              min={1}
              onStatic={(v) => setFocusDistance(v)}
              trailing={<FocusPickButton nodeId={nodeId} />}
            />
            {/*
              The lens model, said in words (U5). F-Stop selects it: absent or
              0 keeps the legacy symmetric ramp — what every existing project
              uses, and what it must keep looking like; set, `dofBlurPx`
              switches to a real thin-lens circle of confusion (asymmetric,
              saturating behind the focal plane, sensitive to focal length).
              That switch used to be "type a number into F-Stop", which nobody
              could guess. Physical starts at f/2.8 when F-Stop is 0; Classic
              writes 0. Nothing is written until a user picks, so an untouched
              camera stores exactly what it stored before.
            */}
            <div className={styles.popoverRow}>
              <span
                className={styles.popoverLabel}
                title={physical
                  ? t('inspector.camera.physicalTip', 'Physical: thin-lens defocus — the foreground blurs harder than the background, distant layers stop getting blurrier, and focal length affects depth of field.')
                  : t('inspector.camera.classicTip', 'Classic: a symmetric blur ramp around the focus plane that ignores focal length (the After Effects look).')}
              >
                {t('inspector.camera.lensModel', 'Lens Model')}
              </span>
              <Segmented
                size="sm"
                aria-label={t('inspector.camera.lensModel', 'Lens Model')}
                value={physical ? 'physical' : 'classic'}
                onChange={(v) => {
                  if (v === 'physical' && !physical) setFStop(2.8);
                  else if (v === 'classic' && physical) setFStop(0);
                }}
                options={[
                  { value: 'classic', label: t('inspector.camera.classic', 'Classic') },
                  { value: 'physical', label: t('inspector.camera.physical', 'Physical') },
                ]}
              />
            </div>
            {physical && (
              <KeyframeRow nodeId={nodeId} prop="fStop" label={t('inspector.camera.fStop', 'F-Stop')} value={fStopRaw as number} min={0.5} max={32} precision={1} onStatic={(v) => setFStop(v)} />
            )}
            <KeyframeRow nodeId={nodeId} prop="dofStrength" label={t('inspector.camera.blurLevel', 'Blur Level')} value={typeof dofRaw === 'number' ? dofRaw : 0} unit="px" min={0} max={60} onStatic={(v) => setDofStrength(v)} />
            <TwirlGroup
              prefKey="camera.bokeh"
              label={<span title={t('inspector.camera.bokehTip', 'The shape of out-of-focus highlights. Iris Blades 0 is a Gaussian blur; 5–11 gives an iris-shaped bokeh with its own roundness, rotation, aspect, fringe and highlight bloom.')}>{t('inspector.camera.bokeh', 'Bokeh')}</span>}
              defaultOpen={irisShaped}
              summary={irisShaped ? t('inspector.camera.blades', '{n} blades', { n: Math.round(irisBladesRaw as number) }) : t('inspector.camera.gaussian', 'Gaussian')}
            >
              <div title={t('inspector.camera.irisBladesTip', 'Leave at 0 for a Gaussian blur. Set 5–11 for an iris-shaped bokeh.')}>
                <KeyframeRow
                  nodeId={nodeId}
                  prop="irisBlades"
                  label={t('inspector.camera.irisBlades', 'Iris Blades')}
                  value={typeof irisBladesRaw === 'number' ? irisBladesRaw : 0}
                  min={0}
                  max={11}
                  onStatic={(v) => setIrisBlades(v < 3 ? undefined : Math.round(v))}
                />
              </div>
              {irisShaped && (
                <>
                  {/* After Effects' Camera Options order. Each stores nothing at
                      its neutral value (rotation 0, aspect 1, fringe 0), so an
                      untouched camera keeps rendering byte-identically. */}
                  <KeyframeRow
                    nodeId={nodeId}
                    prop="irisRotation"
                    label={t('inspector.camera.irisRotation', 'Iris Rotation')}
                    value={typeof irisRotationRaw === 'number' ? irisRotationRaw : 0}
                    unit="°"
                    min={-180}
                    max={180}
                    onStatic={(v) => setIrisRotation(v === 0 ? undefined : v)}
                  />
                  <KeyframeRow
                    nodeId={nodeId}
                    prop="irisRoundness"
                    label={t('inspector.camera.irisRoundness', 'Iris Roundness')}
                    value={typeof irisRoundnessRaw === 'number' ? irisRoundnessRaw : 0.65}
                    min={0}
                    max={1}
                    onStatic={(v) => setIrisRoundness(v)}
                  />
                  <KeyframeRow
                    nodeId={nodeId}
                    prop="irisAspect"
                    label={t('inspector.camera.irisAspect', 'Iris Aspect Ratio')}
                    value={typeof irisAspectRaw === 'number' ? irisAspectRaw : 1}
                    min={0.25}
                    max={4}
                    onStatic={(v) => setIrisAspect(v === 1 || v <= 0 ? undefined : v)}
                  />
                  <KeyframeRow
                    nodeId={nodeId}
                    prop="diffractionFringe"
                    label={t('inspector.camera.diffractionFringe', 'Iris Diffraction Fringe')}
                    value={typeof diffractionFringeRaw === 'number' ? diffractionFringeRaw : 0}
                    min={0}
                    max={1}
                    onStatic={(v) => setDiffractionFringe(v <= 0 ? undefined : v)}
                  />
                  <KeyframeRow
                    nodeId={nodeId}
                    prop="highlightGain"
                    label={t('inspector.camera.highlightGain', 'Highlight Gain')}
                    value={typeof highlightGainRaw === 'number' ? highlightGainRaw : 0}
                    min={0}
                    max={4}
                    onStatic={(v) => setHighlightGain(v <= 0 ? undefined : v)}
                  />
                  <KeyframeRow
                    nodeId={nodeId}
                    prop="highlightThreshold"
                    label={t('inspector.camera.highlightThreshold', 'Highlight Threshold')}
                    value={typeof highlightThresholdRaw === 'number' ? highlightThresholdRaw : 0}
                    min={0}
                    max={1}
                    onStatic={(v) => setHighlightThreshold(v <= 0 ? undefined : v)}
                  />
                  <KeyframeRow
                    nodeId={nodeId}
                    prop="highlightSaturation"
                    label={t('inspector.camera.highlightSaturation', 'Highlight Saturation')}
                    value={typeof highlightSaturationRaw === 'number' ? highlightSaturationRaw : 0}
                    min={0}
                    max={4}
                    onStatic={(v) => setHighlightSaturation(v <= 0 ? undefined : v)}
                  />
                </>
              )}
            </TwirlGroup>
            {/* Aperture is the same blur as Blur Level seen as a lens opening
                (AE keeps both, linked); almost nobody needs both, so it waits
                under Advanced rather than reading as a second blur control. */}
            <TwirlGroup
              prefKey="camera.dofAdvanced"
              label={<span title={t('inspector.camera.advancedTip', 'Aperture: the blur as a lens opening in px — the twin of Blur Level in After Effects.')}>{t('inspector.camera.advanced', 'Advanced')}</span>}
              defaultOpen={false}
            >
              <KeyframeRow nodeId={nodeId} prop="dofAperture" label={t('inspector.camera.aperture', 'Aperture')} value={typeof apertureRaw === 'number' ? apertureRaw : (typeof dofRaw === 'number' ? dofRaw : 0)} unit="px" min={0} onStatic={(v) => setAperture(v)} />
            </TwirlGroup>
          </>
        )}

        <TwirlGroup prefKey="camera.view" label={t('inspector.camera.view', 'View')} defaultOpen={!allThreeD} summary={threeDStatus}>
          <div className={styles.actionRow}>
            <Button
              size="sm"
              variant="secondary"
              title={t('inspector.camera.resetTip', 'Back to the default framing: the comp centre, pulled back by the focal length so the comp plane renders 1:1, no orbit')}
              onClick={() => {
                // Back to the default framing: comp centre, pulled back by the
                // focal length so the comp plane renders exactly 1:1, no orbit.
                writeComponentProps(nodeId, componentOfType(nodeId, 'Transform') ?? '', { x: compWidth / 2, y: compHeight / 2, z: -Math.round(focal), orbitYaw: 0, orbitPitch: 0 }, 'Reset Camera');
              }}
            >
              {t('inspector.camera.reset', 'Reset Camera')}
            </Button>
          </div>
          <div className={styles.popoverRow}>
            <span
              className={styles.popoverLabel}
              title={t('inspector.camera.threeDLayersTip', "The camera moves layers with the 3D switch on (also per layer in the timeline's switch column). Position and Z live in Transform; a shorter focal length gives a wider, more dramatic perspective.")}
            >
              {t('inspector.camera.threeDLayers', '3D Layers')}
            </span>
            <span className={styles.valueText}>{t('inspector.camera.countOf', '{count} of {total}', { count: threeDCount, total: contentLayers.length })}</span>
            {/* With NONE 3D the warning and its Make All 3D lead the section (the Shot header). */}
            {!allThreeD && threeDCount > 0 && (
              <Button size="sm" variant="secondary" onClick={enableAll3D}>
                {t('inspector.camera.makeAll3d', 'Make All 3D')}
              </Button>
            )}
          </div>
        </TwirlGroup>
      </div>
    </div>
  );
}

export default CameraSection;
