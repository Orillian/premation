/**
 * "Claude is editing…" over the editor while Claude works, and the place an
 * approval shows up where the user is looking (docs/MCP_PLAN.md §13).
 *
 * Also mounts the editor's MCP host (useMcpHost), so it renders on every
 * editor page; it draws nothing while Claude is idle or turned off.
 */

import { Button } from '@components/Button';
import { useMcpHost } from '@hooks/useMcpHost';
import { mcpFrontDesk } from '@core/ai/mcp/frontDesk';
import { useClaudeStore } from '@stores/claudeStore';
import { claudeToolLabel } from './claude/claudeLabels';
import styles from './claude/Claude.module.css';

export function ClaudeActivityBadge(): JSX.Element | null {
  useMcpHost();
  const desk = useClaudeStore((s) => s.desk);
  const approval = useClaudeStore((s) => s.approvals[0]);
  const answer = useClaudeStore((s) => s.answerApproval);
  const openPanel = useClaudeStore((s) => s.setPanelOpen);

  if (approval) {
    return (
      <div className={styles.badge} data-mode="needs-you" role="alertdialog" aria-label="Claude is asking for permission">
        <span className={styles.dot} data-mode="needs-you" aria-hidden="true" />
        <span className={styles.badgeText}>
          Claude wants to {approval.title.charAt(0).toLowerCase()}{approval.title.slice(1)}
        </span>
        <Button size="sm" variant="ghost" onClick={() => openPanel(true)}>Details</Button>
        <Button size="sm" variant="secondary" onClick={() => answer(approval.id, false)}>Deny</Button>
        <Button size="sm" variant="primary" onClick={() => answer(approval.id, true)}>Allow</Button>
      </div>
    );
  }

  if (!desk.busy && !desk.group) return null;
  const doing = desk.tool ? claudeToolLabel(desk.tool) : 'Thinking';
  return (
    <div className={styles.badge} data-mode="working" role="status" aria-live="polite">
      <span className={styles.dot} data-mode="working" aria-hidden="true" />
      <span className={styles.badgeText}>
        Claude · {doing}
        {desk.group ? <span className={styles.badgeWhat}> — “{desk.group}”</span> : null}
      </span>
      <Button size="sm" variant="secondary" onClick={() => void mcpFrontDesk()?.stop()} title="Stop Claude and undo its unfinished change">
        Stop
      </Button>
    </div>
  );
}
