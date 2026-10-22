/**
 * The timeline's tool controls (2026-10-07).
 *
 * After Effects' timeline has no edit-tool row, so the five Premiere-style
 * tools (select / razor / slip / slide / roll) and Playhead Follow are rows of
 * the timeline's View ▾ menu (`useTimelineToolsMenu`), and also of the clip's
 * right-click Timeline Tool menu and the command palette. Snapping joined
 * them (2026-10-14, owner: the toolbar as AE's — timecode, search, comp
 * switches); its button is kept for hosts that want one, and S still toggles.
 */

import { useEffect } from 'react';
import { Icon } from '@components/Icon';
import type { DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { t } from '@core/i18n';
import { usePreferenceStore } from '@stores/preferenceStore';
import {
  TIMELINE_EDIT_MODES,
  installTimelineEditModeCommands,
  useTimelineEditModeStore,
} from './timelineEditMode';
import { installTimelineSnapCommands, toggleTimelineSnap } from './snapCommands';
import { FOLLOW_MODES } from './playheadFollow';
import styles from './TimelineTools.module.css';


/** The Snap switch — the one timeline tool control that stays a button. */
export function TimelineSnapButton(): JSX.Element {
  const snapOn = usePreferenceStore((s) => s.timelineSnap);
  // Registered from here rather than the app's boot block so each feature is
  // one self-contained unit (and idempotent, like `installTimelineFitCommands`).
  useEffect(() => installTimelineEditModeCommands(), []);
  useEffect(() => installTimelineSnapCommands(), []);
  return (
    <button
      type="button"
      className={cn(styles.toolBtn, snapOn && styles.toolBtnActive)}
      aria-pressed={snapOn}
      aria-label={t('timeline.tools.snapAria', 'Snap in timeline')}
      title={
        snapOn
          ? t('timeline.tools.snapOnTitle', 'Snapping (On) — clip and keyframe drags snap to the playhead, edges, markers and the frame grid. Alt frees one drag. (S with the timeline focused)')
          : t('timeline.tools.snapOffTitle', 'Snapping (Off) — drags move freely. Alt snaps one drag. (S with the timeline focused)')
      }
      onClick={() => toggleTimelineSnap()}
    >
      <Icon name="magnet" size="sm" />
    </button>
  );
}

/**
 * The tools' menu rows (edit tool, playhead follow) and the state they show,
 * as a hook — the View ▾ menu lists them.
 */
export function useTimelineToolsMenu(): {
  items: DropdownItem[];
  current: (typeof TIMELINE_EDIT_MODES)[number];
  snapOn: boolean;
  followDef: (typeof FOLLOW_MODES)[number];
} {
  const mode = useTimelineEditModeStore((s) => s.mode);
  const setMode = useTimelineEditModeStore((s) => s.setMode);
  const snapOn = usePreferenceStore((s) => s.timelineSnap);
  const followMode = usePreferenceStore((s) => s.timelineFollowMode);
  const setPref = usePreferenceStore((s) => s.set);
  const current = TIMELINE_EDIT_MODES.find((d) => d.mode === mode) ?? TIMELINE_EDIT_MODES[0]!;
  const followDef = FOLLOW_MODES.find((f) => f.mode === followMode) ?? FOLLOW_MODES[0]!;

  useEffect(() => installTimelineEditModeCommands(), []);
  useEffect(() => installTimelineSnapCommands(), []);

  const items: DropdownItem[] = [
    {
      type: 'checkbox',
      id: 'tl-snap',
      label: t('timeline.tools.snapping', 'Snapping (S)'),
      checked: snapOn,
      onChange: () => toggleTimelineSnap(),
    },
    {
      type: 'item',
      id: 'tl-tool-edit',
      icon: current.icon,
      label: t('timeline.tools.currentTool', 'Timeline tool: {tool}', { tool: current.label }),
      submenu: TIMELINE_EDIT_MODES.map<DropdownItem>((def) => ({
        type: 'checkbox',
        id: `tl-tool-${def.mode}`,
        label: t('timeline.tools.labelWithDescription', '{label} — {description}', { label: def.label, description: def.description }),
        checked: mode === def.mode,
        onChange: () => setMode(def.mode),
      })),
    },
    {
      type: 'item',
      id: 'tl-tool-follow',
      label: t('timeline.tools.playheadFollow', 'Playhead follow: {mode}', { mode: followDef.label }),
      submenu: FOLLOW_MODES.map<DropdownItem>((f) => ({
        type: 'checkbox',
        id: `tl-tool-follow-${f.mode}`,
        label: t('timeline.tools.labelWithDescription', '{label} — {description}', { label: f.label, description: f.description }),
        checked: followMode === f.mode,
        onChange: () => setPref('timelineFollowMode', f.mode),
      })),
    },
  ];

  return { items, current, snapOn, followDef };
}

export default TimelineSnapButton;
