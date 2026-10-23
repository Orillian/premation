/**
 * CustomizeDialog — workspace, shortcuts & UI customization in one place:
 *   • Shortcuts — search, filter, record, rebind, clear, and reset command keys
 *   • Workspaces — apply layout presets, save current arrangement, manage custom presets
 *   • Appearance — accent color picker with presets, dock alignment, UI zoom, switches
 *   • AI Engine — provider keys and model configuration (when AI edition is active)
 */

import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from '@utils/cn';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { SearchField } from '@components/SearchField';
import { EmptyState } from '@components/EmptyState';
import { ColorPicker } from '@components/ColorPicker';
import { Switch } from '@components/Switch';
import { Icon } from '@components/Icon';
import { useLayoutStore } from '@stores/layoutStore';
import { getCommandRegistry } from '@core/commands/Command';
import { commandLabel } from '@core/commands/commandLabel';
import { ensureCommandsRegistered } from '@core/commands/ensureCommandsRegistered';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { chordFromEvent } from '@core/commands/CommandSystem';
import { chordKeys, formatChord } from '@core/commands/formatChord';
import {
  getShortcutOverrides,
  setShortcutOverride,
  clearShortcutOverride,
  clearAllShortcutOverrides,
  resolveChord,
  findChordConflict,
} from '@core/commands/shortcutOverrides';
import { getWorkspaceManager } from '@core/layout/workspaceManager';
import { getThemeManager, getSettingsManager } from '@core/services/coreServices';
import { engine } from '@core/engine/engineInstance';
import { engineCacheSnapshot, subscribeEngineCache } from '@layout/Timeline/engineCacheCoverage';
import { formatCacheMb } from '@layout/Timeline/previewCacheStats';
import { getAccentColor, setAccentColor } from '@core/theme/accent';
import { usePreferenceStore } from '@stores/preferenceStore';
import type { KeyChord } from '@app-types/common';
import { AiSettingsSection } from './AiSettingsSection';
import { ClaudeConnectSection } from './ClaudeConnectSection';
import { McpAppsSection } from './McpAppsSection';
import { ExportSettingsSection } from './ExportSettingsSection';
import { PerformanceSettingsSection } from './PerformanceSettingsSection';
import { UpdatesControl } from './UpdatesControl';
import { ObjectMatteControl } from './ObjectMatteControl';
import { VideoExportControl } from './VideoExportControl';
import { FaceModelControl } from './FaceModelControl';
import { FilesTab } from './FilesTab';
import { DiskCacheSettings } from './DiskCacheSettings';
import { AudioHardwareSection } from './AudioHardwareSection';
import { LanguageSetting } from './LanguageSetting';
import { isServerEdition } from '@core/config/edition';
import { t } from '@core/i18n';
import styles from './CustomizeDialog.module.css';

export type { Tab } from './customizeTabs';
import { tabsForEdition, type Tab } from './customizeTabs';

/** Modifier-only keydowns aren't a chord — keep listening until a real key. */
function isModifierKey(key: string): boolean {
  return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
}

interface Row {
  id: string;
  label: string;
  chord: KeyChord | undefined;
  overridden: boolean;
  /** `getCommandCategory`, computed once per row rather than per render. */
  category: { key: string; label: string };
  /** Lower-cased label + id + chord: what the search box matches against. */
  haystack: string;
}

/** Rows rendered on the first paint of the Shortcuts tab (about two screens). */
const FIRST_PAINT_ROWS = 40;

/** The filter chips. A function: labels are translated at render time. */
function categories(): ReadonlyArray<{ id: string; label: string }> {
  return [
    { id: 'all', label: t('settings.customize.category.all', 'All Commands') },
    { id: 'tools', label: t('settings.customize.category.tools', 'Tools') },
    { id: 'timeline', label: t('settings.customize.category.timeline', 'Timeline') },
    { id: 'edit', label: t('settings.customize.category.edit', 'Edit') },
    { id: 'layer', label: t('settings.customize.category.layer', 'Layers') },
    { id: 'view', label: t('settings.customize.category.view', 'View') },
    { id: 'file', label: t('settings.customize.category.file', 'File') },
  ];
}

function getCommandCategory(id: string, label: string): { key: string; label: string } {
  const lowerId = id.toLowerCase();
  const lowerLabel = label.toLowerCase();
  if (lowerId.startsWith('tool.') || lowerId.startsWith('tools.') || lowerLabel.includes('tool')) return { key: 'tools', label: t('settings.customize.category.tools', 'Tools') };
  if (lowerId.startsWith('timeline.') || lowerId.startsWith('time.') || lowerId.startsWith('playback.') || lowerLabel.includes('play') || lowerLabel.includes('frame') || lowerLabel.includes('timeline')) return { key: 'timeline', label: t('settings.customize.category.timeline', 'Timeline') };
  if (lowerId.startsWith('edit.') || lowerId.startsWith('history.') || lowerLabel.includes('undo') || lowerLabel.includes('redo') || lowerLabel.includes('duplicate') || lowerLabel.includes('delete') || lowerLabel.includes('select')) return { key: 'edit', label: t('settings.customize.category.edit', 'Edit') };
  if (lowerId.startsWith('layer.') || lowerId.startsWith('scene.') || lowerLabel.includes('layer') || lowerLabel.includes('matte') || lowerLabel.includes('mask')) return { key: 'layer', label: t('settings.customize.category.layer', 'Layers') };
  if (lowerId.startsWith('view.') || lowerId.startsWith('canvas.') || lowerId.startsWith('zoom.') || lowerLabel.includes('zoom') || lowerLabel.includes('fit') || lowerLabel.includes('view')) return { key: 'view', label: t('settings.customize.category.view', 'View') };
  if (lowerId.startsWith('file.') || lowerId.startsWith('project.') || lowerLabel.includes('file') || lowerLabel.includes('project') || lowerLabel.includes('save') || lowerLabel.includes('export')) return { key: 'file', label: t('settings.customize.category.file', 'File') };
  if (lowerId.startsWith('animation.') || lowerId.startsWith('keyframe.') || lowerLabel.includes('keyframe') || lowerLabel.includes('ease')) return { key: 'animation', label: t('settings.customize.category.animation', 'Animation') };
  return { key: 'general', label: t('settings.customize.category.general', 'General') };
}

