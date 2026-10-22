/**
 * The Claude activity panel (the title-bar pill's popover): the connection,
 * what Claude is doing now, anything waiting for the user's Allow, the recent
 * steps, and the controls — Stop, Undo Claude's last change, Settings.
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { engine } from '@core/engine/engineInstance';
import { mcpFrontDesk } from '@core/ai/mcp/frontDesk';
import { undoLastClaudeStep } from '@core/ai/mcp/claudeUndo';
import { useClaudeStore, type ClaudeMode } from '@stores/claudeStore';
import { openCustomizeDialog } from '@layout/Settings/openCustomizeDialog';
import { agoText, assistantName, claudeToolLabel, mcpClientLabel } from './claudeLabels';
import { t } from '@core/i18n';
import styles from './Claude.module.css';

function connectionLine(mode: ClaudeMode, brand: string, clients: ReadonlyArray<{ name: string; since: number }>): string {
  if (clients.length > 0) {
    const c = clients[0]!;
    const who = mcpClientLabel(c.name) || brand;
    return clients.length > 1
      ? t('ui.claude.panel.connectedMore', '{name} connected {ago} (+{n} more)', { name: who, ago: agoText(c.since), n: clients.length - 1 })
      : t('ui.claude.panel.connected', '{name} connected {ago}', { name: who, ago: agoText(c.since) });
  }
  if (mode === 'setup') return t('ui.claude.panel.notConnected', 'Not connected yet — finish in Settings.');
  return t('ui.claude.canWork', '{name} can work in Premation. Ask it in a new chat.', { name: brand });
}

export function ClaudePanel({ mode, onClose }: { mode: ClaudeMode; onClose: () => void }): JSX.Element {
  const setup = useClaudeStore((s) => s.setup);
  const desk = useClaudeStore((s) => s.desk);
  const approvals = useClaudeStore((s) => s.approvals);
  const answer = useClaudeStore((s) => s.answerApproval);
  const [note, setNote] = useState('');
  const clients = setup?.bridge.clients ?? [];
  const brand = assistantName(setup);
  const inEditor = mcpFrontDesk()?.hasEditor() ?? false;
  const working = desk.busy || !!desk.group;

  const undo = async (): Promise<void> => {
    const r = await undoLastClaudeStep(engine());
    setNote(r.ok ? t('ui.claude.panel.undid', 'Undid “{label}”.', { label: r.label.replace(/^Claude:\s*/, '') }) : r.reason);
  };

  return (
    <div className={styles.panel} role="dialog" aria-label={t('ui.claude.panel.label', '{name} activity', { name: brand })}>
      <header className={styles.panelHead}>
        <span className={styles.dot} data-mode={mode} aria-hidden="true" />
        <div className={styles.panelHeadText}>
          <span className={styles.panelTitle}>{brand}</span>
          <span className={styles.panelSub}>{connectionLine(mode, brand, clients)}</span>
        </div>
      </header>

      {approvals.map((a) => (
        <section key={a.id} className={styles.approval} aria-live="assertive">
          <div className={styles.approvalTitle}>
            <Icon name={a.kind === 'import' ? 'upload' : 'export'} size="sm" />
            <span>{t('ui.claude.wantsTo', '{name} wants to {action}', { name: brand, action: `${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}` })}</span>
          </div>
          <ul className={styles.approvalDetail}>
            {a.detail.slice(0, 6).map((d) => <li key={d} title={d}>{d}</li>)}
            {a.detail.length > 6 ? <li>{t('ui.claude.panel.andMore', '…and {n} more', { n: a.detail.length - 6 })}</li> : null}
          </ul>
          <div className={styles.row}>
            <Button size="sm" variant="secondary" onClick={() => answer(a.id, false)}>{t('ui.claude.deny', 'Deny')}</Button>
            <Button size="sm" variant="primary" onClick={() => answer(a.id, true)}>{t('ui.claude.allow', 'Allow')}</Button>
          </div>
        </section>
      ))}

      {working && (
        <section className={styles.now} aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <div className={styles.nowText}>
            <span>{desk.tool ? claudeToolLabel(desk.tool) : t('ui.claude.panel.waiting', 'Waiting for {name}’s next step', { name: brand })}</span>
            {desk.group ? <span className={styles.panelSub}>{t('ui.claude.panel.change', 'Change: “{group}” — one undo step', { group: desk.group })}</span> : null}
          </div>
          <Button size="sm" variant="secondary" onClick={() => void mcpFrontDesk()?.stop()} title={t('ui.claude.panel.stopTitle', 'Stop {name} and undo its unfinished change', { name: brand })}>
            {t('ui.claude.panel.stop', 'Stop')}
          </Button>
        </section>
      )}

      <section className={styles.feed}>
        <span className={styles.feedHead}>{t('ui.claude.panel.recent', 'Recent steps')}</span>
        {desk.feed.length === 0 ? (
          <p className={styles.empty}>{t('ui.claude.panel.empty', 'Nothing yet. Ask {name} to work in this project.', { name: brand })}</p>
        ) : (
          <ol className={styles.feedList}>
            {desk.feed.slice(0, 14).map((e) => (
              <li key={e.id} className={styles.feedItem} data-ok={e.ok}>
                <Icon name={e.ok ? 'check' : 'warning'} size="sm" className={styles.feedIcon} />
                <span className={styles.feedText}>
                  <span className={styles.feedTool}>{claudeToolLabel(e.tool)}</span>
                  {e.summary ? <span className={styles.feedSummary} title={e.summary}>{e.summary}</span> : null}
                </span>
                <time className={styles.feedTime}>{agoText(e.at)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      {note ? <p className={styles.panelNote}>{note}</p> : null}

      <footer className={styles.row}>
        {inEditor ? (
          <Button size="sm" variant="ghost" leftIcon={<Icon name="undo" size="sm" />} onClick={() => void undo()} disabled={working}>
            {t('ui.claude.panel.undo', 'Undo last change')}
          </Button>
        ) : <span />}
        <Button size="sm" variant="ghost" leftIcon={<Icon name="settings" size="sm" />} onClick={() => { onClose(); openCustomizeDialog('ai'); }}>
          {t('ui.claude.panel.settings', 'Settings')}
        </Button>
      </footer>
    </div>
  );
}
