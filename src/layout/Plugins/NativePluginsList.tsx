/**
 * The native SDK plugins the engine found, with the folder they live in.
 *
 * The dashboard's Plugins page (the editor's Plugins panel draws its own
 * AE-style tree, NativePluginsPanel.tsx). The
 * list is the engine's `listPlugins` answer, verbatim: every plugin it saw in
 * the folder, loaded or not — a failed one shows why, so "I copied it in and
 * nothing happened" has an answer on screen.
 */

import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Switch } from '@components/Switch';
import { useNativePlugins } from '@hooks/useNativePlugins';
import type { InstalledState } from '@hooks/usePluginStore';
import {
  canOpenNativePluginFolder,
  nativePluginStatusLabel,
  openNativePluginFolder,
  type NativePlugin,
} from '@core/nativePlugins/nativePlugins';
import styles from './NativePlugins.module.css';
import { t } from '@core/i18n';

function statusClass(status: NativePlugin['status']): string | undefined {
  if (status === 'loaded') return styles.statusLoaded;
  if (status === 'failed' || status === 'quarantined' || status === 'revoked' || status === 'locked') return styles.statusFailed;
  return styles.status;
}

/** Enable, update, uninstall — for a plugin row, when the store is available. */
function RowActions({ plugin, store }: { plugin: NativePlugin; store: InstalledState }): JSX.Element {
  const mine = store.installed?.plugins[plugin.id];
  const queued = store.installed?.uninstall.includes(plugin.id) ?? false;
  const update = store.updates.get(plugin.id);
  const busy = store.busy !== null;
  if (queued) return <span className={styles.status}>{t('plugins.list.removedOnRestart', 'Removed on restart')}</span>;
  return (
    <div className={styles.rowActions}>
      {update ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void store.install(plugin.id, update.latestVersion)}>
          {t('plugins.list.updateTo', 'Update to {version}', { version: update.latestVersion })}
        </Button>
      ) : null}
      {plugin.status === 'locked' ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void store.checkPlan()}>
          {t('plugins.list.checkPlan', 'Check plan')}
        </Button>
      ) : null}
      {plugin.status !== 'revoked' && plugin.status !== 'locked' ? (
        <Switch
          checked={plugin.status !== 'disabled'}
          disabled={busy || plugin.status === 'failed'}
          onChange={(e) => void store.setEnabled(plugin.id, e.currentTarget.checked)}
          aria-label={t('plugins.list.enable', 'Enable {name}', { name: plugin.name || plugin.id })}
        />
      ) : null}
      {mine ? (
        <Button size="sm" variant="ghost" iconOnly icon={<Icon name="trash" size="sm" />} disabled={busy} onClick={() => void store.uninstall(plugin.id)}>
          {t('plugins.list.uninstall', 'Uninstall {name}', { name: plugin.name || plugin.id })}
        </Button>
      ) : null}
    </div>
  );
}

/** What an available update brings, from the publisher's release notes. */
function UpdateNotes({ notes }: { notes: Array<{ version: string; releaseNotes: string }> | undefined }): JSX.Element | null {
  const newest = notes?.[0];
  if (!notes || !newest) return null;
  return (
    <details className={styles.updateNotes}>
      <summary>{t('plugins.list.whatsNew', 'What\'s new in v{version}', { version: newest.version })}</summary>
      {notes.map((n) => (
        <div key={n.version} className={styles.markdown}>
          {notes.length > 1 ? <strong>v{n.version}</strong> : null}
          <ReactMarkdown>{n.releaseNotes}</ReactMarkdown>
        </div>
      ))}
    </details>
  );
}

export function NativePluginRows({
  plugins,
  store,
}: {
  plugins: readonly NativePlugin[];
  store?: InstalledState;
}): JSX.Element {
  if (plugins.length === 0) {
    return (
      <div className={styles.empty} role="status">
        <strong>{t('plugins.list.emptyTitle', 'No native plugins installed')}</strong>
        <span>{t('plugins.list.emptyText', 'Install one from the plugin store, or copy a plugin into the plugins folder.')}</span>
      </div>
    );
  }
  return (
    <ul className={styles.list} aria-label={t('plugins.list.installedTitle', 'Installed native plugins')}>
      {plugins.map((p) => (
        <li key={p.id} className={styles.row}>
          <Icon name="plugin" size="sm" className={styles.rowIcon} />
          <div className={styles.rowBody}>
            <span className={styles.rowName} title={p.name || p.id}>{p.name || p.id}</span>
            <span className={styles.rowMeta}>
              {[p.version && `v${p.version}`, p.vendor].filter(Boolean).join(' · ') || p.id}
            </span>
            {p.error ? <span className={styles.rowError}>{p.error}</span> : null}
            {store ? <UpdateNotes notes={store.updates.get(p.id)?.notes} /> : null}
          </div>
          <span className={statusClass(p.status)}>{nativePluginStatusLabel(p.status)}</span>
          {store ? <RowActions plugin={p} store={store} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** "Open plugins folder", with the error the OS gave when it could not. */
export function OpenPluginsFolderButton({ size = 'sm' }: { size?: 'sm' | 'md' }): JSX.Element | null {
  const [error, setError] = useState<string | null>(null);
  if (!canOpenNativePluginFolder()) return null;
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        leftIcon={<Icon name="folder-open" size="sm" />}
        onClick={() => {
          setError(null);
          void openNativePluginFolder().then(setError);
        }}
      >
        {t('plugins.list.openFolder', 'Open plugins folder')}
      </Button>
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
    </>
  );
}

export function NativePluginsList({
  compact = false,
  store,
  native,
  actions,
}: {
  compact?: boolean;
  store?: InstalledState;
  /** The engine list, when the owner already holds one (so an install refreshes both). */
  native?: ReturnType<typeof useNativePlugins>;
  /** The host's own controls, at the start of the toolbar row, before Refresh. */
  actions?: ReactNode;
}): JSX.Element {
  const own = useNativePlugins();
  const { plugins, error, loading, refresh } = native ?? own;
  const body = (
    <>
      <div className={styles.toolbar}>
        {!compact ? <h3 className={styles.cardTitle}>{t('plugins.list.installedTitle', 'Installed native plugins')}</h3> : null}
        {actions}
        <span className={styles.spacer} />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name="refresh" size="sm" />}
          disabled={loading}
          onClick={() => {
            refresh();
            store?.refresh();
          }}
        >
          {loading ? t('plugins.list.checking', 'Checking…') : t('plugins.list.refresh', 'Refresh')}
        </Button>
      </div>
      {error ? (
        <span className={styles.error} role="alert">{error}</span>
      ) : plugins ? (
        <NativePluginRows plugins={plugins} {...(store ? { store } : {})} />
      ) : (
        <span className={styles.text} role="status">{t('plugins.list.asking', 'Asking the engine…')}</span>
      )}
    </>
  );
  return compact ? body : <section className={styles.card} aria-label={t('plugins.list.installedTitle', 'Installed native plugins')}>{body}</section>;
}
