/**
 * The viewport's right-click menus, split out of `useWorkspace.ts`.
 *
 * Three menus and the four helpers they share:
 *
 *   `nodeContextMenuItems`    right-click ON a layer — the same actions the
 *                             scene tree's menu offers, minus Rename (the
 *                             tree's inline rename is local ScenePanel state)
 *   `videoContextMenuItems`   the footage submenu inside it: speed, frame
 *                             blending, time remap, Interpret Footage
 *   `canvasContextMenuItems`  right-click on EMPTY canvas — view + selection
 *   `labelColorCanvasMenuItems`  the label-colour swatch submenu
 *
 * ## Why this is its own module
 *
 * Every function here is a pure top-level builder: it takes a node id (or the
 * controller) and returns `ContextMenuItem[]`. None of it closes over the
 * hook's refs, the backend, or the render loop — which is exactly why it could
 * be lifted out of a 3.6k-line hook without threading state, and why it is the
 * first thing that should be. Behaviour is unchanged: this is a move, not a
 * rewrite, and `useWorkspace` imports the same three builders it used to
 * define.
 *
 * The menus read the LIVE clock (`playheadTime`), never the tab record — a
 * "split here" written against a 4Hz mirror lands on the wrong frame during
 * playback.
 */

import { getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { useLayoutStore } from '@stores/layoutStore';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { type WorkspaceController } from '@core/workspace/WorkspaceController';
import { type ContextMenuItem } from '@stores/contextMenuStore';
import { svgContextMenuItems } from '@layout/Inspector/svgLayerActions';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorLabelColor } from '@core/mirror/layerLabels';
import { mirrorSourceDisplaySize } from '@core/mirror/sourceSize';
import { renameLayerEdit } from '@layout/Scene/sceneEdits';
import type { FrameBlend } from '@core/scene/layerTime';
import { unfreezeEdit } from '@layout/Timeline/timelineEdits';
import { openInterpretFootage } from '@layout/Assets/InterpretFootageModal';
import { useTrackerStore } from '@stores/trackerStore';
import { assetRecordNow } from '@stores/assetSession';
import { openPrecomposeDialog } from '@layout/Composition/PrecomposeDialog';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { customPrompt } from '@components/Modal/Dialogs';
import { toggleLayerSwitchAnchored } from '@layout/Scene/layerSwitchEdits';
import {
  addKeyframesAtPlayheadEdit,
  arrangeLayersEdit,
  bakeMergePathsEdit,
  deleteSelectedLayersEdit,
  duplicateSelectedLayersEdit,
  freezeFrameEdit,
  groupSelectedLayersEdit,
  liveMergePathsEdit,
  set3DEdit,
  setFrameBlendEdit,
  setLabelColorEdit,
  setStretchEdit,
  timeReverseEdit,
  ungroupSelectedEdit,
} from './layerMenuEdits';
import { t } from '@core/i18n';
import { runPlaceBehindSubject } from './placeBehindSubjectCommand';
import { subjectMenuItems } from './subjectActions';
import { openTextBehind } from './TextBehindDialog';
import { isSubjectCandidate as isFootageLayer } from '@layout/Inspector/SubjectSection';

/**
 * Right-click menu for a canvas node — the same actions as the scene-tree menu
 * (DemoPanels.openNodeMenu), minus Rename: the tree's inline rename is local
 * ScenePanel state and window.prompt is unavailable in Electron.
 */
/**
 * The playhead, in raw comp time — the live clock, not the tab record.
 *
 * Exported because the gesture handlers and the overlay painters still in
 * `useWorkspace.ts` need it too. It is not really context-menu code; when the
 * gesture split lands it should move there and this re-export should go.
 */
export function playheadTime(): number {
  return getPlayheadTime();
}

/** The active composition's pixel size — the space projections resolve in.
 *  Exported for the same reason as `playheadTime` above. */
export function compSize(): { w: number; h: number } {
  const id = activeCompIdNow();
  const comp = id ? documentMirror().comp(id)?.settings : undefined;
  return { w: comp?.width ?? 1920, h: comp?.height ?? 1080 };
}

/**
 * Keyframe `props` at the playhead (the live clock), each holding its current
 * value — the engine's `addKeyframes` samples it, so nothing jumps.
 */
function addKeyframesAtPlayhead(id: string, label: string, props: readonly string[]): void {
  void addKeyframesAtPlayheadEdit(id, label, props, getPlayheadTime());
}