function renderChordKeys(chord: KeyChord | undefined): JSX.Element {
  if (!chord) {
    return (
      <span className={styles.unassignedWrap}>
        <Icon name="plus" size="sm" />
        <span className={styles.unassigned}>{t('settings.customize.shortcut.assign', 'Assign shortcut')}</span>
      </span>
    );
  }
  // The same keycaps every menu and tooltip prints — one formatter, so the
  // dialog can never disagree with the label it is documenting.
  const keys = chordKeys(chord);

  return (
    <div className={styles.keyCombo}>
      {keys.map((k, idx) => (
        <span key={idx} className={styles.keyWrapper}>
          {idx > 0 && <span className={styles.keyPlus}>+</span>}
          <kbd className={styles.kbd}>{k}</kbd>
        </span>
      ))}
    </div>
  );
}

interface ShortcutRowProps {
  row: Row;
  recording: boolean;
  /** Label of the command this row's last recording clashed with, if any. */
  conflictWith: string | null;
  onRecord: (id: string) => void;
  onReset: (id: string) => void;
  onDisable: (id: string) => void;
}

/**
 * One command. Memoised: recording or rebinding one shortcut re-renders that
 * row, not all ~260 of them (each with three or four icons).
 */
const ShortcutRow = memo(function ShortcutRow({
  row: r,
  recording: isRec,
  conflictWith,
  onRecord,
  onReset,
  onDisable,
}: ShortcutRowProps): JSX.Element {
  return (
    <div className={cn(styles.shortcutRow, isRec && styles.shortcutRowRecording)}>
      <div className={styles.colCommand}>
        <span className={styles.commandLabel}>{r.label}</span>
        {conflictWith !== null ? (
          <span className={styles.conflictBadge}>
            <Icon name="warning" size="sm" />
            <span>{t('settings.customize.shortcut.conflict', 'Conflict with “{command}”', { command: conflictWith })}</span>
          </span>
        ) : null}
      </div>

      <div className={styles.colCategory}>
        <span className={styles.categoryTag}>{r.category.label}</span>
      </div>

      <div className={styles.colKey}>
        {isRec ? (
          <div className={cn(styles.shortcutChip, styles.shortcutRecording)}>
            <span className={styles.recordingPulse} />
            <span className={styles.recordingText}>{t('settings.customize.shortcut.pressKeys', 'Press keys now…')}</span>
            <span className={styles.escBadge}>{t('settings.customize.shortcut.escCancel', 'Esc to cancel')}</span>
          </div>
        ) : (
          <button
            type="button"
            className={cn(
              styles.shortcutChip,
              r.overridden && styles.shortcutOverridden,
              !r.chord && styles.shortcutEmpty,
            )}
            onClick={() => onRecord(r.id)}
            title={t('settings.customize.shortcut.chipTitle', 'Click to assign or rebind shortcut')}
          >
            {renderChordKeys(r.chord)}
          </button>
        )}
      </div>

      <div className={styles.colActions}>
        <button
          type="button"
          className={styles.rowActionBtn}
          title={r.chord ? t('settings.customize.shortcut.edit', 'Edit shortcut') : t('settings.customize.shortcut.add', 'Add shortcut')}
          aria-label={r.chord ? t('settings.customize.shortcut.edit', 'Edit shortcut') : t('settings.customize.shortcut.add', 'Add shortcut')}
          onClick={() => onRecord(r.id)}
        >
          <Icon name={r.chord ? 'pencil' : 'plus'} size="sm" />
        </button>

        {r.overridden ? (
          <button
            type="button"
            className={styles.rowActionBtn}
            title={t('settings.customize.shortcut.reset', 'Reset to default binding')}
            aria-label={t('settings.customize.shortcut.reset', 'Reset to default binding')}
            onClick={() => onReset(r.id)}
          >
            <Icon name="refresh" size="sm" />
          </button>
        ) : null}

        {r.chord ? (
          <button
            type="button"
            className={cn(styles.rowActionBtn, styles.rowActionDelete)}
            title={t('settings.customize.shortcut.delete', 'Delete shortcut')}
            aria-label={t('settings.customize.shortcut.delete', 'Delete shortcut')}
            onClick={() => onDisable(r.id)}
          >
            <Icon name="trash" size="sm" />
          </button>
        ) : null}
      </div>
    </div>
  );
});

