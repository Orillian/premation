/**
 * Settings → AI: Premation in Cursor, Antigravity and ChatGPT desktop.
 * The same local connection as Claude (electron/mcp/appConfigs.ts). Each app
 * keeps its own config file; Premation never hosts a remote endpoint.
 */

import { useCallback, useEffect, useState } from 'react';
import { BrandMark } from '@components/BrandMark';
import { Icon } from '@components/Icon';
import type { McpAppId, McpAppStatus } from '@app-types/motionEditor';
import { useClaudeStore } from '@stores/claudeStore';
import styles from './ClaudeConnectSection.module.css';

type Busy = { id: McpAppId; kind: 'connect' | 'disconnect' } | null;

function pillFor(app: McpAppStatus, listening: boolean): { label: string; tone: string | undefined } {
  if (app.state === 'malformed') return { label: 'Needs a look', tone: styles.pillWarn };
  if (app.state === 'stale') return { label: 'Needs repair', tone: styles.pillWarn };
  if (app.state === 'ok' && listening) return { label: 'Ready', tone: styles.pillReady };
  if (app.state === 'ok') return { label: 'Paused', tone: styles.pillOff };
  return { label: 'Not connected', tone: styles.pillOff };
}

export function McpAppsSection(): JSX.Element | null {
  const api = typeof window !== 'undefined' ? window.motionEditor?.mcp : undefined;
  const status = useClaudeStore((s) => s.setup);
  const setStatus = useClaudeStore((s) => s.setSetup);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<McpAppId | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (api) setStatus(await api.getStatus());
  }, [api, setStatus]);

  useEffect(() => {
    if (!status) void reload();
  }, [status, reload]);

  if (!api) return null;
  const apps = status?.apps ?? [];
  if (apps.length === 0) return null;

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* the text stays selectable */ }
  };

  const connect = (app: McpAppStatus): void => {
    setBusy({ id: app.id, kind: 'connect' });
    setError('');
    setNote('');
    void api.connectApp(app.id).then((r) => {
      setStatus(r.status);
      if (!r.ok) setError(r.code === 'malformed' ? `${r.message} Premation did not change it.` : r.message);
      else setNote(`${app.name}: ${app.restart}`);
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => setBusy(null));
  };

  const disconnect = (app: McpAppStatus): void => {
    setBusy({ id: app.id, kind: 'disconnect' });
    setError('');
    setNote('');
    void api.disconnectApp(app.id).then((r) => {
      setStatus(r.status);
      if (r.problems.length) setError(r.problems.join('; '));
      else setNote(`${app.name} no longer starts Premation. Restart ${app.name} to drop it from the tool list.`);
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => setBusy(null));
  };

  return (
    <section className={styles.card} aria-labelledby="mcp-apps-title">
      <header className={styles.head}>
        <div className={styles.headText}>
          <h3 id="mcp-apps-title" className={styles.title}>Cursor, Antigravity and ChatGPT</h3>
          <p className={styles.lede}>
            The same Premation connection as Claude. Each app gets its own local setup on this computer.
            Ask it to work in Premation the way you would ask Claude.
          </p>
        </div>
      </header>

      {status?.devBuild ? (
        <p className={styles.dev}>Development build: connecting here replaces an installed Premation in that app.</p>
      ) : null}

      {!status?.connectorInstalled ? (
        <p className={styles.error}>Premation’s connector is missing from this installation. Reinstall Premation.</p>
      ) : null}

      <ul className={styles.appList}>
        {apps.map((app) => {
          const listening = !!status?.bridge.enabled;
          const pill = pillFor(app, listening);
          const working = busy?.id === app.id;
          const installed = app.state === 'ok' || app.state === 'stale';
          return (
            <li key={app.id} className={styles.appRow}>
              <div className={styles.appHead}>
                <BrandMark brand={app.id} size={28} />
                <div className={styles.headText}>
                  <div className={styles.appName}>{app.name}</div>
                  <p className={styles.subtle}>{app.blurb}{app.present ? '' : ` ${app.name} has not been opened on this computer yet; Connect still writes its setup, and it picks Premation up on first launch.`}</p>
                </div>
                <span className={`${styles.pill} ${pill.tone}`}>{pill.label}</span>
              </div>
              {app.state === 'malformed' ? (
                <p className={styles.error}>
                  {app.configPath} could not be read. Premation will not change it. Add Premation by hand with the snippet below.
                </p>
              ) : null}
              <div className={styles.actions}>
                {app.state === 'stale' || (app.state === 'ok' && !listening) ? (
                  <button type="button" className={styles.primary} disabled={busy !== null || !status?.connectorInstalled} onClick={() => connect(app)}>
                    {working && busy?.kind === 'connect' ? 'Repairing…' : app.state === 'stale' ? 'Repair' : 'Turn on'}
                  </button>
                ) : null}
                {app.state === 'absent' || app.state === 'malformed' ? (
                  <button type="button" className={styles.primary} disabled={busy !== null || !status?.connectorInstalled || app.state === 'malformed'} onClick={() => connect(app)}>
                    {working && busy?.kind === 'connect' ? 'Connecting…' : `Connect ${app.name}`}
                  </button>
                ) : null}
                {installed ? (
                  <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => disconnect(app)}>
                    {working && busy?.kind === 'disconnect' ? 'Removing…' : 'Disconnect'}
                  </button>
                ) : null}
                <button type="button" className={styles.secondary} aria-expanded={open === app.id} onClick={() => setOpen(open === app.id ? null : app.id)}>
                  <Icon name={open === app.id ? 'chevron-down' : 'chevron-right'} size="sm" />
                  Setup details
                </button>
              </div>
              {open === app.id ? (
                <div className={styles.moreBody}>
                  <p className={styles.subtle}>{app.configPath}</p>
                  {app.command ? (
                    <div className={styles.codeRow}>
                      <code className={styles.code}>{app.command}</code>
                      <button type="button" className={styles.secondary} onClick={() => void copy(app.command)}>{copied === app.command ? 'Copied' : 'Copy'}</button>
                    </div>
                  ) : null}
                  <pre className={styles.code}>{app.snippet}</pre>
                  <button type="button" className={styles.secondary} onClick={() => void copy(app.snippet)}>{copied === app.snippet ? 'Copied' : 'Copy snippet'}</button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {note ? <p className={styles.note}>{note}</p> : null}
    </section>
  );
}