function labelColorCanvasMenuItems(targetId: string): ContextMenuItem[] {
  const sel = useSelectionStore.getState().ids;
  const ids: string[] = sel.includes(targetId) ? [...sel] : [targetId];
  const current = mirrorLabelColor(documentMirror().layer(targetId));
  // Every swatch here is a layer-label colour, so the API's label index covers it.
  const pick = (color: string | undefined) => (): void => { void setLabelColorEdit(ids, color); };
  return [
    {
      id: 'label-none',
      label: t('workspace.layerMenu.labelNone', 'None (Default)'),
      icon: current === undefined ? 'check' : undefined,
      onSelect: pick(undefined),
    },
    { id: 'label-sep', separator: true },
    ...LABEL_COLORS.map((c): ContextMenuItem => ({
      id: `label-${c.id}`,
      label: c.label,
      icon: current === c.color ? 'check' : undefined,
      onSelect: pick(c.color),
    })),
  ];
}

/** The API's frame-blend switch → the editor's `FrameBlend`. */
const FRAME_BLEND_OF: Readonly<Record<string, FrameBlend>> = { off: 'none', frameMix: 'mix', pixelMotion: 'pixelMotion' };

/**
 * The Video submenu — the footage verbs, gathered where the footage IS.
 *
 * Every one of these already existed, spread across the Effects panel's Time
 * controls, the Inspector's Track Motion section and the Assets panel's
 * right-click. Users reported reaching for them on the LAYER and finding
 * nothing; a right-click on the clip is where an editor's muscle memory goes.
 * The submenu routes to the same single implementations — nothing here is a
 * second copy of a behaviour.
 */
export function videoContextMenuItems(id: string): ContextMenuItem {
  const layer = documentMirror().layer(id);
  // The API's stretch is signed (negative = reversed), 1 = 100 %.
  const signed = layer?.timing.stretch ?? 1;
  const time = {
    stretch: Math.round(Math.abs(signed) * 100 * 1e6) / 1e6,
    reverse: signed < 0,
    frameBlend: FRAME_BLEND_OF[layer?.switches.frameBlend ?? 'off'] ?? 'none',
    // Freeze Frame: `LayerTiming.freeze` (the held time; absent = not frozen).
    freeze: layer?.timing.freeze !== undefined,
  };
  const playhead = getPlayheadTime();
  const speed = (label: string, stretch: number): ContextMenuItem => ({
    id: `spd-${stretch}`,
    label,
    icon: time.stretch === stretch ? 'check' : undefined,
    onSelect: () => { void setStretchEdit(id, stretch, time.reverse); },
  });
  const blend = (label: string, mode: FrameBlend): ContextMenuItem => ({
    id: `fb-${mode}`,
    label,
    icon: time.frameBlend === mode ? 'check' : undefined,
    onSelect: () => { void setFrameBlendEdit(id, mode); },
  });
  return {
    id: 'video',
    label: t('workspace.layerMenu.video', 'Video'),
    children: [
      // Speed is the USER's word; stretch is the model's (200% stretch = half
      // speed). The labels speak speed so nobody does the reciprocal in their
      // head mid-edit.
      { id: 'speed', label: t('workspace.layerMenu.speed', 'Speed'), children: [
        speed(t('workspace.layerMenu.speed25', '25% (4× slower)'), 400),
        speed(t('workspace.layerMenu.speed50', '50% (2× slower)'), 200),
        speed(t('workspace.layerMenu.speed100', '100% (normal)'), 100),
        speed(t('workspace.layerMenu.speed200', '200% (2× faster)'), 50),
        speed(t('workspace.layerMenu.speed400', '400% (4× faster)'), 25),
      ] },
      {
        id: 'reverse',
        label: time.reverse ? t('workspace.layerMenu.unreverse', 'Un-reverse') : t('workspace.layerMenu.reverse', 'Reverse'),
        onSelect: () => { void timeReverseEdit(id); },
      },
      {
        id: 'freeze',
        label: time.freeze ? t('workspace.layerMenu.unfreeze', 'Un-freeze Frame') : t('workspace.layerMenu.freeze', 'Freeze Frame at Playhead'),
        onSelect: () => {
          if (time.freeze) {
            void unfreezeEdit([id]);
            return;
          }
          // The engine stores the freeze on the layer's keyframe axis (the frame under the
          // playhead); the legacy write stored raw comp time, off by the bar's offset.
          void freezeFrameEdit(id, playhead);
        },
      },
      { id: 'fb', label: t('workspace.layerMenu.frameBlending', 'Frame Blending'), children: [
        blend(t('workspace.layerMenu.blendOff', 'Off'), 'none'),
        blend(t('workspace.layerMenu.blendMix', 'Frame Mix'), 'mix'),
        blend(t('workspace.layerMenu.blendPixelMotion', 'Pixel Motion (smooth slow-mo)'), 'pixelMotion'),
      ] },
      { id: 'sep-v1', separator: true },
      {
        id: 'stab',
        label: t('workspace.layerMenu.stabilize', 'Stabilize (smooth)…'),
        onSelect: () => {
          const src = mirrorSourceDisplaySize(documentMirror(), id);
          useTrackerStore.getState().setMode('smooth', src?.width ?? 0, src?.height ?? 0);
          // The Tracker panel is where Track lives (Properties has no Track Motion section).
          useLayoutStore.getState().openPanel('tracker');
          useUIStore.getState().notify({
            level: 'info',
            message: t('workspace.layerMenu.stabilizeArmed', 'Smooth Stabilize armed — press Track in the Tracker panel.'),
            durationMs: 4000,
          });
        },
      },
      {
        id: 'track',
        label: t('workspace.layerMenu.trackMotion', 'Track Motion…'),
        onSelect: () => {
          const src = mirrorSourceDisplaySize(documentMirror(), id);
          useTrackerStore.getState().setMode('follow', src?.width ?? 0, src?.height ?? 0);
          useLayoutStore.getState().openPanel('tracker');
          useUIStore.getState().notify({
            level: 'info',
            message: t('workspace.layerMenu.trackerArmed', 'Tracker armed — drag the point in the viewport, then press Track in the Tracker panel.'),
            durationMs: 4000,
          });
        },
      },
      { id: 'sep-v2', separator: true },
      {
        id: 'interpret',
        label: t('workspace.layerMenu.interpretFootage', 'Interpret Footage…'),
        onSelect: () => {
          const assetId = documentMirror().layer(id)?.source;
          // B4-gap: the Interpret Footage dialog (layout/Assets) edits the legacy asset record, so it
          // still takes one; it goes when the dialog takes an item id (the mirror's ItemInfo).
          const asset = assetRecordNow(assetId);
          if (asset) openInterpretFootage(asset);
          else useUIStore.getState().notify({ level: 'info', message: t('workspace.layerMenu.noSourceToInterpret', 'This layer has no importable source to interpret.'), durationMs: 2600 });
        },
      },
    ],
  };
}

