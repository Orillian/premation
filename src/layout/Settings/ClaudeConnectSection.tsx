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

import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { BrandMark } from '@components/BrandMark';
import { billingEnabled } from '@core/config/edition';
import { useEntitlementStore } from '@stores/entitlementStore';
import { useClaudeStore } from '@stores/claudeStore';
import { CLAUDE_REQUIRES_PRO, mcpDevPlan } from '@core/ai/mcp/mcpAccess';
import { useProSalesOpen } from '@hooks/useProSalesOpen';
import type { ClaudeTestStep } from '@app-types/motionEditor';
import { mcpClientLabel } from '@components/claude/claudeLabels';
import { t } from '@core/i18n';
import styles from './ClaudeConnectSection.module.css';

/** Example requests to copy. A function: translated at render time, not import time. */
function examples(): string[] {
  return [
    t('settings.claude.example.logo', 'In Premation, create a 10-second logo reveal for "NOVA" with a glow and a camera push-in.'),
    t('settings.claude.example.promo', 'In Premation, make a vertical 15-second promo for a summer sale with three scenes.'),
    t('settings.claude.example.text', 'In Premation, animate the selected text so each word bounces in, then show me a filmstrip.'),
  ];
}

/**
 * A translated sentence with `{name}` slots filled by elements (bold, code),
 * so the markup survives any word order the translation picks.
 */
function fillNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={i}>{name && name in nodes ? nodes[name] : part}</Fragment>;
  });
}

type Busy = 'connect' | 'config' | 'disconnect' | 'repair' | 'test' | 'enable' | null;

function clientName(name: string): string {
  return /claude/i.test(name) && !/code/i.test(name) ? 'Claude Desktop' : mcpClientLabel(name);
}

