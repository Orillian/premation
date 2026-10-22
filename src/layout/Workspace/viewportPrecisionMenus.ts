/**
 * Right-click menus for two viewport precision targets that are not layers:
 *
 *  • a MOTION-PATH KEYFRAME — AE's Keyframe Interpolation ▸ Spatial
 *    Interpolation (Linear / Bezier / Continuous Bezier / Auto Bezier), per
 *    vertex, plus Convert Vertex;
 *  • a RULER GUIDE — Edit Guide…, Lock / Unlock, Delete.
 *
 * Pure builders like `useWorkspaceContextMenu`'s: take ids, return items.
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import type { SpatialInterp } from '@motion/animation';
import { setSpatialInterpolation, toggleVertexInterpolation } from '@core/motion/motionPath';
import { positionSpatialInterpAt, positionTracksFrom } from '@core/mirror/positionTracks';
import { memberTracksNow } from '@stores/memberTracks';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { openGuideEditor } from './GuideEditorDialog';
import { editPositionKeys } from './viewportEdits';
import { t } from '@core/i18n';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { asCommandId } from '@app-types/common';
import { activeCompIdNow } from '@hooks/useMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { VIEWPORT_COMMAND_IDS } from './viewportCommands';
import { hasRulerOrigin, resetRulerOrigin, rulerUnit, setRulerUnit } from './rulerState';
import type { RulerUnit } from './rulerGeometry';

const SPATIAL_LABELS: ReadonlyArray<{ mode: SpatialInterp; label: string }> = [
  { mode: 'linear', label: 'Linear' },
  { mode: 'bezier', label: 'Bezier' },
  { mode: 'continuous', label: 'Continuous Bezier' },
  { mode: 'auto', label: 'Auto Bezier' },
];

/**
 * Undoable: one entry per conversion. The conversion arithmetic is the motion
 * path module's, run on a SCRATCH copy of the Position tracks; the changed
 * keys go to the engine as one `setMemberKeyframes` (see `editPositionKeys`).
 */
export function applySpatialInterpolation(nodeId: string, t: number, mode: SpatialInterp): Promise<void> {
  const label = SPATIAL_LABELS.find((s) => s.mode === mode)?.label ?? mode;
  return editPositionKeys(nodeId, `Spatial Interpolation: ${label}`, (scratch) => {
    // B3-legacy: not a write — the helper runs on the scratch engine passed in; the document
    // edit is the `updateKeyframes` built from its result (rule false positive by name).
    setSpatialInterpolation(nodeId, t, mode, scratch);
  });
}

/** Undoable Convert Vertex (Ctrl/Cmd+click a motion-path keyframe). */
export function convertMotionPathVertex(nodeId: string, t: number): Promise<void> {
  return editPositionKeys(nodeId, 'Convert Vertex', (scratch) => {
    // B3-legacy: not a write — scratch engine (see `applySpatialInterpolation`).
    toggleVertexInterpolation(nodeId, t, scratch);
  });
}

/** The menu's display name for a spatial mode (the undo label above stays the English `SPATIAL_LABELS`). */
function spatialMenuLabel(mode: SpatialInterp): string {
  switch (mode) {
    case 'linear': return t('workspace.motionPath.linear', 'Linear');
    case 'bezier': return t('workspace.motionPath.bezier', 'Bezier');
    case 'continuous': return t('workspace.motionPath.continuous', 'Continuous Bezier');
    case 'auto': return t('workspace.motionPath.auto', 'Auto Bezier');
    default: return mode;
  }
}

export function motionPathKeyframeMenuItems(nodeId: string, time: number): ContextMenuItem[] {
  // The vertex's mode from the engine's stored Position tracks (this revision's
  // getMemberKeyframes answer; no check mark until it has landed).
  const tracks = memberTracksNow(nodeId);
  const current = tracks ? positionSpatialInterpAt(nodeId, time, positionTracksFrom(tracks)) : undefined;
  return [
    {
      id: 'mp-spatial',
      label: t('workspace.motionPath.spatialInterpolation', 'Spatial Interpolation'),
      children: SPATIAL_LABELS.map(({ mode }): ContextMenuItem => ({
        id: `mp-spatial-${mode}`,
        label: spatialMenuLabel(mode),
        icon: current === mode ? 'check' : undefined,
        onSelect: () => { void applySpatialInterpolation(nodeId, time, mode); },
      })),
    },
    { id: 'mp-sep', separator: true },
    {
      id: 'mp-convert',
      label: current === 'linear'
        ? t('workspace.motionPath.convertToAuto', 'Convert Vertex to Auto Bezier (Ctrl+Click)')
        : t('workspace.motionPath.convertToCorner', 'Convert Vertex to Corner (Ctrl+Click)'),
      onSelect: () => { void convertMotionPathVertex(nodeId, time); },
    },
  ];
}