/** Exported so its empty state can be asserted without opening the modal. */
export function ShortcutsTab(): JSX.Element {
  // Bumped after every rebind/reset; the one input the rows depend on that is
  // not React state (the overrides live in persisted settings).
  const [version, setVersion] = useState(0);
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ id: string; withId: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  // Typing stays responsive: the list filters at a lower priority than the input.
  const deferredQuery = useDeferredValue(searchQuery);

  // Registration and the registry snapshot happen once per mount, not on every
  // render (the registry is static outside the editor).
  const commands = useMemo(() => {
    ensureCommandsRegistered();
    return getCommandRegistry().all();
  }, []);

  const rows: Row[] = useMemo(() => {
    // Re-read only when an edit bumped `version`: this parses persisted
    // settings, and it used to run — and rebuild every row — on each keystroke.
    void version;
    const overrides = getShortcutOverrides();
    const out: Row[] = [];
    for (const c of commands) {
      if (!c.label) continue;
      const id = c.id as unknown as string;
      const chord = resolveChord(id, c.shortcut, overrides);
      out.push({
        id,
        label: commandLabel(c),
        chord,
        overridden: id in overrides,
        category: getCommandCategory(id, c.label),
        // English stays searchable alongside the translation.
        haystack: `${commandLabel(c)}\n${c.label}\n${id}\n${chord ? formatChord(chord) : ''}`.toLowerCase(),
      });
    }
    return out;
  }, [commands, version]);

  const labels = useMemo(() => new Map(rows.map((r) => [r.id, r.label] as const)), [rows]);

  // Read by the key listener at the moment a chord is recorded, so the
  // callbacks below stay stable and the memoised rows are not re-rendered.
  const resolved = useMemo(() => rows.map((r) => ({ commandId: r.id, chord: r.chord })), [rows]);
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  const bump = useCallback(() => setVersion((n) => n + 1), []);

  const beginRecord = useCallback((id: string): void => {
    setConflict(null);
    setRecording(id);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (isModifierKey(e.key)) return;
      window.removeEventListener('keydown', onKey, true);
      setRecording(null);
      if (e.key === 'Escape') return;
      const chord = chordFromEvent(e);
      const clash = findChordConflict(chord, id, resolvedRef.current);
      if (clash) {
        setConflict({ id, withId: clash });
        return;
      }
      setShortcutOverride(id, chord);
      getShortcutManager().applyOverrides();
      bump();
    };
    window.addEventListener('keydown', onKey, true);
  }, [bump]);

  const disable = useCallback((id: string): void => {
    setShortcutOverride(id, null);
    getShortcutManager().applyOverrides();
    bump();
  }, [bump]);

  const reset = useCallback((id: string): void => {
    clearShortcutOverride(id);
    getShortcutManager().applyOverrides();
    bump();
  }, [bump]);

  const resetAll = (): void => {
    clearAllShortcutOverrides();
    getShortcutManager().applyOverrides();
    setConflict(null);
    bump();
  };

  const filteredRows = useMemo(() => {
    const q = deferredQuery.toLowerCase().trim();
    return rows.filter(
      (r) => (activeCategory === 'all' || r.category.key === activeCategory) && (!q || r.haystack.includes(q)),
    );
  }, [rows, deferredQuery, activeCategory]);

  // First screenful now, the rest right after: opening Preferences paints a
  // page of rows immediately instead of blocking on all ~260, and the rest
  // mount in a transition the browser can interrupt.
  const [allRows, setAllRows] = useState(false);
  useEffect(() => {
    startTransition(() => setAllRows(true));
  }, []);
  const shownRows = allRows ? filteredRows : filteredRows.slice(0, FIRST_PAINT_ROWS);

  return (
    <div className={styles.tabBody}>
      <div className={styles.shortcutsToolbar}>
        <div className={styles.shortcutsSearchRow}>
          <SearchField
            className={styles.searchBox}
            size="md"
            placeholder={t('settings.customize.shortcuts.searchPlaceholder', 'Search by command name, action, or shortcut key…')}
            ariaLabel={t('settings.customize.shortcuts.searchAria', 'Search shortcuts')}
            value={searchQuery}
            resultCount={searchQuery ? `${filteredRows.length}` : undefined}
            onChange={setSearchQuery}
          />

          <Button variant="ghost" size="sm" onClick={resetAll} title={t('settings.customize.shortcuts.resetAllTitle', 'Reset all custom shortcuts to factory defaults')}>
            <Icon name="refresh" size="sm" />
            <span>{t('settings.customize.shortcuts.resetAll', 'Reset All')}</span>
          </Button>
        </div>

        <div className={styles.categoryChips}>
          {categories().map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={cn(styles.categoryChip, activeCategory === cat.id && styles.categoryChipActive)}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.shortcutsContainer}>
        <div className={styles.tableHeader}>
          <span className={styles.colCommand}>{t('settings.customize.shortcuts.colCommand', 'Command Action')}</span>
          <span className={styles.colCategory}>{t('settings.customize.shortcuts.colCategory', 'Category')}</span>
          <span className={styles.colKey}>{t('settings.customize.shortcuts.colKey', 'Shortcut Binding')}</span>
          <span className={styles.colActions}>{t('settings.customize.shortcuts.colActions', 'Actions')}</span>
        </div>

        <div className={styles.shortcutsList}>
          {filteredRows.length === 0 ? (
            <EmptyState
              icon="search"
              title={t('settings.customize.shortcuts.emptyTitle', 'No matching shortcuts found')}
              message={t('settings.customize.shortcuts.emptyMessage', 'Try a different search query or category filter.')}
              action={
                searchQuery || activeCategory !== 'all'
                  ? { label: t('settings.customize.shortcuts.clearFilters', 'Clear filters'), onClick: () => { setSearchQuery(''); setActiveCategory('all'); } }
                  : undefined
              }
            />
          ) : (
            shownRows.map((r) => (
              <ShortcutRow
                key={r.id}
                row={r}
                recording={recording === r.id}
                conflictWith={conflict?.id === r.id ? (labels.get(conflict.withId) ?? conflict.withId) : null}
                onRecord={beginRecord}
                onReset={reset}
                onDisable={disable}
              />
            ))
          )}
        </div>
      </div>

      <div className={styles.shortcutsFooter}>
        <span className={styles.hint}>
          {t(
            'settings.customize.shortcuts.footer',
            'Showing {shown} of {total} commands. Click any shortcut chip to record a new key combination.',
            { shown: filteredRows.length, total: rows.length },
          )}
        </span>
      </div>
    </div>
  );
}

