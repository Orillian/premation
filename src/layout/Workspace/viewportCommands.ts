/**
 * The viewport's commands — everything the comp viewer does that deserves a
 * key, a palette entry or a menu row: JKL shuttle and in/out marks (the
 * shared transport controller), snapshot compare, camera bookmarks, guide
 * lock / clear / show, display modes, the HUD, snap-to-pixel, PAR
 * correction, the viewer LUT, the Roto Brush tool and the inline AI prompt.
 *
 * Registered from `Workspace.tsx` (mounted once per editor), the same pattern
 * as `previewCacheCommands`. Menu rows are NOT added here — `menuModel.ts` is
 * not this directory's to edit — the rows wanted are listed at the bottom.
 *
 * ## J, K and L are one rule
 *
 * All three take the same gate: the viewport or its transport bar has focus,
 * OR nothing has focus, OR a shuttle is already running.
 *
 * K used to take a STRICTER one, because it was also the Knife tool's key and
 * "nothing has focus" is the app's resting state. The cost was the transport:
 * hold-K-and-tap-J/L, the frame step editors reach for without thinking, did
 * nothing from rest. The Knife now lives on Shift+K (`tool.knife` in
 * `Providers.tsx`) and K belongs to the transport alone.
 *
 * With the TIMELINE focused none of this applies: the timeline root claims
 * `j` and `k` (`data-shortcut-claim`), where they are AE's previous / next
 * keyframe — see `useTimelineKeys`.
 *
 * `F6` used to be shared the same way (Show Snapshot once a snapshot existed,
 * the Render Queue otherwise). It no longer is: Show Snapshot is `Shift+F5`.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { aiEnabled } from '@core/config/edition';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  getCompositionShuttle,
  markIn,
  markOut,
  goToIn,
  goToOut,
  clearInOut,
  hasInOut,
  isAudioScrubEnabled,
  setAudioScrubEnabled,
} from '@core/timeline/transportController';
import {
  BOOKMARK_SLOTS,
  bookmarkAt,
  recallCameraBookmark,
  saveCameraBookmark,
} from '@core/workspace/cameraBookmarks';
import { useCompareStore, canCompare, COMPARE_MODE_LABEL, type CompareMode } from '@stores/compareStore';
import { refreshViewportPicture } from '@core/engine/viewportPicture';
import { usePreviewBehaviorStore } from '@stores/previewBehaviorStore';
import { isTransportPlaying, playTransport, seekPlayhead } from '@core/timeline/timelineView';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsSetWorkArea } from '@core/mirror/compFacts';
import { useGuidesStore } from '@stores/guidesStore';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { LAYER_CONTROL_KINDS, setLayerControlKind, toggleLayerControls, type LayerControlKind } from '@stores/layerControls';
import { useUIStore } from '@stores/uiStore';
import { useViewportDisplayStore, DISPLAY_MODE_LABEL, type DisplayMode } from '@stores/viewportDisplayStore';
import { useViewerLutStore } from '@stores/viewerLutStore';
import { openViewerLutPicker } from './viewerLutPicker';
import { openInlineAiPrompt } from './inlineAiPromptStore';
import { t } from '@core/i18n';

/** View Options rows: what each kind of layer control covers, in AE's words where AE has one. */
export function layerControlKindLabel(kind: LayerControlKind): string {
  switch (kind) {
    case 'handles':
      return t('workspace.command.layerControlKind.handles', 'Handles');
    case 'masks':
      return t('workspace.command.layerControlKind.masks', 'Masks and Shape Paths');
    case 'lightsCameras':
      return t('workspace.command.layerControlKind.lightsCameras', 'Camera and Light Wireframes');
    case 'gizmo3d':
      return t('workspace.command.layerControlKind.gizmo3d', '3D Gizmo');
    case 'effectControls':
      return t('workspace.command.layerControlKind.effectControls', 'Effect Controls');
  }
}

