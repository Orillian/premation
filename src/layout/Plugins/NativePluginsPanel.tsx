/**
 * The editor's Plugins panel, in AE's list-panel grammar
 * (docs/mockups/plugin-docking-ae.html, frame 4): a search field, a Name |
 * Status header, one twirl row per installed plugin and, under it, a dim meta
 * line, its effects (each with the presets it ships, one level in) and its
 * panels. A small button row at the foot: Browse Store, the plugins folder,
 * Refresh.
 *
 * Gestures, as Effects & Presets: a click selects a row; a double-click (or
 * Enter) applies an effect or preset to the selected layers, opens a panel, or
 * twirls a plugin; an effect row drags onto a layer. Up / Down move, Left /
 * Right collapse / expand. Right-click a plugin for Enable / Disable, Update,
 * Check plan, Show in Folder and Uninstall — nothing on a row is a button.
 *
 * Browsing the store and publishing live on the dashboard's Plugins page; a
 * plugin installed there shows here at once (the engine rescans).
 */

import { useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react';
import { Button } from '@components/Button';
import { Icon, type IconName } from '@components/Icon';
import { SearchField } from '@components/SearchField';
import { cloudProjectsEnabled } from '@core/config/edition';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { edit } from '@core/engine/uiEdits';
import {
  pluginEffectDefs,
  pluginEffectDefsRevision,
  subscribePluginEffectDefs,
} from '@core/inspector/pluginEffectDefs';
import { pluginContribRevision, pluginPanels, subscribePluginContrib } from '@core/nativePlugins/pluginContrib';
import { applyPluginPresetCommand, pluginPresets, subscribePluginPresets } from '@core/nativePlugins/pluginPresets';
import {
  canOpenNativePluginFolder,
  openNativePluginFolder,
  type NativePlugin,
} from '@core/nativePlugins/nativePlugins';
import { useNativePlugins } from '@hooks/useNativePlugins';
import { useInstalledPlugins, type InstalledState } from '@hooks/usePluginStore';
import { useAllEffectDefs } from '@layout/Effects/effectCatalog';
import { addEffectEdit } from '@layout/Effects/effectEdits';
import { revealAppliedEffects } from '@layout/Effects/revealEffectControls';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { cn } from '@utils/cn';
import {
  buildPluginPanelRows,
  isSelectableRow,
  parentRowIndex,
  type PluginPanelRow,
} from './pluginPanelRows';
import { StoreMessageLine } from './StoreMessageLine';
import styles from './NativePluginsPanel.module.css';
import { t } from '@core/i18n';


/** Every panel id docked on a side, as a set (the dock's `panelOrder`). */
function dockedSet(order: Readonly<Record<string, ReadonlyArray<string> | undefined>>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const list of Object.values(order)) for (const id of list ?? []) out.add(id);
  return out;
}

function selectedLayers(): ReadonlyArray<string> {
  return useSelectionStore.getState().ids;
}

function needLayer(): boolean {
  if (selectedLayers().length > 0) return false;
  useUIStore.getState().notify({ level: 'info', message: t('plugins.panel.selectLayerFirst', 'Select a layer first, then apply the effect again.'), durationMs: 3000 });
  return true;
}

/** The double-click / Enter action of a row. */
function activate(row: PluginPanelRow, toggle: (plugin: string) => void): void {
  switch (row.kind) {
    case 'plugin':
      toggle(row.plugin.id);
      return;
    case 'effect':
      if (needLayer()) return;
      void addEffectEdit(selectedLayers(), row.def.type);
      revealAppliedEffects();
      return;
    case 'preset':
      if (needLayer()) return;
      // One addEffect with the preset's values: one undo entry.
      void edit(`Apply ${row.preset.name}`, applyPluginPresetCommand(row.preset, selectedLayers()));
      revealAppliedEffects();
      return;
    case 'panel':
      useLayoutStore.getState().openPanel(row.entry.panelId);
      return;
    default:
  }
}

