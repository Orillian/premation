/**
 * "Claude is editing…" — shown over the editor while an MCP client is running
 * a tool or holds an open edit group (docs/MCP_PLAN.md §3.3). Stop aborts the
 * running call and throws the open group away.
 *
 * Also the component that mounts the editor's MCP host, so it renders on every
 * editor page; it draws nothing while Claude is idle (or in a browser build).
 */

import { useMcpHost } from '@hooks/useMcpHost';
import styles from './ClaudeActivityBadge.module.css';

const toolLabel = (name: string): string => name.replace(/_/g, ' ');

export function ClaudeActivityBadge(): JSX.Element | null {
  const { activity, stop } = useMcpHost();
  if (!activity.busy && !activity.group) return null;
  const what = activity.group ? `“${activity.group}”` : activity.tool ? toolLabel(activity.tool) : '';
  return (
    <div className={styles.badge} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.text}>
        Claude is editing{what ? <span className={styles.what}> · {what}</span> : null}
      </span>
      <button type="button" className={styles.stop} onClick={stop} title="Stop Claude and undo its unfinished changes">
        Stop
      </button>
    </div>
  );
}