export const VIEWPORT_COMMAND_IDS = {
  shuttleReverse: 'transport.shuttleReverse',
  shuttleStop: 'transport.shuttleStop',
  shuttleForward: 'transport.shuttleForward',
  markIn: 'transport.markIn',
  markOut: 'transport.markOut',
  goToIn: 'transport.goToIn',
  goToOut: 'transport.goToOut',
  clearInOut: 'transport.clearInOut',
  audioScrub: 'transport.audioScrub',
  previewAudioOnly: 'transport.previewAudioOnly',
  previewAudioOnlyWorkArea: 'transport.previewAudioOnlyWorkArea',
  includeVideo: 'transport.includeVideo',
  includeAudio: 'transport.includeAudio',
  snapshot: 'view.snapshot',
  compareToggle: 'view.compareToggle',
  compareFlip: 'view.compareFlip',
  compareClear: 'view.compareClear',
  compareMode: (m: CompareMode) => `view.compareMode.${m}`,
  bookmarkRecall: (n: number) => `view.cameraBookmark.recall${n}`,
  bookmarkSave: (n: number) => `view.cameraBookmark.save${n}`,
  guidesLock: 'view.guides.lockAll',
  guidesUnlock: 'view.guides.unlockAll',
  guidesClear: 'view.guides.clear',
  guidesShow: 'view.guides.show',
  displayMode: (m: DisplayMode) => `view.displayMode.${m}`,
  displayModeCycle: 'view.displayMode.cycle',
  hud: 'view.hud',
  layerControls: 'view.layerControls',
  layerControlsWhilePlaying: 'view.layerControls.whilePlaying',
  layerControlKind: (k: LayerControlKind) => `view.layerControls.${k}`,
  snapToPixel: 'view.snapToPixel',
  pixelAspectCorrection: 'view.pixelAspectCorrection',
  viewerLutLoad: 'view.viewerLut.load',
  viewerLutClear: 'view.viewerLut.clear',
  rotoTool: 'tool.roto',
  gizmoUniversal: 'view.gizmo3d.universal',
  gizmoPosition: 'view.gizmo3d.position',
  gizmoRotation: 'view.gizmo3d.rotation',
  gizmoScale: 'view.gizmo3d.scale',
  inlineAiPrompt: 'ai.inlinePrompt',
} as const;

/**
 * Whether the comp transport may take J/K/L right now — see the header.
 * Exported for the test; reads the DOM, so a headless caller gets `true`
 * whenever a shuttle is running and otherwise "nothing has focus".
 */
export function transportChordsActive(): boolean {
  if (getCompositionShuttle().rate() !== 0) return true;
  if (typeof document === 'undefined') return true;
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  return viewportHasFocus(el);
}


/**
 * Start an audio-only preview, and put the picture back when it ends.
 *
 * The restore is the fiddly half. `includeVideo: false` is a transient mode,
 * not a preference — leaving it set after the transport stops would freeze the
 * viewport with no visible cause, which is the single worst way this feature
 * could fail. So the flag is cleared on the first tick where the transport is
 * no longer playing, however it stopped: the user hit space, the playhead ran
 * off the end, or another command paused it. Polling rather than subscribing
 * because the controller exposes no play-state event; the poll lives only for
 * the duration of the preview and stops itself.
 */
function playAudioOnly(workAreaOnly: boolean): void {
  const behavior = usePreviewBehaviorStore.getState().actions;

  if (workAreaOnly) {
    // The work area from the mirror (null = none set); transport through its seam.
    const wa = settingsSetWorkArea(activeCompSettingsNow());
    if (wa) seekPlayhead(wa.start);
  }

  behavior.setAudioOnly();
  playTransport();

  const restore = (): void => {
    behavior.reset();
    getWorkspaceController().requestRender();
  };

  // Belt and braces: if the transport never actually started (no comp, zero
  // duration), do not leave the viewport dark waiting for a stop that will
  // never come.
  if (!isTransportPlaying()) {
    restore();
    return;
  }

  const POLL_MS = 120;
  const timer = setInterval(() => {
    if (isTransportPlaying()) return;
    clearInterval(timer);
    restore();
  }, POLL_MS);
}

