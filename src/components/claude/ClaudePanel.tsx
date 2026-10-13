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
import styles from './Claude.module.css';

function connectionLine(mode: ClaudeMode, brand: string, clients: ReadonlyArray<{ name: string; since: number }>): string {
  if (clients.length > 0) {
    const c = clients[0]!;
    const who = mcpClientLabel(c.name) || brand;
    return `${who} connected ${agoText(c.since)}${clients.length > 1 ? ` (+${clients.length - 1} more)` : ''}`;
  }
  if (mode === 'setup') return 'Not connected yet — finish in Settings.';
  return `${brand} can work in Premation. Ask it in a new chat.`;
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
    setNote(r.ok ? `Undid “${r.label.replace(/^Claude:\s*/, '')}”.` : r.reason);
  };

  return (
    <div className={styles.panel} role="dialog" aria-label={`${brand} activity`}>
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
            <span>{brand} wants to {a.title.charAt(0).toLowerCase()}{a.title.slice(1)}</span>
          </div>
          <ul className={styles.approvalDetail}>
            {a.detail.slice(0, 6).map((d) => <li key={d} title={d}>{d}</li>)}
            {a.detail.length > 6 ? <li>…and {a.detail.length - 6} more</li> : null}
          </ul>
          <div className={styles.row}>
            <Button size="sm" variant="secondary" onClick={() => answer(a.id, false)}>Deny</Button>
            <Button size="sm" variant="primary" onClick={() => answer(a.id, true)}>Allow</Button>
          </div>
        </section>
      ))}

      {working && (
        <section className={styles.now} aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <div className={styles.nowText}>
            <span>{desk.tool ? claudeToolLabel(desk.tool) : `Waiting for ${brand}’s next step`}</span>
            {desk.group ? <span className={styles.panelSub}>Change: “{desk.group}” — one undo step</span> : null}
          </div>
          <Button size="sm" variant="secondary" onClick={() => void mcpFrontDesk()?.stop()} title={`Stop ${brand} and undo its unfinished change`}>
            Stop
          </Button>
        </section>
      )}

      <section className={styles.feed}>
        <span className={styles.feedHead}>Recent steps</span>
        {desk.feed.length === 0 ? (
          <p className={styles.empty}>Nothing yet. Ask {brand} to work in this project.</p>
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
            Undo last change
          </Button>
        ) : <span />}
        <Button size="sm" variant="ghost" leftIcon={<Icon name="settings" size="sm" />} onClick={() => { onClose(); openCustomizeDialog('ai'); }}>
          Settings
        </Button>
      </footer>
    </div>
  );
}