export function guideContextMenuItems(guideId: string): ContextMenuItem[] {
  const controller = getWorkspaceController();
  const guide = controller.ws.guides.get(guideId);
  if (!guide) return [];
  return [
    { id: 'guide-edit', label: t('workspace.guideMenu.edit', 'Edit Guide…'), onSelect: () => openGuideEditor(guideId) },
    {
      id: 'guide-lock',
      label: guide.locked ? t('workspace.guideMenu.unlock', 'Unlock Guide') : t('workspace.guideMenu.lock', 'Lock Guide'),
      onSelect: () => {
        controller.ws.guides.setLocked(guideId, !guide.locked);
        controller.requestRender();
      },
    },
    { id: 'guide-sep', separator: true },
    {
      id: 'guide-delete',
      label: t('workspace.guideMenu.delete', 'Delete Guide'),
      danger: true,
      onSelect: () => {
        // `remove` refuses a locked guide; a deliberate menu delete unlocks first.
        controller.ws.guides.setLocked(guideId, false);
        controller.ws.removeGuide(guideId);
        controller.requestRender();
      },
    },
  ];
}

/**
 * Right-click on the rulers or their corner: the unit, the zero point, and the
 * guides — what After Effects keeps on its rulers and View ▸ Guides.
 */
export function rulerContextMenuItems(): ContextMenuItem[] {
  const controller = getWorkspaceController();
  const compId = activeCompIdNow();
  const unit = rulerUnit();
  const guidesVisible = useGuidesStore.getState().guidesVisible;
  const run = (id: string): void => { void getCommandSystem().execute(asCommandId(id)); };
  const setUnit = (next: RulerUnit): void => {
    setRulerUnit(next);
    controller.requestRender();
  };
  return [
    {
      id: 'ruler-units',
      label: t('workspace.rulerMenu.units', 'Units'),
      children: [
        { id: 'ruler-unit-px', label: t('workspace.rulerMenu.pixels', 'Pixels'), icon: unit === 'px' ? 'check' : undefined, onSelect: () => setUnit('px') },
        { id: 'ruler-unit-percent', label: t('workspace.rulerMenu.percent', 'Percent of Composition'), icon: unit === 'percent' ? 'check' : undefined, onSelect: () => setUnit('percent') },
      ],
    },
    {
      id: 'ruler-origin-reset',
      label: t('workspace.rulerMenu.resetOrigin', 'Reset Ruler Origin'),
      disabled: !hasRulerOrigin(compId),
      onSelect: () => {
        if (compId) resetRulerOrigin(compId);
        controller.requestRender();
      },
    },
    { id: 'ruler-sep-1', separator: true },
    { id: 'ruler-guides-show', label: t('workspace.rulerMenu.showGuides', 'Show Guides'), icon: guidesVisible ? 'check' : undefined, onSelect: () => run(VIEWPORT_COMMAND_IDS.guidesShow) },
    { id: 'ruler-guides-lock', label: t('workspace.rulerMenu.lockGuides', 'Lock Guides'), onSelect: () => run(VIEWPORT_COMMAND_IDS.guidesLock) },
    { id: 'ruler-guides-unlock', label: t('workspace.rulerMenu.unlockGuides', 'Unlock Guides'), onSelect: () => run(VIEWPORT_COMMAND_IDS.guidesUnlock) },
    { id: 'ruler-guides-clear', label: t('workspace.rulerMenu.clearGuides', 'Clear Guides'), danger: true, onSelect: () => run(VIEWPORT_COMMAND_IDS.guidesClear) },
    { id: 'ruler-sep-2', separator: true },
    { id: 'ruler-hide', label: t('workspace.rulerMenu.hideRulers', 'Hide Rulers'), onSelect: () => useGuidesStore.getState().toggleRulers() },
  ];
}