function viewportHasFocus(el: Element): boolean {
  return !!el.closest('[data-workspace-viewport], [data-transport-bar]');
}

export function buildViewportCommands(): ReadonlyArray<Command> {
  const cmds: Command[] = [
    // ── Transport ────────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.shuttleReverse),
      label: t('workspace.command.shuttleReverse', 'Shuttle Reverse'),
      description: t('workspace.command.shuttleReverseDescription', 'J — reverse; again for 2× and 4×. With K held, step one frame back.'),
      icon: 'skip-back',
      shortcut: { key: 'j' },
      enabled: transportChordsActive,
      execute: () => getCompositionShuttle().keyDown('j'),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.shuttleStop),
      label: t('workspace.command.shuttleStop', 'Shuttle Stop'),
      description: t('workspace.command.shuttleStopDescription', 'K — stop the shuttle. Hold with J / L to step frames.'),
      icon: 'pause',
      shortcut: { key: 'k' },
      enabled: transportChordsActive,
      execute: () => getCompositionShuttle().keyDown('k'),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.shuttleForward),
      label: t('workspace.command.shuttleForward', 'Shuttle Forward'),
      description: t('workspace.command.shuttleForwardDescription', 'L — forward; again for 2× and 4×. With K held, step one frame forward.'),
      icon: 'skip-forward',
      shortcut: { key: 'l' },
      // With a layer selected and no shuttle running, L is AE's "reveal Audio
      // Levels" (LL the waveform) — the timeline's reveal listener. The
      // shuttle takes it only when it is already running or nothing is
      // selected, so both meanings stay reachable.
      enabled: () => transportChordsActive()
        && (getCompositionShuttle().rate() !== 0 || useSelectionStore.getState().ids.length === 0),
      execute: () => getCompositionShuttle().keyDown('l'),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.markIn),
      label: t('workspace.command.markIn', 'Mark In at Playhead'),
      icon: 'trim-in',
      shortcut: { key: 'i' },
      enabled: () => true,
      execute: () => markIn(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.markOut),
      label: t('workspace.command.markOut', 'Mark Out at Playhead'),
      icon: 'trim-out',
      shortcut: { key: 'o' },
      enabled: () => true,
      execute: () => markOut(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.goToIn),
      label: t('workspace.command.goToIn', 'Go to In Point'),
      icon: 'skip-back',
      shortcut: { key: 'i', shift: true },
      enabled: hasInOut,
      execute: () => { goToIn(); },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.goToOut),
      label: t('workspace.command.goToOut', 'Go to Out Point'),
      icon: 'skip-forward',
      shortcut: { key: 'o', shift: true },
      enabled: hasInOut,
      execute: () => { goToOut(); },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.clearInOut),
      label: t('workspace.command.clearInOut', 'Clear In and Out'),
      enabled: hasInOut,
      execute: () => clearInOut(),
    },
    /**
     * AE's Numpad `.` and Alt+Numpad `.` — preview ONLY the audio.
     *
     * The picture is switched off for the duration (see
     * `previewBehaviorStore`), which is what makes this useful: nothing is
     * rendered, so nothing can fall behind, and a long comp auditions at true
     * speed even when a frame takes half a second to draw. Stopping restores
     * the picture, so the flag can never be left on by accident — the state
     * that would look like a broken viewport.
     */
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.previewAudioOnly),
      label: t('workspace.command.previewAudioOnly', 'Preview Only Audio'),
      description: t('workspace.command.previewAudioOnlyDescription', 'Play the sound from the playhead in real time, without drawing the picture.'),
      icon: 'audio',
      shortcut: { key: 'Numpad.' },
      enabled: () => true,
      execute: () => playAudioOnly(false),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.previewAudioOnlyWorkArea),
      label: t('workspace.command.previewAudioOnlyWorkArea', 'Preview Only Audio in Work Area'),
      description: t('workspace.command.previewAudioOnlyWorkAreaDescription', 'Play the work area’s sound in real time, without drawing the picture.'),
      icon: 'audio',
      shortcut: { key: 'Numpad.', alt: true },
      enabled: () => true,
      execute: () => playAudioOnly(true),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.includeVideo),
      label: t('workspace.command.includeVideo', 'Include Video in Preview'),
      description: t('workspace.command.includeVideoDescription', 'Draw the picture while previewing. Off is an audio-only preview.'),
      enabled: () => true,
      isChecked: () => usePreviewBehaviorStore.getState().includeVideo,
      execute: () => {
        const a = usePreviewBehaviorStore.getState();
        a.actions.setIncludeVideo(!a.includeVideo);
      },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.includeAudio),
      label: t('workspace.command.includeAudio', 'Include Audio in Preview'),
      description: t('workspace.command.includeAudioDescription', 'Play the composition’s sound while previewing.'),
      enabled: () => true,
      isChecked: () => usePreviewBehaviorStore.getState().includeAudio,
      execute: () => {
        const a = usePreviewBehaviorStore.getState();
        a.actions.setIncludeAudio(!a.includeAudio);
      },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.audioScrub),
      label: t('workspace.command.audioScrub', 'Audio Scrub While Dragging'),
      description: t('workspace.command.audioScrubDescription', 'Sound a short slice of the audio under the playhead as it is dragged.'),
      enabled: () => true,
      isChecked: isAudioScrubEnabled,
      execute: () => setAudioScrubEnabled(!isAudioScrubEnabled()),
    },
    // ── Snapshot compare ─────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.snapshot),
      label: t('workspace.command.snapshot', 'Take Snapshot'),
      description: t('workspace.command.snapshotDescription', 'Store the frame on screen for A/B, wipe or difference comparison. Show Snapshot (Shift+F5) displays it.'),
      icon: 'camera',
      shortcut: { key: 'F5' },
      enabled: () => true,
      execute: () => {
        useCompareStore.getState().requestCapture();
        getWorkspaceController().requestRender();
        // The capture is taken from the next drawn frame: a still viewport draws none unless asked.
        refreshViewportPicture();
        // The view does not change (the snapshot is stored, not shown), so say it happened.
        useUIStore.getState().notify({
          level: 'info',
          message: t('workspace.command.snapshotTaken', 'Snapshot taken — Shift+F5 (Show Snapshot) to compare it with the live view.'),
          durationMs: 3000,
        });
      },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.compareToggle),
      label: t('workspace.command.showSnapshot', 'Show Snapshot'),
      description: t('workspace.command.showSnapshotDescription', 'Show or hide the comparison with the last snapshot.'),
      icon: 'eye',
      // Shift+F5, beside Take Snapshot's F5 — NOT F6. F6 is the Render Queue,
      // and the queue says so in three tooltips and a toast. Sharing it on an
      // `enabled()` gate meant the same key opened a panel until the first
      // snapshot was taken and toggled an overlay ever after, with nothing on
      // screen to say which one you were about to get.
      shortcut: { key: 'F5', shift: true },
      enabled: canCompare,
      isChecked: () => useCompareStore.getState().visible,
      execute: () => useCompareStore.getState().toggleVisible(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.compareFlip),
      label: t('workspace.command.compareFlip', 'Flip A/B'),
      enabled: () => canCompare() && useCompareStore.getState().visible,
      execute: () => useCompareStore.getState().flip(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.compareClear),
      label: t('workspace.command.compareClear', 'Clear Snapshots'),
      enabled: canCompare,
      execute: () => useCompareStore.getState().clear(),
    },
    ...(Object.keys(COMPARE_MODE_LABEL) as CompareMode[]).map<Command>((m) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.compareMode(m)),
      label: t('workspace.command.compareMode', 'Compare: {mode}', { mode: COMPARE_MODE_LABEL[m] }),
      enabled: () => true,
      isChecked: () => useCompareStore.getState().mode === m,
      execute: () => useCompareStore.getState().setMode(m),
    })),
    // ── Camera bookmarks ─────────────────────────────────────────────
    ...BOOKMARK_SLOTS.map<Command>((n) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.bookmarkRecall(n)),
      label: t('workspace.command.bookmarkRecall', 'Recall Camera Bookmark {n}', { n }),
      icon: 'camera',
      shortcut: { key: String(n), meta: true, alt: true },
      enabled: () => bookmarkAt(n) !== null,
      execute: () => { recallCameraBookmark(n); },
    })),
    ...BOOKMARK_SLOTS.map<Command>((n) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.bookmarkSave(n)),
      label: t('workspace.command.bookmarkSave', 'Save Camera Bookmark {n}', { n }),
      icon: 'camera',
      shortcut: { key: String(n), meta: true, alt: true, shift: true },
      enabled: () => true,
      execute: () => {
        const b = saveCameraBookmark(n);
        useUIStore.getState().notify({ level: 'success', message: t('workspace.command.bookmarkSaved', 'Saved “{name}” (Ctrl+Alt+{n} recalls it)', { name: b.name, n }), durationMs: 2400 });
      },
    })),
    // ── Guides ───────────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.guidesLock),
      label: t('workspace.command.guidesLock', 'Lock Guides'),
      enabled: () => getWorkspaceController().ws.guides.list().some((g) => g.kind === 'user' && !g.locked),
      execute: () => setAllGuidesLocked(true),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.guidesUnlock),
      label: t('workspace.command.guidesUnlock', 'Unlock Guides'),
      enabled: () => getWorkspaceController().ws.guides.list().some((g) => g.kind === 'user' && g.locked),
      execute: () => setAllGuidesLocked(false),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.guidesClear),
      label: t('workspace.command.guidesClear', 'Clear Guides'),
      description: t('workspace.command.guidesClearDescription', 'Remove every unlocked guide.'),
      enabled: () => getWorkspaceController().ws.guides.list().some((g) => g.kind === 'user'),
      execute: () => {
        getWorkspaceController().ws.guides.clear(false);
        getWorkspaceController().requestRender();
      },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.guidesShow),
      label: t('workspace.command.guidesShow', 'Show Guides'),
      shortcut: { key: ';', meta: true },
      enabled: () => true,
      isChecked: () => useGuidesStore.getState().guidesVisible,
      execute: () => {
        useGuidesStore.getState().toggleGuidesVisible();
        getWorkspaceController().requestRender();
      },
    },
    // ── Display modes ────────────────────────────────────────────────
    ...(Object.keys(DISPLAY_MODE_LABEL) as DisplayMode[]).map<Command>((m) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.displayMode(m)),
      label: t('workspace.command.displayMode', 'Display: {mode}', { mode: DISPLAY_MODE_LABEL[m] }),
      enabled: () => true,
      isChecked: () => useViewportDisplayStore.getState().displayMode === m,
      execute: () => useViewportDisplayStore.getState().setDisplayMode(m),
    })),
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.displayModeCycle),
      label: t('workspace.command.displayModeCycle', 'Cycle Display Mode'),
      description: t('workspace.command.displayModeCycleDescription', 'Shaded → Wireframe → Bounding box.'),
      shortcut: { key: 'F4', shift: true },
      enabled: () => true,
      execute: () => useViewportDisplayStore.getState().cycleDisplayMode(),
    },
    // ── Layer controls (AE View ▸ Show Layer Controls, View Options) ─
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.layerControls),
      label: t('workspace.command.layerControls', 'Show Layer Controls'),
      description: t('workspace.command.layerControlsDescription', 'Selection boxes, handles, paths, camera and light wireframes, the 3D gizmo and effect points in the viewer — all on or all off.'),
      shortcut: { key: 'h', meta: true, shift: true },
      enabled: () => true,
      isChecked: () => usePreferenceStore.getState().showLayerControls,
      execute: () => toggleLayerControls(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.layerControlsWhilePlaying),
      label: t('workspace.command.layerControlsWhilePlaying', 'Show Layer Controls While Playing'),
      description: t('workspace.command.layerControlsWhilePlayingDescription', 'Off: the viewer shows a clean picture during playback and the controls return when it stops.'),
      enabled: () => true,
      isChecked: () => usePreferenceStore.getState().layerControlsWhilePlaying,
      execute: () => {
        const p = usePreferenceStore.getState();
        p.set('layerControlsWhilePlaying', !p.layerControlsWhilePlaying);
      },
    },
    ...LAYER_CONTROL_KINDS.map((kind): Command => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.layerControlKind(kind)),
      label: layerControlKindLabel(kind),
      enabled: () => true,
      isChecked: () => usePreferenceStore.getState().layerControlKinds?.[kind] !== false,
      execute: () => setLayerControlKind(kind, usePreferenceStore.getState().layerControlKinds?.[kind] === false),
    })),
    // ── HUD / snap / PAR ─────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.hud),
      label: t('workspace.command.hud', 'Viewport HUD'),
      description: t('workspace.command.hudDescription', 'fps, frame time, cache hits, resolution and backend in the viewport corner.'),
      shortcut: { key: 'h', meta: true, alt: true },
      enabled: () => true,
      isChecked: () => useViewportDisplayStore.getState().hud,
      execute: () => useViewportDisplayStore.getState().toggleHud(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.snapToPixel),
      label: t('workspace.command.snapToPixel', 'Snap to Pixel'),
      description: t('workspace.command.snapToPixelDescription', 'Round positions and sizes to whole pixels while dragging or nudging.'),
      shortcut: { key: 'p', meta: true, alt: true, shift: true },
      enabled: () => true,
      isChecked: () => useViewportDisplayStore.getState().snapToPixel,
      execute: () => useViewportDisplayStore.getState().toggleSnapToPixel(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.pixelAspectCorrection),
      label: t('workspace.command.pixelAspect', 'Pixel Aspect Ratio Correction'),
      description: t('workspace.command.pixelAspectDescription', 'Stretch the preview by the composition’s pixel aspect so non-square pixels look right.'),
      enabled: () => true,
      isChecked: () => useViewportDisplayStore.getState().pixelAspectCorrection,
      execute: () => useViewportDisplayStore.getState().togglePixelAspectCorrection(),
    },
    // ── Viewer LUT ───────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.viewerLutLoad),
      label: t('workspace.command.viewerLutLoad', 'Load Viewer LUT…'),
      description: t('workspace.command.viewerLutLoadDescription', 'A .cube monitor look for the viewport only — never in output.'),
      enabled: () => true,
      execute: () => { openViewerLutPicker(); },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.viewerLutClear),
      label: t('workspace.command.viewerLutClear', 'Clear Viewer LUT'),
      enabled: () => useViewerLutStore.getState().lut !== null,
      execute: () => useViewerLutStore.getState().clear(),
    },
    // ── Tools ────────────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.rotoTool),
      label: t('workspace.command.rotoTool', 'Object Matte Tools'),
      description: t('workspace.command.rotoToolDescription', 'Object Matte, then Quick Selection, Selection Brush and Refine Edge on each press.'),
      icon: 'object-matte',
      shortcut: { key: 'w', alt: true },
      enabled: () => true,
      // AE 26.2: Object Matte took the Roto Brush's slot; the key cycles the family.
      execute: () => {
        const ui = useUIStore.getState();
        const group = ['object-matte', 'roto', 'selection-brush', 'refine-edge'] as const;
        const at = group.indexOf(ui.activeTool as (typeof group)[number]);
        ui.setActiveTool(group[at < 0 ? 0 : (at + 1) % group.length]!);
      },
    },
    // ── 3D gizmo (AE parity 4.6) ─────────────────────────────────────
    // Shift+Alt+1…4 pick the gizmo (Alt+1…4 are the multicam angles); the
    // Rotate tool (W) shows the rotation gizmo whatever is picked, as AE's
    // Rotation tool does on a 3D layer.
    ...([
      ['gizmoUniversal', 'universal', t('workspace.command.gizmoUniversal', 'Universal Gizmo'), t('workspace.command.gizmoUniversalDescription', 'Move, scale and rotate from one gizmo.'), '1'],
      ['gizmoPosition', 'position', t('workspace.command.gizmoPosition', 'Position Gizmo'), t('workspace.command.gizmoPositionDescription', 'Move along an axis or a plane.'), '2'],
      ['gizmoRotation', 'rotation', t('workspace.command.gizmoRotation', 'Rotation Gizmo'), t('workspace.command.gizmoRotationDescription', 'Rotate about an axis, the view, or freely (trackball).'), '3'],
      ['gizmoScale', 'scale', t('workspace.command.gizmoScale', 'Scale Gizmo'), t('workspace.command.gizmoScaleDescription', 'Scale along an axis, or uniformly from the centre.'), '4'],
    ] as const).map(([key, state, label, description, digit]) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS[key]),
      label,
      description,
      icon: `gizmo-${state}` as const,
      shortcut: { key: digit, alt: true, shift: true },
      enabled: () => true,
      isChecked: () => useGuidesStore.getState().gizmo3dState === state,
      execute: () => useGuidesStore.getState().setGizmo3dState(state),
    })),
    // ── AI ───────────────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.inlineAiPrompt),
      label: t('workspace.command.inlineAiPrompt', 'Ask AI About Selection…'),
      description: t('workspace.command.inlineAiPromptDescription', 'An inline prompt anchored to the selected layers.'),
      icon: 'sparkles',
      shortcut: { key: 'Enter', meta: true },
      enabled: () => aiEnabled() && useSelectionStore.getState().ids.length > 0,
      execute: () => openInlineAiPrompt(),
    },
  ];
  return cmds;
}

