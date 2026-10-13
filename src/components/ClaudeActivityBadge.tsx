/**
 * An approval, over the editor, when an assistant needs Allow or Deny
 * (docs/MCP_PLAN.md §13). The working line lives in the status bar.
 *
 * Also mounts the editor's MCP host (useMcpHost), so it renders on every
 * editor page; it draws nothing while the assistant is idle or turned off.
 */

import { useEffect } from 'react';
import { Button } from '@components/Button';
import { useMcpHost } from '@hooks/useMcpHost';
import { useClaudeStore } from '@stores/claudeStore';
import { assistantName } from './claude/claudeLabels';
import styles from './claude/Claude.module.css';

export function ClaudeActivityBadge(): JSX.Element | null {
  useMcpHost();
  const setup = useClaudeStore((s) => s.setup);
  const desk = useClaudeStore((s) => s.desk);
  const approval = useClaudeStore((s) => s.approvals[0]);
  const answer = useClaudeStore((s) => s.answerApproval);
  const openPanel = useClaudeStore((s) => s.setPanelOpen);
  const working = desk.busy || !!desk.group;

  // New timeline rows read this so they ease in only while an assistant is
  // actually adding them. The working line itself lives in the status bar.
  useEffect(() => {
    const root = document.documentElement;
    if (working) root.dataset.assistant = 'working';
    else delete root.dataset.assistant;
    return () => { delete root.dataset.assistant; };
  }, [working]);

  if (!approval) return null;
  const name = assistantName(setup);
  return (
    <div className={styles.badge} data-mode="needs-you" role="alertdialog" aria-label={`${name} is asking for permission`}>
      <span className={styles.dot} data-mode="needs-you" aria-hidden="true" />
      <span className={styles.badgeText}>
        {name} wants to {approval.title.charAt(0).toLowerCase()}{approval.title.slice(1)}
      </span>
      <Button size="sm" variant="ghost" onClick={() => openPanel(true)}>Details</Button>
      <Button size="sm" variant="secondary" onClick={() => answer(approval.id, false)}>Deny</Button>
      <Button size="sm" variant="primary" onClick={() => answer(approval.id, true)}>Allow</Button>
    </div>
  );
}