export function nodeContextMenuItems(id: string): ContextMenuItem[] {
  const layer = documentMirror().layer(id);
  const hidden = layer?.switches.visible === false;
  const locked = layer?.switches.locked === true;
  const solo = layer?.switches.solo === true;
  const isGroup = uiKindOf(layer) === 'group';
  const isVideo = uiKindOf(layer) === 'video';
  const renameNode = (): void => {
    const n = documentMirror().layer(id);
    if (!n) return;
    void (async () => {
      const newName = await customPrompt(
        t('workspace.layerMenu.renameTitle', 'Rename Layer'),
        t('workspace.layerMenu.renameMessage', 'Give this layer a new name.'),
        n.name,
        { confirmLabel: t('workspace.layerMenu.renameConfirm', 'Rename') },
      );
      if (!newName?.trim()) return;
      // Re-read: the dialog is async now, so the node could have been deleted
      // while it was open. The old synchronous prompt could not have this gap.
      if (!documentMirror().layer(id)) return;
      // The engine's `renameLayer` follows the rename through the expressions that name the layer (B3z).
      const result = await renameLayerEdit(id, newName);
      if (!result.ok) return;
      if (result.repaired.length > 0) {
        const count = result.repaired.length;
        useUIStore.getState().notify({
          level: 'info',
          message: count === 1
            ? t('workspace.layerMenu.expressionsUpdatedOne', '{n} expression updated to follow the new name.', { n: count })
            : t('workspace.layerMenu.expressionsUpdatedOther', '{n} expressions updated to follow the new name.', { n: count }),
          durationMs: 4000,
        });
      }
      if (result.captured.length > 0 || result.nameAlreadyInUse) {
        useUIStore.getState().notify({
          level: 'warning',
          message: t('workspace.layerMenu.nameInUse', 'Another layer already uses “{name}”; review expressions that reference that name.', { name: newName.trim() }),
          durationMs: 8000,
        });
      }
    })();
  };
  return [
    { id: 'rename', label: t('workspace.layerMenu.rename', 'Rename…'), onSelect: renameNode },
    { id: 'duplicate', label: t('workspace.layerMenu.duplicate', 'Duplicate'), onSelect: () => { void duplicateSelectedLayersEdit(); } },
    // One call for the whole selection — see `reorderSiblings` for what looping
    // over it did to a multi-selection. Same sibling rules as the Layer menu
    // and the Scene panel's context menu (`arrangeNodes`).
    { id: 'arrange', label: t('workspace.layerMenu.arrange', 'Arrange'), children: [
      { id: 'arr-front', label: t('workspace.layerMenu.bringToFront', 'Bring to Front'), onSelect: () => { void arrangeLayersEdit(useSelectionStore.getState().ids, 'front'); } },
      { id: 'arr-forward', label: t('workspace.layerMenu.bringForward', 'Bring Forward'), onSelect: () => { void arrangeLayersEdit(useSelectionStore.getState().ids, 'forward'); } },
      { id: 'arr-backward', label: t('workspace.layerMenu.sendBackward', 'Send Backward'), onSelect: () => { void arrangeLayersEdit(useSelectionStore.getState().ids, 'backward'); } },
      { id: 'arr-back', label: t('workspace.layerMenu.sendToBack', 'Send to Back'), onSelect: () => { void arrangeLayersEdit(useSelectionStore.getState().ids, 'back'); } },
    ] },
    { id: 'sep0', separator: true },
    // The display labels are translated; the second argument stays the English undo label.
    { id: 'kf', label: t('workspace.layerMenu.addKeyframe', 'Add Keyframe'), children: [
      { id: 'kf-pos', label: t('workspace.layerMenu.kfPosition', 'Position'), onSelect: () => addKeyframesAtPlayhead(id, 'Position', ['x', 'y']) },
      { id: 'kf-scale', label: t('workspace.layerMenu.kfScale', 'Scale'), onSelect: () => addKeyframesAtPlayhead(id, 'Scale', ['scaleX', 'scaleY']) },
      { id: 'kf-rot', label: t('workspace.layerMenu.kfRotation', 'Rotation'), onSelect: () => addKeyframesAtPlayhead(id, 'Rotation', ['rotation']) },
      { id: 'kf-op', label: t('workspace.layerMenu.kfOpacity', 'Opacity'), onSelect: () => addKeyframesAtPlayhead(id, 'Opacity', ['opacity']) },
      { id: 'kf-all', label: t('workspace.layerMenu.kfAllTransform', 'All Transform'), onSelect: () => addKeyframesAtPlayhead(id, 'Transform', ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']) },
    ] },
    // Footage verbs on the footage itself — see videoContextMenuItems.
    ...(isVideo ? [videoContextMenuItems(id), { id: 'sep-vid', separator: true } as ContextMenuItem] : []),
    { id: 'sep1', separator: true },
    // Anchored on the right-clicked layer: its state (what the item says) decides
    // the direction for the whole selection when it is part of it.
    { id: 'toggle', label: hidden ? t('workspace.layerMenu.show', 'Show') : t('workspace.layerMenu.hide', 'Hide'), onSelect: () => { void toggleLayerSwitchAnchored(id, 'visible'); } },
    { id: 'lock', label: locked ? t('workspace.layerMenu.unlock', 'Unlock') : t('workspace.layerMenu.lock', 'Lock'), onSelect: () => { void toggleLayerSwitchAnchored(id, 'locked'); } },
    { id: 'solo', label: solo ? t('workspace.layerMenu.unsolo', 'Unsolo') : t('workspace.layerMenu.solo', 'Solo'), onSelect: () => { void toggleLayerSwitchAnchored(id, 'solo'); } },
    {
      id: 'toggle-3d',
      label: layer?.switches.threeD ? t('workspace.layerMenu.disable3D', 'Disable 3D Layer') : t('workspace.layerMenu.enable3D', 'Enable 3D Layer'),
      onSelect: () => {
        const ids = useSelectionStore.getState().ids;
        void set3DEdit(ids.includes(id) ? ids : [id]);
      },
    },
    { id: 'labelColor', label: t('workspace.layerMenu.labelColor', 'Label Color'), children: labelColorCanvasMenuItems(id) },
    { id: 'sep2', separator: true },
    {
      id: 'group',
      label: t('workspace.layerMenu.groupSelection', 'Group Selection'),
      onSelect: () => {
        void groupSelectedLayersEdit().then((handled) => {
          // Layers of different compositions (a selection made in the Scene panel): a layer
          // cannot move between compositions, so there is no one group to put them in.
          if (!handled) {
            useUIStore.getState().notify({ level: 'info', message: t('workspace.layerMenu.groupNeedsOneComp', 'Group Selection needs layers of one composition.'), durationMs: 3000 });
          }
        });
      },
    },
    ...(isGroup ? [{ id: 'ungroup', label: t('workspace.layerMenu.ungroup', 'Ungroup'), onSelect: () => { void ungroupSelectedEdit(); } }] : []),
    { id: 'precompose', label: t('workspace.layerMenu.precompose', 'Pre-compose…'), onSelect: () => openPrecomposeDialog() },
    { id: 'place-behind-subject', label: t('workspace.layerMenu.placeBehindSubject', 'Place Behind Subject'), onSelect: () => { void runPlaceBehindSubject(useSelectionStore.getState().ids); } },
    ...(isFootageLayer(id)
      ? [{ id: 'subject', label: t('workspace.layerMenu.subject', 'Subject'), children: subjectMenuItems(id, { openTextBehind }) }]
      : []),
    { id: 'rig-logo', label: t('workspace.layerMenu.rigLogo', 'Rig Logo for Animation'), onSelect: () => { void rigLogoForAnimation(); } },
    ...svgContextMenuItems(id),
    ...(useSelectionStore.getState().ids.length >= 2
      ? [
          { id: 'sep_merge', separator: true },
          {
            id: 'merge-paths',
            label: t('workspace.layerMenu.mergePaths', 'Merge Paths'),
            children: [
              { id: 'merge-live-union', label: t('workspace.layerMenu.liveUnion', 'Live Union (Add)'), onSelect: () => { void liveMergePathsEdit('union'); } },
              { id: 'merge-live-subtract', label: t('workspace.layerMenu.liveSubtract', 'Live Subtract'), onSelect: () => { void liveMergePathsEdit('subtract'); } },
              { id: 'merge-live-intersect', label: t('workspace.layerMenu.liveIntersect', 'Live Intersect'), onSelect: () => { void liveMergePathsEdit('intersect'); } },
              { id: 'merge-live-exclude', label: t('workspace.layerMenu.liveExclude', 'Live Exclude (XOR)'), onSelect: () => { void liveMergePathsEdit('exclude'); } },
              { id: 'merge-sep', label: '—', disabled: true },
              // The boolean runs off-document; its result lands as deleteLayers + pasteLayers (one entry).
              { id: 'merge-union', label: t('workspace.layerMenu.bakeUnion', 'Bake Union'), onSelect: () => { void bakeMergePathsEdit('union'); } },
              { id: 'merge-subtract', label: t('workspace.layerMenu.bakeSubtract', 'Bake Subtract'), onSelect: () => { void bakeMergePathsEdit('subtract'); } },
              { id: 'merge-intersect', label: t('workspace.layerMenu.bakeIntersect', 'Bake Intersect'), onSelect: () => { void bakeMergePathsEdit('intersect'); } },
              { id: 'merge-exclude', label: t('workspace.layerMenu.bakeExclude', 'Bake Exclude'), onSelect: () => { void bakeMergePathsEdit('exclude'); } },
            ],
          },
        ]
      : []),
    { id: 'sep3', separator: true },
    { id: 'delete', label: t('workspace.layerMenu.delete', 'Delete'), danger: true, onSelect: () => { void deleteSelectedLayersEdit(); } },
  ];
}

/** Right-click menu for empty canvas — view/selection basics. */
export function canvasContextMenuItems(controller: WorkspaceController): ContextMenuItem[] {
  const guides = useGuidesStore.getState();
  const hasSelection = useSelectionStore.getState().ids.length > 0;
  return [
    { id: 'select-all', label: t('workspace.canvasMenu.selectAll', 'Select All'), onSelect: () => controller.ws.selectAll() },
    { id: 'deselect', label: t('workspace.canvasMenu.deselect', 'Deselect'), disabled: !hasSelection, onSelect: () => controller.ws.clearSelection() },
    { id: 'sep1', separator: true },
    { id: 'fit', label: t('workspace.canvasMenu.fit', 'Fit Comp in View'), onSelect: () => controller.fitComposition() },
    { id: 'sep2', separator: true },
    { id: 'grid', label: guides.grid ? t('workspace.canvasMenu.hideGrid', 'Hide Grid') : t('workspace.canvasMenu.showGrid', 'Show Grid'), onSelect: () => guides.toggleGrid() },
    { id: 'rulers', label: guides.rulers ? t('workspace.canvasMenu.hideRulers', 'Hide Rulers') : t('workspace.canvasMenu.showRulers', 'Show Rulers'), onSelect: () => guides.toggleRulers() },
  ];
}