function since(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return t('settings.claude.justNow', 'just now');
  const m = Math.round(s / 60);
  return m < 60
    ? t('settings.claude.minutesAgo', '{n} min ago', { n: m })
    : t('settings.claude.hoursAgo', '{n} h ago', { n: Math.round(m / 60) });
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
    const timer = setInterval(() => void reload(), 1500);
    return () => clearInterval(timer);
  }, [api, waitingInstall, reload]);

  useEffect(() => {
    if (waitingInstall && status?.configured) {
      setWaitingInstall(false);
      setNote(t('settings.claude.note.installed', 'Installed in Claude. Now open Claude Desktop (or start a new chat) and ask it to work in Premation.'));
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
      setNote(
        t(
          'settings.claude.note.openFailed',
          'Premation made its Claude extension but could not open it. Click “Show the file” and drag it into the Claude Desktop window.',
        ),
      );
    }
    setWaitingInstall(true);
  });

  const connectConfig = (): Promise<void> => run('config', async () => {
    const r = await api.connectConfig();
    setStatus(r.status);
    if (!r.ok) {
      setError(
        r.code === 'malformed'
          ? t('settings.claude.error.malformed', '{message} Premation did not change it.', { message: r.message })
          : r.message,
      );
      return;
    }
    setNote(t('settings.claude.note.configAdded', 'Added to Claude’s settings. Quit Claude Desktop completely and open it again.'));
  });

  const disconnect = (): Promise<void> => run('disconnect', async () => {
    const others = (status?.apps ?? []).filter((a) => a.state === 'ok' || a.state === 'stale').map((a) => a.name);
    const paused = others.length
      ? ` ${t('settings.claude.note.pausedApps', '{apps} will connect again after you turn Premation back on.', {
          apps: others.join(t('settings.claude.listAnd', ' and ')),
        })}`
      : '';
    const r = await api.disconnect();
    setStatus(r.status);
    setSteps(null);
    setWaitingInstall(false);
    if (r.problems.length) {
      setError(
        t('settings.claude.error.disconnect', 'Premation was turned off, but Claude’s settings could not be edited: {problems}', {
          problems: r.problems.join('; '),
        }),
      );
    } else if (r.extensionInstalled) {
      setNote(
        t(
          'settings.claude.note.stopped',
          'Premation stopped accepting connections.{paused} To remove it from Claude too: Claude Desktop → Settings → Extensions → Premation → Uninstall.',
          { paused },
        ),
      );
    } else setNote(t('settings.claude.note.disconnected', 'Disconnected.{paused}', { paused }));
  });

  const repair = (): Promise<void> => run('repair', async () => {
    const r = await api.repair();
    setStatus(r.status);
    if (!r.ok) setError(r.message);
    else if (r.method === 'extension') setWaitingInstall(true);
    else setNote(t('settings.claude.note.repaired', 'Repaired. Quit Claude Desktop completely and open it again.'));
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
    ? { label: t('settings.claude.pill.connected', 'Connected'), tone: styles.pillOk }
    : status?.needsRepair
      ? { label: t('settings.claude.pill.needsRepair', 'Needs repair'), tone: styles.pillWarn }
      : installed && on
        ? { label: t('settings.claude.pill.ready', 'Ready'), tone: styles.pillReady }
        : waitingInstall
          ? { label: t('settings.claude.pill.installing', 'Installing…'), tone: styles.pillReady }
          : { label: t('settings.claude.pill.notConnected', 'Not connected'), tone: styles.pillOff };

  const step1Done = installed;
  const step2Done = connected;

  return (
    <section className={styles.card} aria-labelledby="claude-connect-title">
      <header className={styles.head}>
        <BrandMark brand="claude" size={32} />
        <div className={styles.headText}>
          <h3 id="claude-connect-title" className={styles.title}>Claude for Premation</h3>
          <p className={styles.lede}>
            {t(
              'settings.claude.lede',
              'Ask Claude to create and edit motion graphics in Premation. Claude works in the project you have open — or makes a new one — and you watch it happen.',
            )}
          </p>
        </div>
        <span className={`${styles.pill} ${pill.tone}`}>{pill.label}</span>
      </header>

      {status?.devBuild ? (
        <p className={styles.dev}>
          {t('settings.claude.devBuild', 'Development build: connecting here replaces an installed Premation in Claude.')}
          {devPlan ? (
            <>
              {' '}
              {fillNodes(t('settings.claude.devPlan', 'Plan overridden to {plan} by {env}.'), {
                plan: <strong>{devPlan}</strong>,
                env: <code>VITE_MCP_DEV_PLAN</code>,
              })}
            </>
          ) : null}
        </p>
      ) : null}

      {needsPlan && (
        <div className={styles.plan}>
          {t('settings.claude.needsPlan', 'Claude for Premation is part of the Premation Pro plan.')}
          {salesOpen
            ? ` ${t('settings.claude.upgradeHint', 'Upgrade from your account’s Billing page on the Premation home screen.')}`
            : ''}
        </div>
      )}

      {status?.bridge.error ? <p className={styles.error}>{status.bridge.error}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {status && !status.connectorInstalled ? (
        <p className={styles.error}>
          {t(
            'settings.claude.connectorMissing',
            'Premation’s Claude connector is missing from this installation. Reinstall Premation to use Claude.',
          )}
        </p>
      ) : null}

      {connected ? (
        <div className={styles.live}>
          <span className={styles.liveDot} aria-hidden="true" />
          <span>
            {clients
              .map((c) =>
                c.lastCallAt
                  ? t('settings.claude.clientLast', '{client} — connected {since}, last step {last}', {
                      client: clientName(c.name),
                      since: since(c.since),
                      last: since(c.lastCallAt),
                    })
                  : t('settings.claude.client', '{client} — connected {since}', {
                      client: clientName(c.name),
                      since: since(c.since),
                    }),
              )
              .join(' · ')}
          </span>
        </div>
      ) : null}

      {status?.needsRepair ? (
        <div className={styles.repair}>
          <span>
            {t(
              'settings.claude.repairHint',
              'Claude has Premation, but it points to an old copy of the app (it moved, usually after an update).',
            )}
          </span>
          <button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void repair()}>
            {busy === 'repair' ? t('settings.claude.repairing', 'Repairing…') : t('settings.claude.repair', 'Repair')}
          </button>
        </div>
      ) : null}

      {!claudePresent && !installed ? (
        <div className={styles.getClaude}>
          <span>{t('settings.claude.notInstalled', 'Claude Desktop isn’t installed on this computer. It’s a free download from Anthropic.')}</span>
          <button type="button" className={styles.primary} onClick={() => void api.getClaude()}>
            {t('settings.claude.getClaude', 'Get Claude Desktop')}
          </button>
        </div>
      ) : (
        <ol className={styles.steps}>
          <li className={styles.step} data-done={step1Done} data-current={!step1Done}>
            <span className={styles.stepMark} aria-hidden="true">{step1Done ? <Icon name="check" size="sm" /> : '1'}</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>{t('settings.claude.step1.title', 'Install Premation in Claude')}</span>
              {step1Done ? (
                <span className={styles.stepHelp}>
                  {status?.method === 'config'
                    ? t('settings.claude.step1.doneConfig', 'Installed (through Claude’s settings file).')
                    : t('settings.claude.step1.doneExtension', 'Installed as a Claude extension.')}
                </span>
              ) : waitingInstall ? (
                <>
                  <span className={styles.stepHelp}>
                    {fillNodes(
                      t(
                        'settings.claude.step1.waiting',
                        'Claude Desktop is showing Premation’s install screen — click {install} there. This updates by itself when it’s done.',
                      ),
                      { install: <strong>{t('settings.claude.step1.installButton', 'Install')}</strong> },
                    )}
                  </span>
                  <div className={styles.actions}>
                    <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void connect()}>
                      {t('settings.claude.step1.openAgain', 'Open the installer again')}
                    </button>
                    <button type="button" className={styles.secondary} onClick={() => void api.revealExtension()}>
                      {t('settings.claude.step1.showFile', 'Show the file')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className={styles.stepHelp}>
                    {t('settings.claude.step1.help', 'Claude opens its install screen with Premation’s name and logo. One click.')}
                  </span>
                  <div className={styles.actions}>
                    <button type="button" className={styles.primary} disabled={busy !== null || !status?.connectorInstalled} onClick={() => void connect()}>
                      {busy === 'connect'
                        ? t('settings.claude.step1.opening', 'Opening Claude…')
                        : t('settings.claude.step1.connect', 'Connect Claude')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </li>
          <li className={styles.step} data-done={step2Done} data-current={step1Done && !step2Done}>
            <span className={styles.stepMark} aria-hidden="true">{step2Done ? <Icon name="check" size="sm" /> : '2'}</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>{t('settings.claude.step2.title', 'Open Claude Desktop')}</span>
              <span className={styles.stepHelp}>
                {step2Done
                  ? t('settings.claude.step2.done', 'Claude is connected to Premation.')
                  : t(
                      'settings.claude.step2.help',
                      'Start a new chat. Premation appears among Claude’s connectors; this step ticks when Claude connects.',
                    )}
              </span>
            </div>
          </li>
          <li className={styles.step} data-done={false} data-current={step2Done}>
            <span className={styles.stepMark} aria-hidden="true">3</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>{t('settings.claude.step3.title', 'Ask Claude')}</span>
              <span className={styles.stepHelp}>{t('settings.claude.step3.help', 'No project open? Claude can create one. Try:')}</span>
              <ul className={styles.examples}>
                {examples().map((e) => (
                  <li key={e}>
                    <button type="button" className={styles.example} onClick={() => void copy(e)} title={t('settings.claude.copy', 'Copy')}>
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
            {busy === 'test' ? t('settings.claude.testing', 'Testing…') : t('settings.claude.test', 'Test connection')}
          </button>
          <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void disconnect()}>
            {busy === 'disconnect'
              ? t('settings.claude.disconnecting', 'Disconnecting…')
              : t('settings.claude.disconnect', 'Disconnect')}
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
          {t('settings.claude.advanced', 'Advanced — Claude Code (terminal), or set up without the extension')}
        </button>
        {advanced && status && (
          <div className={styles.moreBody}>
            <p className={styles.subtle}>
              <strong>{t('settings.claude.code.label', 'Claude Code:')}</strong>{' '}
              {t('settings.claude.code.help', 'turn Premation on, then run this once in a terminal.')}
            </p>
            {!on && (
              <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void enableForCode()}>
                {busy === 'enable'
                  ? t('settings.claude.code.turningOn', 'Turning on…')
                  : t('settings.claude.code.turnOn', 'Turn on for Claude Code')}
              </button>
            )}
            <div className={styles.codeRow}>
              <code className={styles.code}>{status.claudeCodeCommand}</code>
              <button type="button" className={styles.secondary} onClick={() => void copy(status.claudeCodeCommand)}>{copied === status.claudeCodeCommand ? t('settings.claude.copied', 'Copied') : t('settings.claude.copy', 'Copy')}</button>
            </div>
            <p className={styles.subtle}>
              <strong>{t('settings.claude.config.label', 'Without the extension:')}</strong>{' '}
              {t(
                'settings.claude.config.help',
                'Premation adds itself to Claude Desktop’s settings file instead. Claude shows a generic icon, but Disconnect and uninstalling remove it completely.',
              )}
            </p>
            <button type="button" className={styles.secondary} disabled={busy !== null || !claudePresent} onClick={() => void connectConfig()}>
              {busy === 'config'
                ? t('settings.claude.config.adding', 'Adding…')
                : t('settings.claude.config.use', 'Use Claude’s settings file')}
            </button>
            <p className={styles.subtle}>
              {t('settings.claude.manual', 'By hand: add this under “mcpServers” in Claude Desktop’s config file.')}
            </p>
            <pre className={styles.code}>{status.manualSnippet}</pre>
          </div>
        )}
      </div>
    </section>
  );
}