export function WorkspacesTab(): JSX.Element {
  const [, force] = useState(0);
  const [name, setName] = useState('');
  const manager = getWorkspaceManager();
  const layouts = manager.listWorkspaces();
  let currentWorkspaceId = 'default';
  try {
    currentWorkspaceId = getSettingsManager().get<string>('workspace.activeId', 'default');
  } catch {
    currentWorkspaceId = 'default';
  }

  const save = (): void => {
    const n = name.trim();
    if (!n) return;
    manager.saveCurrentWorkspace(n);
    setName('');
    force((v) => v + 1);
  };

  const remove = (id: string): void => {
    manager.deleteWorkspace(id);
    force((v) => v + 1);
  };

  return (
    <div className={styles.tabBody}>
      <div className={styles.workspaceHeader}>
        <div>
          <h4 className={styles.subHeading}>{t('settings.customize.workspaces.title', 'Workspace Layout Presets')}</h4>
          <p className={styles.hint}>
            {t('settings.customize.workspaces.hint', 'Switch between tailored multi-dock layouts or save your current screen arrangement.')}
          </p>
        </div>
      </div>

      <div className={styles.workspaceGrid}>
        {layouts.map((l) => {
          const isActive = l.id === currentWorkspaceId;
          return (
            <div key={l.id} className={cn(styles.workspaceCard, isActive && styles.workspaceCardActive)}>
              <div className={styles.workspaceCardHeader}>
                <div className={styles.workspaceCardIcon}>
                  <Icon name="layout" size="md" />
                </div>
                <div className={styles.workspaceCardMeta}>
                  <div className={styles.workspaceCardTitleRow}>
                    <span className={styles.workspaceCardName}>{l.name}</span>
                    {l.builtin ? (
                      <span className={styles.badge}>{t('settings.customize.workspaces.preset', 'Preset')}</span>
                    ) : (
                      <span className={cn(styles.badge, styles.customBadge)}>{t('settings.customize.workspaces.custom', 'Custom')}</span>
                    )}
                  </div>
                  <span className={styles.workspaceCardSub}>
                    {isActive
                      ? t('settings.customize.workspaces.activeSub', 'Currently active arrangement')
                      : t('settings.customize.workspaces.savedSub', 'Saved docking layout')}
                  </span>
                </div>
              </div>

              <div className={styles.workspaceCardActions}>
                <Button
                  variant={isActive ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => {
                    manager.applyWorkspace(l.id);
                    force((v) => v + 1);
                  }}
                >
                  {isActive ? t('settings.customize.workspaces.active', 'Active') : t('settings.customize.workspaces.apply', 'Apply Layout')}
                </Button>
                {!l.builtin && (
                  <button
                    type="button"
                    className={styles.rowActionBtn}
                    title={t('settings.customize.workspaces.deleteTitle', 'Delete “{name}”', { name: l.name })}
                    aria-label={t('settings.customize.workspaces.deleteAria', 'Delete {name}', { name: l.name })}
                    onClick={() => remove(l.id)}
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.saveWorkspaceCard}>
        <div className={styles.saveWorkspaceMeta}>
          <span className={styles.saveWorkspaceTitle}>{t('settings.customize.workspaces.saveTitle', 'Save Current Layout as Preset')}</span>
          <span className={styles.hint}>{t('settings.customize.workspaces.saveHint', 'Capture the exact sizes and dock positions of your open panels.')}</span>
        </div>
        <div className={styles.saveRow}>
          <Input
            value={name}
            placeholder={t('settings.customize.workspaces.namePlaceholder', 'e.g. Dual Monitor Animation, Color Grading…')}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) save();
            }}
          />
          <Button variant="primary" size="sm" onClick={save} disabled={!name.trim()}>
            <Icon name="plus" size="sm" />
            <span>{t('settings.customize.workspaces.save', 'Save Preset')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The accent the active theme is currently painting with, read from the token. */
function themeAccentColor(): string {
  if (typeof window === 'undefined') return '#2988ff';
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-primary')
    .trim();
  return v || '#2988ff';
}

export function AppearanceTab(): JSX.Element {
  const [accent, setAccent] = useState<string>(() => getAccentColor());
  const applyAccent = (c: string): void => { setAccent(c); setAccentColor(c); };

  const uiScale = usePreferenceStore((s) => s.uiScale ?? 1);
  const buttonSize = usePreferenceStore((s) => s.buttonSize ?? 'md');
  const iconSize = usePreferenceStore((s) => s.iconSize ?? 'md');
  const density = usePreferenceStore((s) => s.density ?? 'default');
  const footageLayerOpens = usePreferenceStore((s) => s.footageLayerOpens ?? 'layer');
  const compLayerOpens = usePreferenceStore((s) => s.compLayerOpens ?? 'nested');
  const highContrast = usePreferenceStore((s) => s.highContrast);
  const reduceMotion = usePreferenceStore((s) => s.editorReduceMotion);
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const confirmOnClose = usePreferenceStore((s) => s.confirmOnClose);
  const retainOriginalSvg = usePreferenceStore((s) => s.retainOriginalSvg);
  const shareUsageData = usePreferenceStore((s) => s.shareUsageData);
  const setPref = usePreferenceStore((s) => s.set);

  const leftSidebarPos = useLayoutStore((s) => s.leftSidebarPosition);
  const rightInspectorPos = useLayoutStore((s) => s.rightInspectorPosition);
  const timelinePos = useLayoutStore((s) => s.timelinePosition);

  const leftSidebarWidth = useLayoutStore((s) => s.regions.leftSidebar?.size ?? 340);
  const setRegionSize = useLayoutStore((s) => s.setRegionSize);

  const setLeftSidebarPos = useLayoutStore((s) => s.setLeftSidebarPosition);
  const setRightInspectorPos = useLayoutStore((s) => s.setRightInspectorPosition);
  const setTimelinePos = useLayoutStore((s) => s.setTimelinePosition);

  const ACCENT_PRESETS = [
    { name: t('settings.customize.accent.studioBlue', 'Studio Blue'), color: '#2988ff' },
    { name: t('settings.customize.accent.cyberViolet', 'Cyber Violet'), color: '#8b5cf6' },
    { name: t('settings.customize.accent.emerald', 'Emerald'), color: '#10b981' },
    { name: t('settings.customize.accent.coral', 'Coral'), color: '#f97316' },
    { name: t('settings.customize.accent.rose', 'Rose'), color: '#f43f5e' },
    { name: t('settings.customize.accent.amber', 'Amber'), color: '#f59e0b' },
    { name: t('settings.customize.accent.cyan', 'Cyan'), color: '#06b6d4' },
  ];

  return (
    <div className={styles.appearanceScroll}>
      <LanguageSetting />

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t('settings.customize.theme.title', 'Theme & Brand Accent')}</span>
          <span className={styles.hint}>{t('settings.customize.theme.hint', 'Choose the studio accent highlight and light/dark interface mode.')}</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.accentColor.title', 'Accent Color')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.accentColor.desc', 'Controls focus rings, active keyframe markers, and selection bounding boxes.')}</span>
            </div>
            <div className={styles.accentPickerWrap}>
              <div className={styles.presetSwatches}>
                {ACCENT_PRESETS.map((p) => {
                  const isCur = (accent || themeAccentColor()).toLowerCase() === p.color.toLowerCase();
                  return (
                    <button
                      key={p.color}
                      type="button"
                      className={cn(styles.colorSwatch, isCur && styles.colorSwatchActive)}
                      style={{ backgroundColor: p.color }}
                      title={p.name}
                      onClick={() => applyAccent(p.color)}
                    />
                  );
                })}
              </div>
              <ColorPicker value={accent || themeAccentColor()} onChange={applyAccent} aria-label={t('settings.customize.accentColor.aria', 'Accent color')} />
              {accent ? (
                <Button variant="ghost" size="sm" onClick={() => applyAccent('')}>
                  {t('settings.customize.reset', 'Reset')}
                </Button>
              ) : null}
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.interfaceTheme.title', 'Interface Theme')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.interfaceTheme.desc', 'Toggle between the dark studio theme and the light theme.')}</span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => getThemeManager().toggle()}>
              <Icon name="theme" size="sm" />
              <span>{t('settings.customize.interfaceTheme.toggle', 'Toggle Dark / Light')}</span>
            </Button>
          </div>

          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.highContrast.title', 'High Contrast')}</span>
              <span className={styles.settingDesc}>
                {t(
                  'settings.customize.highContrast.desc',
                  'Black ground, white text, visible borders and a thicker focus ring. Follows the OS automatically when the theme is set to System.',
                )}
              </span>
            </div>
            <Switch
              checked={highContrast}
              onChange={(e) => setPref('highContrast', e.target.checked)}
              aria-label={t('settings.customize.highContrast.aria', 'High contrast theme')}
            />
          </div>
        </div>
      </div>

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t('settings.customize.dock.title', 'Dock & Panel Alignment')}</span>
          <span className={styles.hint}>{t('settings.customize.dock.hint', 'Configure which edge each studio dock pane attaches to.')}</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.leftSidebar.title', 'Left Sidebar Position')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.leftSidebar.desc', 'Attach Project, Library, and Scene panels to the left or right edge.')}</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, leftSidebarPos === 'left' && styles.segItemActive)}
                onClick={() => setLeftSidebarPos('left')}
              >
                {t('settings.customize.side.left', 'Left')}
              </button>
              <button
                type="button"
                className={cn(styles.segItem, leftSidebarPos === 'right' && styles.segItemActive)}
                onClick={() => setLeftSidebarPos('right')}
              >
                {t('settings.customize.side.right', 'Right')}
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.inspector.title', 'Inspector Position')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.inspector.desc', 'Attach Properties and Effects inspectors to the right or left edge.')}</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, rightInspectorPos === 'left' && styles.segItemActive)}
                onClick={() => setRightInspectorPos('left')}
              >
                {t('settings.customize.side.left', 'Left')}
              </button>
              <button
                type="button"
                className={cn(styles.segItem, rightInspectorPos === 'right' && styles.segItemActive)}
                onClick={() => setRightInspectorPos('right')}
              >
                {t('settings.customize.side.right', 'Right')}
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.timeline.title', 'Timeline Position')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.timeline.desc', 'Position the layer tracks and graph editor at the bottom or top.')}</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, timelinePos === 'bottom' && styles.segItemActive)}
                onClick={() => setTimelinePos('bottom')}
              >
                {t('settings.customize.side.bottom', 'Bottom')}
              </button>
              <button
                type="button"
                className={cn(styles.segItem, timelinePos === 'top' && styles.segItemActive)}
                onClick={() => setTimelinePos('top')}
              >
                {t('settings.customize.side.top', 'Top')}
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.sidebarWidth.title', 'Default Sidebar Width')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.sidebarWidth.desc', 'Base width for project and layer inspector sidebars.')}</span>
            </div>
            <div className={styles.sliderWrap}>
              <input
                type="range"
                min={260}
                max={540}
                step={10}
                value={leftSidebarWidth}
                onChange={(e) => setRegionSize('leftSidebar', Number(e.target.value))}
                aria-label={t('settings.customize.sidebarWidth.aria', 'Left sidebar width resizer')}
                className={styles.rangeInput}
              />
              <span className={styles.rangeVal}>{leftSidebarWidth}px</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRegionSize('leftSidebar', 340)}
                disabled={leftSidebarWidth === 340}
              >
                {t('settings.customize.reset', 'Reset')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t('settings.customize.scale.title', 'Scale & Control Sizing')}</span>
          <span className={styles.hint}>{t('settings.customize.scale.hint', 'Fine-tune icon scales, button targets, and whole-canvas zoom.')}</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.uiScale.title', 'Interface Zoom Scale')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.uiScale.desc', 'Scales the entire application typography, dialogs, and controls.')}</span>
            </div>
            <div className={styles.sliderWrap}>
              <input
                type="range"
                min={75}
                max={150}
                step={5}
                value={Math.round(uiScale * 100)}
                onChange={(e) => setPref('uiScale', Number(e.target.value) / 100)}
                aria-label={t('settings.customize.uiScale.aria', 'Interface scale')}
                className={styles.rangeInput}
              />
              <span className={styles.rangeVal}>{Math.round(uiScale * 100)}%</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPref('uiScale', 1)}
                disabled={uiScale === 1}
              >
                {t('settings.customize.reset', 'Reset')}
              </Button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.buttonSize.title', 'Button Target Sizing')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.buttonSize.desc', 'Compact rows for precision density or larger targets for high-DPI displays.')}</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, buttonSize === 'sm' && styles.segItemActive)}
                onClick={() => setPref('buttonSize', 'sm')}
              >
                {t('settings.customize.size.small', 'Small')}
              </button>
              <button
                type="button"
                className={cn(styles.segItem, buttonSize === 'md' && styles.segItemActive)}
                onClick={() => setPref('buttonSize', 'md')}
              >
                {t('settings.customize.size.medium', 'Medium')}
              </button>
              <button
                type="button"
                className={cn(styles.segItem, buttonSize === 'lg' && styles.segItemActive)}
                onClick={() => setPref('buttonSize', 'lg')}
              >
                {t('settings.customize.size.large', 'Large')}
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.iconSize.title', 'Toolbar Icon Scale')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.iconSize.desc', 'Scales tool selector and timeline track control glyphs.')}</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, iconSize === 'sm' && styles.segItemActive)}
                onClick={() => setPref('iconSize', 'sm')}
              >
                {t('settings.customize.size.small', 'Small')}
              </button>
              <button
                type="button"
                className={cn(styles.segItem, iconSize === 'md' && styles.segItemActive)}
                onClick={() => setPref('iconSize', 'md')}
              >
                {t('settings.customize.size.medium', 'Medium')}
              </button>
              <button
                type="button"
                className={cn(styles.segItem, iconSize === 'lg' && styles.segItemActive)}
                onClick={() => setPref('iconSize', 'lg')}
              >
                {t('settings.customize.size.large', 'Large')}
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.density.title', 'Interface Density')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.density.desc', 'Row height, control height, label size and panel padding, together.')}</span>
            </div>
            <div className={styles.segmented} role="radiogroup" aria-label={t('settings.customize.density.aria', 'Interface density')}>
              <button
                type="button"
                role="radio"
                aria-checked={density === 'compact'}
                className={cn(styles.segItem, density === 'compact' && styles.segItemActive)}
                onClick={() => setPref('density', 'compact')}
              >
                {t('settings.customize.density.compact', 'Compact')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={density === 'default'}
                className={cn(styles.segItem, density === 'default' && styles.segItemActive)}
                onClick={() => setPref('density', 'default')}
              >
                {t('settings.customize.density.default', 'Default')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={density === 'comfortable'}
                className={cn(styles.segItem, density === 'comfortable' && styles.segItemActive)}
                onClick={() => setPref('density', 'comfortable')}
              >
                {t('settings.customize.density.comfortable', 'Comfortable')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t('settings.customize.doubleClick.title', 'Opening Layers with Double-Click')}</span>
          <span className={styles.hint}>{t('settings.customize.doubleClick.hint', 'What a double-click on a layer opens, as in After Effects. Alt+double-click opens the other one.')}</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.footageOpens.title', 'Footage Layer Opens')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.footageOpens.desc', 'Video, image, vector and solid layers. With a paint or Roto tool it is always the Layer panel.')}</span>
            </div>
            <div className={styles.segmented} role="radiogroup" aria-label={t('settings.customize.footageOpens.aria', 'Footage layer opens')}>
              <button
                type="button"
                role="radio"
                aria-checked={footageLayerOpens === 'layer'}
                className={cn(styles.segItem, footageLayerOpens === 'layer' && styles.segItemActive)}
                onClick={() => setPref('footageLayerOpens', 'layer')}
              >
                {t('settings.customize.opens.layerPanel', 'Layer Panel')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={footageLayerOpens === 'source'}
                className={cn(styles.segItem, footageLayerOpens === 'source' && styles.segItemActive)}
                onClick={() => setPref('footageLayerOpens', 'source')}
              >
                {t('settings.customize.opens.sourceFootage', 'Source Footage')}
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.compOpens.title', 'Composition Layer Opens')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.compOpens.desc', 'A composition placed as a layer (a pre-comp).')}</span>
            </div>
            <div className={styles.segmented} role="radiogroup" aria-label={t('settings.customize.compOpens.aria', 'Composition layer opens')}>
              <button
                type="button"
                role="radio"
                aria-checked={compLayerOpens === 'nested'}
                className={cn(styles.segItem, compLayerOpens === 'nested' && styles.segItemActive)}
                onClick={() => setPref('compLayerOpens', 'nested')}
              >
                {t('settings.customize.opens.nested', 'Nested Composition')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={compLayerOpens === 'layer'}
                className={cn(styles.segItem, compLayerOpens === 'layer' && styles.segItemActive)}
                onClick={() => setPref('compLayerOpens', 'layer')}
              >
                {t('settings.customize.opens.layerPanel', 'Layer Panel')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t('settings.customize.behaviors.title', 'Editor Behaviors & Safeguards')}</span>
          <span className={styles.hint}>{t('settings.customize.behaviors.hint', 'Animation automation, motion comfort, and safety prompts.')}</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.autoKeyframe.title', 'Auto-Keyframe Recording')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.autoKeyframe.desc', 'Automatically record a keyframe whenever a property changes while the playhead is parked.')}</span>
            </div>
            <Switch
              checked={autoKeyframe}
              onChange={(e) => setPref('timelineAutoKeyframe', e.target.checked)}
              aria-label={t('settings.customize.autoKeyframe.aria', 'Auto-keyframe recording')}
            />
          </div>

          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.confirmOnClose.title', 'Confirm Unsaved Changes on Exit')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.confirmOnClose.desc', 'Prompt for confirmation before New, Open, or Close discards project edits.')}</span>
            </div>
            <Switch
              checked={confirmOnClose}
              onChange={(e) => setPref('confirmOnClose', e.target.checked)}
              aria-label={t('settings.customize.confirmOnClose.aria', 'Confirm before discarding unsaved changes')}
            />
          </div>

          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.reduceMotion.title', 'Reduce UI Motion & Transitions')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.reduceMotion.desc', 'Disables non-essential panel animations and transitions (viewport playback unaffected).')}</span>
            </div>
            <Switch
              checked={reduceMotion}
              onChange={(e) => setPref('editorReduceMotion', e.target.checked)}
              aria-label={t('settings.customize.reduceMotion.aria', 'Reduce UI motion')}
            />
          </div>

          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.retainSvg.title', 'Retain Original Vector SVG Sources')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.retainSvg.desc', 'Preserve vector XML structures when importing complex SVG assets.')}</span>
            </div>
            <Switch
              checked={retainOriginalSvg}
              onChange={(e) => setPref('retainOriginalSvg', e.target.checked)}
              aria-label={t('settings.customize.retainSvg.aria', 'Retain original SVG sources')}
            />
          </div>
        </div>
      </div>

      <PerformanceSettingsSection />

      <ExportSettingsSection />

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t('settings.customize.storage.title', 'Storage, Cache & Intelligence')}</span>
          <span className={styles.hint}>{t('settings.customize.storage.hint', 'Manage the preview and disk caches and optional neural segmentation models.')}</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.previewCache.title', 'Preview Frame Cache')}</span>
              <span className={styles.settingDesc}>
                {t(
                  'settings.customize.previewCache.desc',
                  "Rendered frames the engine keeps in video memory, so playback and scrubbing do not draw them twice. Its size follows the graphics card's memory.",
                )}
              </span>
            </div>
            <div className={styles.settingRight}>
              <PreviewCacheControl />
            </div>
          </div>

          <DiskCacheSettings />

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.videoExport.title', 'Video Export')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.videoExport.desc', 'FFmpeg, which writes MP4, WebM, MOV and GIF files. Built in; repair or replace it here.')}</span>
            </div>
            <div className={styles.settingRight}>
              <VideoExportControl />
            </div>
          </div>

          <div className={cn(styles.settingRow, styles.settingRowWide)}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.objectMatte.title', 'AI Object Matte Model')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.objectMatte.desc', 'Local neural model powering one-click Roto subject selection.')}</span>
            </div>
            <div className={styles.settingRight}>
              <ObjectMatteControl />
            </div>
          </div>

          <div className={cn(styles.settingRow, styles.settingRowWide)}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.customize.faceModel.title', 'Face Tracking Model')}</span>
              <span className={styles.settingDesc}>{t('settings.customize.faceModel.desc', 'Face landmarks for the Tracker’s Face tracking (downloaded once, kept on this computer).')}</span>
            </div>
            <div className={styles.settingRight}>
              <FaceModelControl />
            </div>
          </div>

          {isServerEdition() && (
            <div className={styles.switchRow}>
              <div className={styles.settingInfo}>
                <span className={styles.settingTitle}>{t('settings.customize.shareUsage.title', 'Share Usage Data')}</span>
                <span className={styles.settingDesc}>
                  {t(
                    'settings.customize.shareUsage.desc',
                    'Tells us which features you use and what goes wrong — for example “exported an MP4” or “an import failed”. Never your projects, file names, text or media.',
                  )}
                </span>
              </div>
              <Switch
                checked={shareUsageData !== false}
                onChange={(e) => setPref('shareUsageData', e.target.checked)}
                aria-label={t('settings.customize.shareUsage.aria', 'Share usage data')}
              />
            </div>
          )}

          <UpdatesControl />
        </div>
      </div>
    </div>
  );
}


