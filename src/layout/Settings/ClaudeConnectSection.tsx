/**
 * Settings → AI → Claude for Premation: connect Claude Desktop (or Claude
 * Code) to Premation (docs/MCP_PLAN.md §3.4, §13).
 *
 * The user never sees "MCP". The card is three steps with live ticks:
 *
 *   1  Install in Claude   Connect writes Premation's Claude extension and
 *                          opens it; Claude shows its install screen with the
 *                          Premation logo. Ticked once Claude has installed it.
 *   2  Open Claude         ticked while a Claude is connected right now
 *   3  Ask                 example requests to copy
 *
 * and keeps three states apart that are easy to blur: INSTALLED in Claude,
 * READY (Premation is listening) and CONNECTED (a Claude is on the line).
 *
 * Claude Code, the config-file route (no logo, but fully removable by
 * Premation) and the by-hand snippet live under Advanced.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { BrandMark } from '@components/BrandMark';
import { billingEnabled } from '@core/config/edition';
import { useEntitlementStore } from '@stores/entitlementStore';
import { useClaudeStore } from '@stores/claudeStore';
import { CLAUDE_REQUIRES_PRO, mcpDevPlan } from '@core/ai/mcp/mcpAccess';
import { useProSalesOpen } from '@hooks/useProSalesOpen';
import type { ClaudeTestStep } from '@app-types/motionEditor';
import { mcpClientLabel } from '@components/claude/claudeLabels';
import styles from './ClaudeConnectSection.module.css';

const EXAMPLES = [
  'In Premation, create a 10-second logo reveal for "NOVA" with a glow and a camera push-in.',
  'In Premation, make a vertical 15-second promo for a summer sale with three scenes.',
  'In Premation, animate the selected text so each word bounces in, then show me a filmstrip.',
];

type Busy = 'connect' | 'config' | 'disconnect' | 'repair' | 'test' | 'enable' | null;

function clientName(name: string): string {
  return /claude/i.test(name) && !/code/i.test(name) ? 'Claude Desktop' : mcpClientLabel(name);
}

function since(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function ClaudeConnectSection(): JSX.Element | null {
  const api = typeof window !== 'undefined' ? window.motionEditor?.mcp : undefined;
  const status = useClaudeStore((s) => s.setup);
  const setStatus = useClaudeStore((s) => s.setSetup);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [waitingInstall, setWaitingInstall] = useState(false);
  const [steps, setSteps] = useState<ClaudeTestStep[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const access = useEntitlementStore((s) => s.access);
  const salesOpen = useProSalesOpen();

  const reload = useCallback(async () => {
    if (api) setStatus(await api.getStatus());
  }, [api, setStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // While Claude's install screen is up, watch for Claude to finish installing.
  useEffect(() => {
    if (!api || !waitingInstall) return undefined;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [api, waitingInstall, reload]);

  useEffect(() => {
    if (waitingInstall && status?.configured) {
      setWaitingInstall(false);
      setNote('Installed in Claude. Now open Claude Desktop (or start a new chat) and ask it to work in Premation.');
    }
  }, [waitingInstall, status?.configured]);

  useEffect(() => {
    if (billingEnabled()) void useEntitlementStore.getState().refresh();
  }, []);

  // A browser build has no desktop app for Claude to reach.
  if (!api) return null;

  const devPlan = mcpDevPlan();
  const needsPlan = devPlan ? devPlan === 'free' : CLAUDE_REQUIRES_PRO && billingEnabled() && access?.plan !== 'pro';
  const clients = status?.bridge.clients ?? [];
  const connected = clients.length > 0;
  const installed = !!status?.configured;
  const claudePresent = !!status?.claude.installed;
  const on = !!status?.bridge.enabled;

  const run = async (kind: NonNullable<Busy>, fn: () => Promise<void>): Promise<void> => {
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
      setError(r.message);
      return;
    }
    if (r.openError) {
      setNote('Premation made its Claude extension but could not open it. Click “Show the file” and drag it into the Claude Desktop window.');
    }
    setWaitingInstall(true);
  });

  const connectConfig = (): Promise<void> => run('config', async () => {
    const r = await api.connectConfig();
    setStatus(r.status);
    if (!r.ok) {
      setError(r.code === 'malformed' ? `${r.message} Premation did not change it.` : r.message);
      return;
    }
    setNote('Added to Claude’s settings. Quit Claude Desktop completely and open it again.');
  });

  const disconnect = (): Promise<void> => run('disconnect', async () => {
    const others = (status?.apps ?? []).filter((a) => a.state === 'ok' || a.state === 'stale').map((a) => a.name);
    const paused = others.length ? ` ${others.join(' and ')} will connect again after you turn Premation back on.` : '';
    const r = await api.disconnect();
    setStatus(r.status);
    setSteps(null);
    setWaitingInstall(false);
    if (r.problems.length) setError(`Premation was turned off, but Claude’s settings could not be edited: ${r.problems.join('; ')}`);
    else if (r.extensionInstalled) setNote(`Premation stopped accepting connections.${paused} To remove it from Claude too: Claude Desktop → Settings → Extensions → Premation → Uninstall.`);
    else setNote(`Disconnected.${paused}`);
  });

  const repair = (): Promise<void> => run('repair', async () => {
    const r = await api.repair();
    setStatus(r.status);
    if (!r.ok) setError(r.message);
    else if (r.method === 'extension') setWaitingInstall(true);
    else setNote('Repaired. Quit Claude Desktop completely and open it again.');
  });

  const test = (): Promise<void> => run('test', async () => {
    setSteps(null);
    setSteps(await api.test());
  });

  const enableForCode = (): Promise<void> => run('enable', async () => {
    setStatus(await api.enable());
  });

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* clipboard refused; the text is selectable */ }
  };

  const pill = connected
    ? { label: 'Connected', tone: styles.pillOk }
    : status?.needsRepair
      ? { label: 'Needs repair', tone: styles.pillWarn }
      : installed && on
        ? { label: 'Ready', tone: styles.pillReady }
        : waitingInstall
          ? { label: 'Installing…', tone: styles.pillReady }
          : { label: 'Not connected', tone: styles.pillOff };

  const step1Done = installed;
  const step2Done = connected;

  return (
    <section className={styles.card} aria-labelledby="claude-connect-title">
      <header className={styles.head}>
        <BrandMark brand="claude" size={32} />
        <div className={styles.headText}>
          <h3 id="claude-connect-title" className={styles.title}>Claude for Premation</h3>
          <p className={styles.lede}>Ask Claude to create and edit motion graphics in Premation. Claude works in the project you have open — or makes a new one — and you watch it happen.</p>
        </div>
        <span className={`${styles.pill} ${pill.tone}`}>{pill.label}</span>
      </header>

      {status?.devBuild ? (
        <p className={styles.dev}>
          Development build: connecting here replaces an installed Premation in Claude.
          {devPlan ? <> Plan overridden to <strong>{devPlan}</strong> by <code>VITE_MCP_DEV_PLAN</code>.</> : null}
        </p>
      ) : null}

      {needsPlan && (
        <div className={styles.plan}>
          Claude for Premation is part of the Premation Pro plan.
          {salesOpen ? ' Upgrade from your account’s Billing page on the Premation home screen.' : ''}
        </div>
      )}

      {status?.bridge.error ? <p className={styles.error}>{status.bridge.error}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {status && !status.connectorInstalled ? (
        <p className={styles.error}>Premation’s Claude connector is missing from this installation. Reinstall Premation to use Claude.</p>
      ) : null}

      {connected ? (
        <div className={styles.live}>
          <span className={styles.liveDot} aria-hidden="true" />
          <span>
            {clients.map((c) => `${clientName(c.name)} — connected ${since(c.since)}${c.lastCallAt ? `, last step ${since(c.lastCallAt)}` : ''}`).join(' · ')}
          </span>
        </div>
      ) : null}

      {status?.needsRepair ? (
        <div className={styles.repair}>
          <span>Claude has Premation, but it points to an old copy of the app (it moved, usually after an update).</span>
          <button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void repair()}>
            {busy === 'repair' ? 'Repairing…' : 'Repair'}
          </button>
        </div>
      ) : null}

      {!claudePresent && !installed ? (
        <div className={styles.getClaude}>
          <span>Claude Desktop isn’t installed on this computer. It’s a free download from Anthropic.</span>
          <button type="button" className={styles.primary} onClick={() => void api.getClaude()}>Get Claude Desktop</button>
        </div>
      ) : (
        <ol className={styles.steps}>
          <li className={styles.step} data-done={step1Done} data-current={!step1Done}>
            <span className={styles.stepMark} aria-hidden="true">{step1Done ? <Icon name="check" size="sm" /> : '1'}</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>Install Premation in Claude</span>
              {step1Done ? (
                <span className={styles.stepHelp}>
                  Installed{status?.method === 'config' ? ' (through Claude’s settings file)' : ' as a Claude extension'}.
                </span>
              ) : waitingInstall ? (
                <>
                  <span className={styles.stepHelp}>
                    Claude Desktop is showing Premation’s install screen — click <strong>Install</strong> there. This updates by itself when it’s done.
                  </span>
                  <div className={styles.actions}>
                    <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void connect()}>Open the installer again</button>
                    <button type="button" className={styles.secondary} onClick={() => void api.revealExtension()}>Show the file</button>
                  </div>
                </>
              ) : (
                <>
                  <span className={styles.stepHelp}>Claude opens its install screen with Premation’s name and logo. One click.</span>
                  <div className={styles.actions}>
                    <button type="button" className={styles.primary} disabled={busy !== null || !status?.connectorInstalled} onClick={() => void connect()}>
                      {busy === 'connect' ? 'Opening Claude…' : 'Connect Claude'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </li>
          <li className={styles.step} data-done={step2Done} data-current={step1Done && !step2Done}>
            <span className={styles.stepMark} aria-hidden="true">{step2Done ? <Icon name="check" size="sm" /> : '2'}</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>Open Claude Desktop</span>
              <span className={styles.stepHelp}>
                {step2Done
                  ? 'Claude is connected to Premation.'
                  : 'Start a new chat. Premation appears among Claude’s connectors; this step ticks when Claude connects.'}
              </span>
            </div>
          </li>
          <li className={styles.step} data-done={false} data-current={step2Done}>
            <span className={styles.stepMark} aria-hidden="true">3</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>Ask Claude</span>
              <span className={styles.stepHelp}>No project open? Claude can create one. Try:</span>
              <ul className={styles.examples}>
                {EXAMPLES.map((e) => (
                  <li key={e}>
                    <button type="button" className={styles.example} onClick={() => void copy(e)} title="Copy">
                      <span>“{e}”</span>
                      <Icon name={copied === e ? 'check' : 'copy'} size="sm" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        </ol>
      )}

      {note ? <p className={styles.note}>{note}</p> : null}

      {(installed || on) && (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void test()}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void disconnect()}>
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      )}

      {steps && (
        <ol className={styles.testSteps}>
          {steps.map((s) => (
            <li key={s.id} className={s.ok ? styles.testOk : styles.testFail}>
              <Icon name={s.ok ? 'success' : 'error'} size="sm" />
              <span>{s.label}{s.detail ? <span className={styles.detail}> — {s.detail}</span> : null}</span>
            </li>
          ))}
        </ol>
      )}

      <div className={styles.more}>
        <button type="button" className={styles.moreToggle} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size="sm" />
          Advanced — Claude Code (terminal), or set up without the extension
        </button>
        {advanced && status && (
          <div className={styles.moreBody}>
            <p className={styles.subtle}>
              <strong>Claude Code:</strong> turn Premation on, then run this once in a terminal.
            </p>
            {!on && (
              <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void enableForCode()}>
                {busy === 'enable' ? 'Turning on…' : 'Turn on for Claude Code'}
              </button>
            )}
            <div className={styles.codeRow}>
              <code className={styles.code}>{status.claudeCodeCommand}</code>
              <button type="button" className={styles.secondary} onClick={() => void copy(status.claudeCodeCommand)}>{copied === status.claudeCodeCommand ? 'Copied' : 'Copy'}</button>
            </div>
            <p className={styles.subtle}>
              <strong>Without the extension:</strong> Premation adds itself to Claude Desktop’s settings file instead. Claude shows a generic icon, but Disconnect and uninstalling remove it completely.
            </p>
            <button type="button" className={styles.secondary} disabled={busy !== null || !claudePresent} onClick={() => void connectConfig()}>
              {busy === 'config' ? 'Adding…' : 'Use Claude’s settings file'}
            </button>
            <p className={styles.subtle}>By hand: add this under “mcpServers” in Claude Desktop’s config file.</p>
            <pre className={styles.code}>{status.manualSnippet}</pre>
          </div>
        )}
      </div>
    </section>
  );
}