/** Right-click on a plugin row: what can be done to the plugin itself. */
function pluginMenuItems(plugin: NativePlugin, store: InstalledState): ContextMenuItem[] {
  const name = plugin.name || plugin.id;
  const mine = store.installed?.plugins[plugin.id];
  const queued = store.installed?.uninstall.includes(plugin.id) ?? false;
  const update = store.updates.get(plugin.id);
  const busy = store.busy !== null;
  const items: ContextMenuItem[] = [];
  if (plugin.status !== 'revoked' && plugin.status !== 'locked') {
    const enabled = plugin.status !== 'disabled';
    items.push({
      id: 'enable',
      label: enabled ? t('plugins.panel.disable', 'Disable') : t('plugins.panel.enable', 'Enable'),
      disabled: busy || plugin.status === 'failed',
      onSelect: () => void store.setEnabled(plugin.id, !enabled),
    });
  }
  if (update && !queued) {
    items.push({ id: 'update', label: t('plugins.list.updateTo', 'Update to {version}', { version: update.latestVersion }), disabled: busy, onSelect: () => void store.install(plugin.id, update.latestVersion) });
  }
  if (plugin.status === 'locked') {
    items.push({ id: 'plan', label: t('plugins.list.checkPlan', 'Check plan'), disabled: busy, onSelect: () => void store.checkPlan() });
  }
  if (canOpenNativePluginFolder()) {
    if (items.length > 0) items.push({ id: 'sep-folder', separator: true });
    items.push({ id: 'folder', label: t('plugins.panel.showInFolder', 'Show in Folder'), icon: 'folder-open', onSelect: () => void openNativePluginFolder() });
  }
  if (mine && !queued) {
    items.push(
      { id: 'sep-uninstall', separator: true },
      { id: 'uninstall', label: t('plugins.list.uninstall', 'Uninstall {name}', { name }), icon: 'trash', danger: true, disabled: busy, onSelect: () => void store.uninstall(plugin.id) },
    );
  }
  return items;
}

const ROW_ICON: Record<'effect' | 'preset' | 'panel', IconName> = {
  effect: 'magic-wand',
  preset: 'zap',
  panel: 'panel-right',
};

function rowLabel(row: PluginPanelRow): string {
  switch (row.kind) {
    case 'plugin': return row.plugin.name || row.plugin.id;
    case 'effect': return row.def.label;
    case 'preset': return row.preset.name;
    case 'panel': return row.entry.kind === 'effect' ? row.entry.pluginName : row.entry.panel.name;
    default: return row.text;
  }
}

function rowTitle(row: PluginPanelRow): string | undefined {
  switch (row.kind) {
    case 'effect':
      return t('plugins.panel.effectTitle', 'Double-click to apply {name} to the selected layers, or drag it onto a layer', { name: row.def.label });
    case 'preset':
      return t('plugins.panel.presetTitle', 'Double-click to apply the {effect} preset "{preset}" to the selected layers', {
        effect: row.effectLabel,
        preset: row.preset.name,
      });
    case 'panel':
      return row.docked
        ? t('plugins.panel.panelOpenTitle', '{name} is open — double-click to bring it forward', { name: rowLabel(row) })
        : t('plugins.panel.panelTitle', 'Double-click to open {name}', { name: rowLabel(row) });
    default: return undefined;
  }
}

