/**
 * The Guides group of the transport row: the SCENE-side toggles of the
 * viewport's measuring chrome.
 *
 *  • Smart Guides — the pink distance lines, equal-spacing bars, size matches
 *    and the size pill under a selected layer. OFF by default (owner decision
 *    2026-10-19: After Effects draws none of it, and over every drag it was
 *    more than most moves wanted); this button is where it is switched on,
 *    and the Overlays menu lists the same row.
 *  • the motion-path toggle, shown while the single selected layer has
 *    Position keyframes (AE draws the path of the selected layer;
 *    Ctrl+Alt+M here).
 *
 * **This renders in the transport bar, right of the play cluster**, as the
 * Guides group before the Display group (`ViewportDisplayControls`). It owns
 * the hairline after it.
 *
 * What used to sit beside it and does not any more (2026-10-07), because each
 * had a better home and the row had grown to 24 buttons:
 *
 *  • the 3D-view badge — the 3D View menu at the left of the row already names
 *    the view and lights up off the Active Camera (`1` returns to it);
 *  • Auto-Bezier / Straighten path — keyframe actions, so rows of the
 *    keyframe right-click menu (Motion Path ▸);
 *  • the "make 3D" cube — AE's 3D switch is the timeline column and Layer ▸
 *    3D Layer;
 *  • the "Animated" chip — the timeline's diamonds say it.
 *
 * The Free/Fixed camera lock is `Tabs/EditorTabs.tsx`.
 */

import { useMemo } from 'react';
import { Icon } from '@components/Icon';
import { useGuidesStore } from '@stores/guidesStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { toggleLayerControls } from '@stores/layerControls';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys } from '@hooks/useMirror';
import { hasPositionKeys } from '@core/mirror/motionFacts';
import { cn } from '@utils/cn';
import styles from './ViewportTools.module.css';
import tool from './viewportToolButton.module.css';
import { t } from '@core/i18n';

export function ViewportTools(): JSX.Element {
  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);
  const smartGuides = useGuidesStore((s) => s.smartGuides);
  const toggleSmartGuides = useGuidesStore((s) => s.toggleSmartGuides);
  const showLayerControls = usePreferenceStore((s) => s.showLayerControls);

  // Re-render when the selection or a selected layer's keyframes change, so
  // the motion-path toggle appears and disappears with the path.
  const selectedIds = useSelectionStore((s) => s.ids);
  const watchKeys = useMemo(() => selectedIds.map((id) => `keys:${id}`), [selectedIds]);
  useMirrorKeys(watchKeys);

  const singleId = selectedIds.length === 1 ? selectedIds[0] : null;
  const hasPath = !!singleId && hasPositionKeys(documentMirror(), singleId);

  return (
    <div className={styles.tools} role="group" aria-label={t('workspace.viewportTools.group', 'Viewport guides')}>
      <div className={tool.group}>
        {/* AE View ▸ Show Layer Controls (Ctrl+Shift+H): boxes, handles, paths,
            light/camera wireframes and the gizmo, all at once. The kinds and
            "while playing" are in Overlays ▸ Layer Controls. */}
        <button
          type="button"
          className={cn(tool.tool, showLayerControls && tool.toolActive)}
          onClick={toggleLayerControls}
          aria-label={t('workspace.viewportTools.layerControls', 'Layer controls')}
          aria-pressed={showLayerControls}
          title={showLayerControls
            ? t('workspace.viewportTools.hideLayerControls', 'Hide Layer Controls (Ctrl+Shift+H) — boxes, handles, paths, light and camera wireframes')
            : t('workspace.viewportTools.showLayerControls', 'Show Layer Controls (Ctrl+Shift+H)')}
        >
          <Icon name="frame" size="sm" />
        </button>
        <button
          type="button"
          className={cn(tool.tool, smartGuides && tool.toolActive)}
          onClick={toggleSmartGuides}
          aria-label={t('workspace.viewportTools.smartGuides', 'Smart guides')}
          aria-pressed={smartGuides}
          title={smartGuides
            ? t('workspace.viewportTools.smartGuidesOn', 'Smart Guides ON — distance lines, equal spacing and the size readout while you move (click to hide)')
            : t('workspace.viewportTools.smartGuidesOff', 'Smart Guides OFF — click to show distances to neighbours, equal spacing and the size readout while you move')}
        >
          <Icon name="ruler" size="sm" />
        </button>
        {hasPath && (
          <button
            type="button"
            className={cn(tool.tool, motionPathVisible && tool.toolActive)}
            onClick={toggleMotionPath}
            aria-label={t('workspace.viewportTools.motionPath', 'Show motion path')}
            aria-pressed={motionPathVisible}
            title={motionPathVisible
              ? t('workspace.viewportTools.hideMotionPath', 'Hide Motion Path (Ctrl+Alt+M)')
              : t('workspace.viewportTools.showMotionPath', 'Show Motion Path (Ctrl+Alt+M)')}
          >
            <Icon name="path" size="sm" />
          </button>
        )}
      </div>
      <div className={tool.divider} />
    </div>
  );
}
