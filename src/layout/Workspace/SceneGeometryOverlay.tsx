/**
 * SceneGeometryOverlay — the 3D scene's reference geometry, drawn as SVG over a
 * viewport: ground plane, composition frame, camera frustums, light cones and
 * falloff spheres, and per-layer bounding boxes.
 *
 * None of it affects rendered output. It exists because a Classic-3D layer is a
 * plane of zero thickness: seen exactly edge-on it projects to zero area and
 * draws no pixels — correct, and what After Effects does too. Without these
 * wireframes a Left or Top view is a blank field; with them you can see where
 * every layer, camera and light actually sits.
 *
 * Always drawn inside `Gizmo3dOverlay`, under the transform handles — in the
 * main viewport and in every secondary 2-up / 4-up pane alike, each passing its
 * own camera and transform. One component, so no two views can disagree about
 * where a camera or a light sits.
 */

import React, { useId } from 'react';
import type { Camera3D, OrthoView, Vec3 } from '@motion/scene';
import { Project3D } from '@motion/scene';
import { Gizmo3D, type GizmoSegmentKind, type SceneGizmo } from '@motion/workspace';

export interface SceneGeometryOverlayProps {
  camera: Camera3D;
  orthoView: OrthoView | null;
  compWidth: number;
  compHeight: number;
  /** Comp → canvas transform: canvasPx = compPx·scale + offset. */
  viewTransform: { scale: number; offsetX: number; offsetY: number };
  groundGridVisible: boolean;
  /**
   * Ground plane offset from the comp's bottom edge, comp units. Optional and
   * defaulting to 0 — the plane at y = compHeight this drew before there was a
   * setting — so a caller that has nothing to say about the floor is unchanged.
   */
  groundLevel?: number;
  sceneGizmos: readonly SceneGizmo[];
  /**
   * Draggable camera / light points, drawn as grab dots.
   *
   * Passed in rather than recollected here so the dot cannot land anywhere the
   * hit test would not accept — one list, drawn and picked from the same values.
   */
  deviceHandles?: readonly { nodeId: string; kind: 'position' | 'poi'; world: Vec3 }[];
  /** The handle under the pointer, drawn highlighted. */
  hoveredDeviceHandle?: { nodeId: string; kind: 'position' | 'poi' } | null;
  /**
   * The view looks THROUGH a scene camera. The z = 0 comp rectangle is then not
   * drawn: from outside it says "here is the frame"; through the camera the
   * frame is the viewer itself, and the projected rectangle slides across it as
   * the camera moves — a dolly or a parallax pan looked like the output frame
   * drifting off-screen, which is the opposite of what is happening.
   */
  throughSceneCamera?: boolean;
  /**
   * Draw the comp frame even through a scene camera: the Extended Viewer (U1,
   * core/workspace/extendedViewer.ts) shows layers outside the frame there,
   * and the outline is what says where the output ends.
   */
  compFrameVisible?: boolean;
}

/**
 * Styling per segment kind. One table so the geometry builders never carry
 * presentation, and so the whole overlay reads as one visual language:
 * frustums and cones are the "what this device reaches" colour, bounds are
 * neutral, POI lines are dashed because they describe a relationship rather
 * than a thing.
 *
 * The four hues are `--color-overlay-*` tokens (tokens/domain.css), so "the
 * light colour" is one definition rather than the five copies of `#ffd166`
 * this table used to hold — and a token the CVD preset can reach.
 */
const LIGHT_STROKE = 'var(--color-overlay-light)';
const POI_STROKE = 'var(--color-overlay-poi)';

const SEGMENT_STYLE: Record<GizmoSegmentKind, { stroke: string; width: number; dash?: string; opacity: number }> = {
  body: { stroke: LIGHT_STROKE, width: 1.4, opacity: 0.95 },
  frustum: { stroke: 'var(--color-overlay-camera)', width: 1.1, opacity: 0.75 },
  cone: { stroke: LIGHT_STROKE, width: 1.1, opacity: 0.65 },
  feather: { stroke: LIGHT_STROKE, width: 1, dash: '4 4', opacity: 0.32 },
  radius: { stroke: LIGHT_STROKE, width: 1, dash: '3 4', opacity: 0.38 },
  direction: { stroke: LIGHT_STROKE, width: 1.1, opacity: 0.6 },
  poi: { stroke: POI_STROKE, width: 1, dash: '5 4', opacity: 0.8 },
  bounds: { stroke: 'var(--color-overlay-bounds)', width: 1, opacity: 0.5 },
};