function PluginRows({ plugins, store }: { plugins: readonly NativePlugin[]; store: InstalledState }): JSX.Element {
  useSyncExternalStore(subscribePluginEffectDefs, pluginEffectDefsRevision, pluginEffectDefsRevision);
  const presets = useSyncExternalStore(subscribePluginPresets, pluginPresets, pluginPresets);
  // The shell keeps the panel list fresh (usePluginPanels); the rows only re-read it.
  const contribRevision = useSyncExternalStore(subscribePluginContrib, pluginContribRevision, pluginContribRevision);
  const panelOrder = useLayoutStore((s) => s.panelOrder);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const effects = pluginEffectDefs();
  const docked = useMemo(() => dockedSet(panelOrder), [panelOrder]);
  const rows = useMemo(
    () => buildPluginPanelRows({
      plugins,
      effects,
      presets,
      panels: pluginPanels(),
      collapsed,
      docked,
      updates: new Map([...store.updates].map(([id, u]) => [id, u.latestVersion])),
      uninstalling: new Set(store.installed?.uninstall ?? []),
      query,
    }),
    // `pluginPanels()` is read through its revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugins, effects, presets, contribRevision, collapsed, docked, store.updates, store.installed, query],
  );

  const toggle = (plugin: string, open?: boolean): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const isOpen = !prev.has(plugin);
      if (open ?? !isOpen) next.delete(plugin);
      else next.add(plugin);
      return next;
    });
  };

  const selectedIndex = rows.findIndex((r) => r.id === selected);
  const domId = (i: number): string => `${baseId}-row-${i}`;

  const select = (i: number): void => {
    const row = rows[i];
    if (!row) return;
    setSelected(row.id);
    treeRef.current?.ownerDocument.getElementById(domId(i))?.scrollIntoView?.({ block: 'nearest' });
  };

  const step = (from: number, dir: 1 | -1): void => {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
      if (isSelectableRow(rows[i]!)) { select(i); return; }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const row = rows[selectedIndex];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(selectedIndex, 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (selectedIndex < 0) step(rows.length, -1);
        else step(selectedIndex, -1);
        return;
      case 'ArrowLeft': {
        if (!row) return;
        e.preventDefault();
        if (row.kind === 'plugin') {
          if (row.open && !query.trim()) toggle(row.plugin.id, false);
          return;
        }
        select(parentRowIndex(rows, selectedIndex));
        return;
      }
      case 'ArrowRight':
        if (row?.kind !== 'plugin') return;
        e.preventDefault();
        if (!row.open) toggle(row.plugin.id, true);
        else step(selectedIndex, 1);
        return;
      case 'Enter':
        if (!row) return;
        e.preventDefault();
        activate(row, (id) => toggle(id));
        return;
      default:
    }
  };

  const onContextMenu = (e: MouseEvent, row: PluginPanelRow): void => {
    if (row.kind !== 'plugin') return;
    e.preventDefault();
    setSelected(row.id);
    const items = pluginMenuItems(row.plugin, store);
    if (items.length > 0) openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <>
      <div className={styles.search}>
        <SearchField
          size="sm"
          fullWidth
          value={query}
          onChange={setQuery}
          placeholder={t('plugins.panel.search', 'Search installed plugins')}
          ariaLabel={t('plugins.panel.search', 'Search installed plugins')}
        />
      </div>
      <div className={styles.columns} aria-hidden>
        <span className={styles.columnName}>{t('plugins.panel.columnName', 'Name')}</span>
        <span className={styles.columnStatus}>{t('plugins.panel.columnStatus', 'Status')}</span>
      </div>
      <div
        ref={treeRef}
        className={styles.tree}
        role="tree"
        aria-label={t('plugins.panel.treeAria', 'Installed plugins')}
        tabIndex={0}
        aria-activedescendant={selectedIndex >= 0 ? domId(selectedIndex) : undefined}
        onKeyDown={onKeyDown}
      >
        {rows.length === 0 ? <p className={styles.empty} role="status">{t('plugins.panel.noMatch', 'No installed plugin matches “{query}”.', { query })}</p> : null}
        {rows.map((row, i) => {
          if (row.kind === 'meta' || row.kind === 'error') {
            return (
              <div key={row.id} className={row.kind === 'meta' ? styles.meta : styles.errorLine} role={row.kind === 'error' ? 'note' : undefined}>
                {row.text}
              </div>
            );
          }
          const level = row.kind === 'plugin' ? 1 : row.kind === 'preset' ? 3 : 2;
          const label = rowLabel(row);
          return (
            <div
              key={row.id}
              id={domId(i)}
              className={styles.row}
              data-level={level}
              data-selected={row.id === selected || undefined}
              role="treeitem"
              aria-level={level}
              aria-selected={row.id === selected}
              aria-expanded={row.kind === 'plugin' ? row.open : undefined}
              title={rowTitle(row)}
              draggable={row.kind === 'effect' || undefined}
              onDragStart={row.kind === 'effect' ? (e) => setCanvasDrag(e, { kind: 'effect', effectType: row.def.type }) : undefined}
              onClick={() => {
                setSelected(row.id);
                treeRef.current?.focus();
              }}
              onDoubleClick={() => activate(row, (id) => toggle(id))}
              onContextMenu={(e) => onContextMenu(e, row)}
            >
              {row.kind === 'plugin' ? (
                <span
                  className={styles.twirl}
                  aria-hidden
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(row.id);
                    if (!query.trim()) toggle(row.plugin.id);
                  }}
                >
                  <Icon name={row.open ? 'chevron-down' : 'chevron-right'} size="sm" />
                </span>
              ) : null}
              <Icon name={row.kind === 'plugin' ? 'plugin' : ROW_ICON[row.kind]} size="sm" className={styles.icon} />
              <span className={cn(styles.label, row.kind === 'panel' && row.docked && styles.labelOpen)}>{label}</span>
              {row.kind === 'plugin' ? (
                <span className={styles.status} data-tone={row.status.tone}>{row.status.text}</span>
              ) : (
                <span className={styles.kind}>
                  {row.kind === 'effect'
                    ? t('plugins.panel.kindEffect', 'Effect')
                    : row.kind === 'preset'
                      ? t('plugins.panel.kindPreset', 'Preset')
                      : row.docked
                        ? t('plugins.panel.kindPanelOpen', 'Panel · open')
                        : t('plugins.panel.kindPanel', 'Panel')}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function FootRow({ native, store }: { native: ReturnType<typeof useNativePlugins>; store: InstalledState }): JSX.Element {
  const [folderError, setFolderError] = useState<string | null>(null);
  return (
    <>
      {folderError ? <span className={styles.footError} role="alert">{folderError}</span> : null}
      <div className={styles.foot}>
        {/* The dashboard's Plugins page opens on its Store tab. Through the
            hash (AppRouter is a HashRouter) so this works outside a router;
            /dashboard exists only in the cloud edition. */}
        {cloudProjectsEnabled() ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Icon name="plugin" size="sm" />}
            onClick={() => { window.location.hash = '#/dashboard?tab=plugins'; }}
          >
            {t('plugins.panel.browseStore', 'Browse Store')}
          </Button>
        ) : null}
        <span className={styles.spacer} />
        {canOpenNativePluginFolder() ? (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="folder-open" size="sm" />}
            title={t('plugins.list.openFolder', 'Open plugins folder')}
            onClick={() => {
              setFolderError(null);
              void openNativePluginFolder().then(setFolderError);
            }}
          >
            {t('plugins.list.openFolder', 'Open plugins folder')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Icon name="refresh" size="sm" />}
          title={t('plugins.list.refresh', 'Refresh')}
          disabled={native.loading}
          onClick={() => {
            native.refresh();
            store.refresh();
          }}
        >
          {native.loading ? t('plugins.list.checking', 'Checking…') : t('plugins.list.refresh', 'Refresh')}
        </Button>
      </div>
    </>
  );
}

export function NativePluginsPanel(): JSX.Element {
  const native = useNativePlugins();
  const store = useInstalledPlugins(native.refresh);
  // Asks the engine for the plugins' effects and presets once (the rows read them).
  useAllEffectDefs();
  const { plugins, error } = native;
  return (
    <div className={styles.panel}>
      {error ? (
        <span className={styles.notice} role="alert">{error}</span>
      ) : !plugins ? (
        <span className={styles.notice} role="status">{t('plugins.list.asking', 'Asking the engine…')}</span>
      ) : plugins.length === 0 ? (
        <div className={styles.emptyState} role="status">
          <strong>{t('plugins.list.emptyTitle', 'No native plugins installed')}</strong>
          <span>{t('plugins.list.emptyText', 'Install one from the plugin store, or copy a plugin into the plugins folder.')}</span>
        </div>
      ) : (
        <PluginRows plugins={plugins} store={store} />
      )}
      {store.message ? (
        <div className={styles.messageLine}>
          <StoreMessageLine message={store.message} />
        </div>
      ) : null}
      <FootRow native={native} store={store} />
    </div>
  );
}