function setAllGuidesLocked(locked: boolean): void {
  const ws = getWorkspaceController().ws;
  for (const g of ws.guides.list()) if (g.kind === 'user') ws.guides.setLocked(g.id, locked);
  getWorkspaceController().requestRender();
}

let installed = false;
let teardown: (() => void) | null = null;

/**
 * Register the commands, re-scan the shortcut bindings, and start the two
 * listeners the shuttle needs beyond the command system: K key-UP (the
 * dispatcher only sees key-down, and "K held" must end when the key lifts)
 * and audio scrub on playhead drags. Idempotent.
 */
export function installViewportCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const c of buildViewportCommands()) registry.register(c);
  getShortcutManager().rehydrateFromRegistry();

  if (typeof window !== 'undefined') {
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'k' || e.key === 'K') getCompositionShuttle().keyUp('k');
    };
    window.addEventListener('keyup', onKeyUp, { capture: true });
    teardown = () => {
      window.removeEventListener('keyup', onKeyUp, { capture: true } as EventListenerOptions);
    };
  }
}

/** Test seam. */
export function resetViewportCommandsForTest(): void {
  teardown?.();
  teardown = null;
  installed = false;
}

/*
 * Menu rows wanted in `menuModel.ts` (not this directory's file):
 *
 *   View ▸ Guides:          view.guides.show (checkbox) · view.guides.lockAll ·
 *                           view.guides.unlockAll · view.guides.clear
 *   View ▸ Display Mode:    view.displayMode.shaded / wireframe / bounds (radio)
 *   View ▸ Camera Bookmarks: view.cameraBookmark.recall1…9 · save1…9
 *   View:                   view.hud (checkbox) · view.snapToPixel (checkbox) ·
 *                           view.pixelAspectCorrection (checkbox)
 *   View ▸ Snapshot:        view.snapshot · view.compareToggle (checkbox) ·
 *                           view.compareFlip · view.compareMode.* (radio) · view.compareClear
 *   View ▸ Preview:         view.viewerLut.load · view.viewerLut.clear
 *   Composition ▸ Transport: transport.markIn · transport.markOut ·
 *                           transport.goToIn · transport.goToOut ·
 *                           transport.clearInOut · transport.audioScrub (checkbox)
 *   Tools:                  tool.roto
 *   AI:                     ai.inlinePrompt
 */