/**
 * The preview cache: what the engine holds, and the way to empty it.
 *
 * The cache is the engine's — the frames it has drawn, kept in video memory
 * and evicted least-recently-used at a budget it sizes from the graphics
 * adapter. The readout is `getCacheCoverage` (polled only while this row is
 * mounted); the button is `purgeCache { kind: 'ram' }`.
 *
 * No "Limit" field yet: the VRAM budget follows the adapter, and the RAM tier
 * sizes itself (half of physical memory, shrinking under memory pressure). The
 * engine does honour `setCacheBudget`'s `ramMegabytes` (Session → RenderThread
 * configure_ram_cache), but diskCacheSync.ts always sends 0, so a RAM limit row
 * is a UI gap, not an engine one. The disk tier's settings are the rows below
 * it, DiskCacheSettings.tsx.
 */
function PreviewCacheControl(): JSX.Element {
  const cache = useSyncExternalStore(subscribeEngineCache, engineCacheSnapshot);
  const MB = 1024 * 1024;
  return (
    <div className={styles.cacheControlWrap}>
      <span className={styles.cacheSizeReadout}>
        {t('settings.customize.previewCache.readout', '{size} video memory', { size: formatCacheMb(cache.ramBytes / MB) })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={cache.ramBytes <= 0}
        onClick={() => {
          // The frame cache only (`ram`), never `all`: that kind also names the
          // undo history. Frames are drawn again as the playhead reaches them;
          // the readout follows on its next poll.
          void engine().execute({ type: 'purgeCache', kind: 'ram' });
        }}
      >
        <Icon name="trash" size="sm" />
        <span>{t('settings.customize.previewCache.empty', 'Empty Cache')}</span>
      </Button>
    </div>
  );
}

export function Customize({ initialTab = 'shortcuts' }: { initialTab?: Tab }): JSX.Element {
  const tabs = tabsForEdition();
  const [tab, setTab] = useState<Tab>(
    tabs.some((tb) => tb.id === initialTab) ? initialTab : 'shortcuts',
  );

  return (
    <div className={styles.root}>
      <div className={styles.tabsWrap} role="tablist">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            role="tab"
            aria-selected={tab === tb.id}
            className={cn(styles.tabBtn, tab === tb.id && styles.tabBtnActive)}
            onClick={() => setTab(tb.id)}
          >
            <Icon name={tb.icon} size="sm" />
            <span>{tb.label}</span>
          </button>
        ))}
      </div>

      <div className={styles.contentWrap}>
        {tab === 'shortcuts' ? (
          <ShortcutsTab />
        ) : tab === 'tabs' ? (
          <WorkspacesTab />
        ) : tab === 'audio' ? (
          <AudioHardwareSection />
        ) : tab === 'files' ? (
          <FilesTab />
        ) : tab === 'ai' ? (
          <div className={styles.section}>
            <AiSettingsSection />
            <ClaudeConnectSection />
            <McpAppsSection />
          </div>
        ) : (
          <AppearanceTab />
        )}
      </div>
    </div>
  );
}

// `openCustomizeDialog` / `openAiSettings` live in ./openCustomizeDialog.tsx:
// a module that exports components AND plain functions cannot Fast Refresh,
// and every edit anywhere upstream then invalidated this file, its importers
// (Providers, TopNav, the title bar, the AI chat) and back again — Vite's
// client looped in `importUpdatedModule` until the page was unusable.