export const SceneGeometryOverlay: React.FC<SceneGeometryOverlayProps> = ({
  camera,
  orthoView,
  compWidth,
  compHeight,
  viewTransform,
  groundGridVisible,
  groundLevel = 0,
  sceneGizmos,
  deviceHandles,
  hoveredDeviceHandle,
  throughSceneCamera,
  compFrameVisible = false,
}) => {
  // One mask id per overlay instance: the main viewport and each inspection
  // pane mount their own copy, and SVG ids are document-wide.
  const gridMaskId = `ground-grid${useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const projectScreen = (p: Vec3): { x: number; y: number } => {
    const cp = orthoView
      ? Project3D.projectOrtho(p, orthoView, compWidth, compHeight)
      : Project3D.projectPoint(p, camera);
    return Gizmo3D.compToViewport(cp, viewTransform);
  };

  const finite = (p: { x: number; y: number }): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

  /**
   * The ground plane (U2 interim, until the engine draws it — E8). A floor
   * seen from floor level correctly collapses to a single horizontal line in
   * Front / Back / Left / Right — that line IS the horizon, and it is the
   * cheapest thing on screen that tells you which way is up in an otherwise
   * empty side view.
   *
   * Adaptive: the cell size follows the camera's distance from the floor's
   * centre (over the viewport magnification), two nested levels, so the floor
   * reads at any zoom instead of thinning to nothing or filling the view. The
   * X axis is the red axis token, the Z axis the blue one (the gizmo's
   * colours, CVD-aware); minor lines are fainter. Distance fade is a radial
   * mask in screen space around the floor's projected centre — the far edge
   * of a receding floor is at the top of its footprint, which the fade dims —
   * four paths and one mask rather than hundreds of segments.
   */
  const renderGroundGrid = () => {
    if (!groundGridVisible) return null;
    const scale = viewTransform.scale || 1;
    const centerWorld: Vec3 = { x: compWidth / 2, y: compHeight + groundLevel, z: 0 };
    // How far the viewer is from the floor's centre, in comp px per screen px:
    // a perspective camera's true distance; an axis view is a parallel
    // projection with no distance, so the comp's width stands in for it.
    const distance = orthoView
      ? compWidth
      : Math.hypot(camera.position.x - centerWorld.x, camera.position.y - centerWorld.y, camera.position.z - centerWorld.z);
    const grid = Gizmo3D.buildAdaptiveGroundGrid(compWidth, compHeight, Math.max(1, distance) / scale, { groundLevel });
    const pathOf = (lines: readonly Gizmo3D.GroundGridLine3D[]): string => {
      let d = '';
      for (const l of lines) {
        const a = projectScreen(l.start);
        const b = projectScreen(l.end);
        if (!finite(a) || !finite(b)) continue;
        d += `M${a.x} ${a.y}L${b.x} ${b.y}`;
      }
      return d;
    };
    const axisLine = (l: Gizmo3D.GroundGridLine3D, stroke: string, key: string) => {
      const a = projectScreen(l.start);
      const b = projectScreen(l.end);
      if (!finite(a) || !finite(b)) return null;
      return <line key={key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeOpacity={0.85} strokeWidth={1.5} />;
    };
    // The fade: a radial mask around the projected centre, out to the farthest
    // projected corner of the floor. A corner behind the camera (non-finite)
    // means no usable radius — the floor then draws unfaded.
    const centerScreen = projectScreen(centerWorld);
    const corners = [
      { x: centerWorld.x - grid.extent, y: centerWorld.y, z: -grid.extent },
      { x: centerWorld.x + grid.extent, y: centerWorld.y, z: -grid.extent },
      { x: centerWorld.x - grid.extent, y: centerWorld.y, z: grid.extent },
      { x: centerWorld.x + grid.extent, y: centerWorld.y, z: grid.extent },
    ].map(projectScreen);
    const radius = finite(centerScreen) && corners.every(finite)
      ? Math.max(...corners.map((c) => Math.hypot(c.x - centerScreen.x, c.y - centerScreen.y)))
      : 0;
    const maskId = `${gridMaskId}-fade`;
    return (
      <g className="ground-grid" mask={radius > 0 ? `url(#${maskId})` : undefined}>
        {radius > 0 && (
          <defs>
            <radialGradient id={`${maskId}-g`} gradientUnits="userSpaceOnUse" cx={centerScreen.x} cy={centerScreen.y} r={radius}>
              <stop offset="0" stopColor="#fff" stopOpacity={1} />
              <stop offset="0.45" stopColor="#fff" stopOpacity={1} />
              <stop offset="1" stopColor="#fff" stopOpacity={0} />
            </radialGradient>
            <mask id={maskId} maskUnits="userSpaceOnUse" x={centerScreen.x - radius} y={centerScreen.y - radius} width={radius * 2} height={radius * 2}>
              <circle cx={centerScreen.x} cy={centerScreen.y} r={radius} fill={`url(#${maskId}-g)`} />
            </mask>
          </defs>
        )}
        <path d={pathOf(grid.minor)} fill="none" stroke="var(--color-overlay-stroke)" strokeOpacity={0.1} strokeWidth={1} />
        <path d={pathOf(grid.major)} fill="none" stroke="var(--color-overlay-stroke)" strokeOpacity={0.3} strokeWidth={1} />
        {axisLine(grid.axisX, 'var(--color-axis-x)', 'axis-x')}
        {axisLine(grid.axisZ, 'var(--color-axis-z)', 'axis-z')}
      </g>
    );
  };

  /**
   * The composition frame as 3D geometry — the z = 0 rectangle.
   *
   * The engine clips every view to the comp rectangle unless the Extended
   * Viewer is on (U1): with it, from a side view most of the scene sits outside
   * the frame and this outline is the only indication of where the frame went.
   * It is AE's Extended Viewer edge: the comp rect from the front, a vertical
   * line edge-on from Left/Right, a receding quad from a custom view — which is
   * exactly the cue that tells you how you are looking.
   */
  const renderCompFrame = () => {
    if (throughSceneCamera && !compFrameVisible) return null;
    const corners = [
      { x: 0, y: 0, z: 0 },
      { x: compWidth, y: 0, z: 0 },
      { x: compWidth, y: compHeight, z: 0 },
      { x: 0, y: compHeight, z: 0 },
    ].map(projectScreen);
    if (!corners.every(finite)) return null;
    return (
      <polygon
        className="comp-frame-3d"
        points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="var(--color-overlay-stroke-soft)"
        strokeWidth={1}
        strokeDasharray="6 4"
      />
    );
  };

  const renderSceneGizmos = () => {
    if (!sceneGizmos.length) return null;
    return (
      <g className="scene-gizmos">
        {sceneGizmos.map((giz) => (
          <g key={`${giz.type}_${giz.nodeId}`} opacity={giz.selected ? 1 : 0.62}>
            {giz.segments.map((s, i) => {
              const st = SEGMENT_STYLE[s.kind];
              const a = projectScreen(s.start);
              const b = projectScreen(s.end);
              // A projected point can be non-finite when a segment crosses the
              // camera's near plane; skipping keeps one bad segment from
              // blanking the whole group.
              if (!finite(a) || !finite(b)) return null;
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={st.stroke}
                  strokeWidth={st.width}
                  strokeOpacity={st.opacity}
                  strokeDasharray={st.dash}
                  strokeLinecap="round"
                />
              );
            })}
          </g>
        ))}
      </g>
    );
  };

  /**
   * The grab dots. A wireframe alone gives no cue that it can be dragged, and
   * the camera body is only a few pixels across at a typical zoom — the dot is
   * what makes the handle findable and is sized to the same 12px tolerance the
   * hit test uses, so anything you can see you can also grab.
   */
  const renderDeviceHandles = () => {
    if (!deviceHandles || deviceHandles.length === 0) return null;
    return (
      <g className="device-handles">
        {deviceHandles.map((h) => {
          const p = projectScreen(h.world);
          if (!finite(p)) return null;
          const hot = hoveredDeviceHandle?.nodeId === h.nodeId && hoveredDeviceHandle?.kind === h.kind;
          // POI keeps the pink of its crosshair, position the amber of the
          // chassis, so a dot always reads as part of the wireframe it belongs to.
          const stroke = h.kind === 'poi' ? POI_STROKE : LIGHT_STROKE;
          return (
            <circle
              key={`${h.nodeId}_${h.kind}`}
              cx={p.x}
              cy={p.y}
              r={hot ? 7 : 5}
              fill={hot ? stroke : 'var(--color-overlay-handle-idle)'}
              fillOpacity={hot ? 0.9 : 0.6}
              stroke={stroke}
              strokeWidth={1.5}
            />
          );
        })}
      </g>
    );
  };

  return (
    <>
      {renderGroundGrid()}
      {renderCompFrame()}
      {renderSceneGizmos()}
      {renderDeviceHandles()}
    </>
  );
};
