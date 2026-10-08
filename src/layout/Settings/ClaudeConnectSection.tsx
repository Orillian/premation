/**
 * Settings → AI → Claude: connect Claude Desktop / Claude Code to Premation
 * (docs/MCP_PLAN.md §3.4).
 *
 * The user never sees "MCP". The card walks one path —
 *
 *   not installed → Get Claude
 *   ready         → Connect
 *   configured    → "restart Claude", Test, Disconnect
 *   connected     → which client, since when
 *   needs repair  → Repair (an update moved the app)
 *
 * — and keeps three states apart that are easy to blur: CONFIGURED (Claude's
 * config names Premation), LISTENING (Premation accepts connections) and
 * CONNECTED (a Claude is on the line right now). Only the last is "Connected".
 *
 * Gated on the paid plan (D8). The gate that matters runs on every tool call
 * (src/core/ai/mcp/mcpAccess.ts); this card only explains it up front.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { billingEnabled } from '@core/config/edition';
import { useEntitlementStore } from '@stores/entitlementStore';
import { useProSalesOpen } from '@hooks/useProSalesOpen';
import type { ClaudeSetupStatus, ClaudeTestStep } from '@app-types/motionEditor';
import styles from './ClaudeConnectSection.module.css';

const CAPABILITIES = [
  'Create compositions, layers and text',
  'Animate with keyframes and easing',
  'Add effects, cameras and lights',
  'Render frames and look at the result',
  'Build a whole designed piece from one request',
];

function since(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function ClaudeConnectSection(): JSX.Element | null {
  const api = typeof window !== 'undefined' ? window.motionEditor?.mcp : undefined;
  const [status, setStatus] = useState<ClaudeSetupStatus | null>(null);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'repair' | 'test' | 'enable' | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [steps, setSteps] = useState<ClaudeTestStep[] | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const access = useEntitlementStore((s) => s.access);
  const salesOpen = useProSalesOpen();

  const reload = useCallback(async () => {
    if (api) setStatus(await api.getStatus());
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    void reload();
    return api.onStatus(setStatus);
  }, [api, reload]);

  useEffect(() => {
    if (billingEnabled()) void useEntitlementStore.getState().refresh();
  }, []);

  // A browser build has no desktop app for Claude to reach.
  if (!api) return null;

  const needsPlan = billingEnabled() && access?.plan !== 'pro';

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    setError('');
    setNote('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const connect = (): Promise<void> => run('connect', async () => {
    const r = await api.connect();
    setStatus(r.status);
    if (!r.ok) {
      setError(r.code === 'malformed'
        ? `${r.message} Premation did not change it. Fix the file, or add Premation by hand with the snippet below.`
        : r.message);
      if (r.code === 'malformed') setShowCode(true);
      return;
    }
    setNote('Done. Quit Claude Desktop completely and open it again — Premation then appears in its connectors.');
  });

  const disconnect = (): Promise<void> => run('disconnect', async () => {
    const r = await api.disconnect();
    setStatus(r.status);
    setSteps(null);
    if (r.problems.length) setError(`Premation was turned off, but Claude's config could not be edited: ${r.problems.join('; ')}`);
    else setNote('Claude is disconnected. Restart Claude Desktop to remove Premation from its list.');
  });

  const repair = (): Promise<void> => run('repair', async () => {
    const r = await api.repair();
    setStatus(r.status);
    if (!r.ok) setError(r.message);
    else setNote('Repaired. Restart Claude Desktop to use the new path.');
  });

  const test = (): Promise<void> => run('test', async () => {
    setSteps(null);
    setSteps(await api.test());
  });

  const enableForCode = (): Promise<void> => run('enable', async () => {
    setStatus(await api.enable());
    setShowCode(true);
  });

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard refused; the text is selectable */ }
  };

  const clients = status?.bridge.clients ?? [];
  const on = !!status?.bridge.enabled;
  const configured = !!status?.configured;
  const installed = !!status?.claude.installed;

  return (
    <section className={styles.card} aria-labelledby="claude-connect-title">
      <header className={styles.head}>
        <div>
          <h3 id="claude-connect-title" className={styles.title}>Claude for Premation</h3>
          <p className={styles.lede}>Control Premation directly from Claude Desktop or Claude Code. Claude works in the project you have open, and you watch it happen.</p>
        </div>
        <StatusPill status={status} />
      </header>

      {!on && (
        <ul className={styles.caps}>
          {CAPABILITIES.map((c) => (
            <li key={c}><Icon name="check" size="sm" className={styles.capIcon} />{c}</li>
          ))}
        </ul>
      )}

      {/* No link to the plan page: it lives on the dashboard, a route only the
          server edition has, and the editor shell never links there
          (editionReachability.test.ts). The gate itself only shows there. */}
      {needsPlan && (
        <div className={styles.plan}>
          <span>
            Claude for Premation is part of the Premation Pro plan.
            {salesOpen ? ' Upgrade from your account’s Billing page on the Premation home screen.' : ''}
          </span>
        </div>
      )}

      {status?.bridge.error ? <p className={styles.error}>{status.bridge.error}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {note ? <p className={styles.note}>{note}</p> : null}

      {status && !status.connectorInstalled ? (
        <p className={styles.error}>Premation&rsquo;s Claude connector is missing from this installation. Reinstall Premation to use Claude.</p>
      ) : null}

      {status?.needsRepair && (
        <div className={styles.repair}>
          <span>Claude is set up, but it points to an old copy of Premation (the app moved, usually after an update).</span>
          <button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void repair()}>
            {busy === 'repair' ? 'Repairing…' : 'Repair connection'}
          </button>
        </div>
      )}

      {clients.length > 0 && (
        <ul className={styles.clients}>
          {clients.map((c) => (
            <li key={c.id}>
              <span className={styles.live} aria-hidden="true" />
              {c.name}{c.version ? ` ${c.version}` : ''} · connected {since(c.since)}
              {c.lastCallAt ? ` · last request ${since(c.lastCallAt)}` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.actions}>
        {!installed && !configured ? (
          <>
            <span className={styles.subtle}>Claude Desktop isn&rsquo;t installed on this computer.</span>
            <button type="button" className={styles.primary} onClick={() => void api.getClaude()}>Get Claude</button>
          </>
        ) : !configured ? (
          <button type="button" className={styles.primary} disabled={busy !== null || !status?.connectorInstalled} onClick={() => void connect()}>
            {busy === 'connect' ? 'Connecting…' : 'Connect Claude'}
          </button>
        ) : (
          <>
            <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void test()}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Claude'}
            </button>
          </>
        )}
        {!configured && on && (
          <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void disconnect()}>
            Turn off
          </button>
        )}
      </div>

      {steps && (
        <ol className={styles.steps}>
          {steps.map((s) => (
            <li key={s.id} className={s.ok ? styles.stepOk : styles.stepFail}>
              <Icon name={s.ok ? 'success' : 'error'} size="sm" />
              <span>{s.label}{s.detail ? <span className={styles.detail}> — {s.detail}</span> : null}</span>
            </li>
          ))}
        </ol>
      )}

      <details className={styles.more} open={showCode} onToggle={(e) => setShowCode((e.target as HTMLDetailsElement).open)}>
        <summary>Using Claude Code, or setting it up by hand</summary>
        <p className={styles.subtle}>
          Claude Code: turn Premation on, then run this once in a terminal.
        </p>
        {!on && (
          <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void enableForCode()}>
            {busy === 'enable' ? 'Turning on…' : 'Turn on for Claude Code'}
          </button>
        )}
        {status && (
          <>
            <div className={styles.codeRow}>
              <code className={styles.code}>{status.claudeCodeCommand}</code>
              <button type="button" className={styles.secondary} onClick={() => void copy(status.claudeCodeCommand)}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p className={styles.subtle}>Claude Desktop by hand: add this under &ldquo;mcpServers&rdquo; in its config file.</p>
            <pre className={styles.code}>{status.manualSnippet}</pre>
          </>
        )}
      </details>
    </section>
  );
}

function StatusPill({ status }: { status: ClaudeSetupStatus | null }): JSX.Element | null {
  if (!status) return null;
  const connected = status.bridge.clients.length > 0;
  const label = connected
    ? 'Connected'
    : status.needsRepair
      ? 'Needs repair'
      : status.configured && status.bridge.listening
        ? 'Ready'
        : status.configured
          ? 'Configured'
          : status.bridge.enabled
            ? 'On'
            : 'Not connected';
  const tone = connected || (status.configured && status.bridge.listening) ? styles.pillOk : status.needsRepair ? styles.pillWarn : styles.pillOff;
  return <span className={`${styles.pill} ${tone}`}>{label}</span>;
}
