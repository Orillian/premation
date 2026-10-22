/**
 * The status bar's working line: who is connected, and the step they are on.
 *
 * The title-bar pill only names the assistant. This is the place the current
 * task is read, so it stays one quiet row instead of a second floating chip.
 */

import { mcpFrontDesk } from '@core/ai/mcp/frontDesk';
import { useClaudeStore } from '@stores/claudeStore';
import { assistantName, claudeToolLabel } from '@components/claude/claudeLabels';
import { t } from '@core/i18n';
import styles from './EditorStatusBar.module.css';

export function AssistantWorkLine(): JSX.Element | null {
  const setup = useClaudeStore((s) => s.setup);
  const desk = useClaudeStore((s) => s.desk);
  if (!desk.busy && !desk.group) return null;

  const name = assistantName(setup);
  const doing = desk.tool ? claudeToolLabel(desk.tool) : t('statusBar.assistant.thinking', 'Thinking');

  return (
    <span className={styles.work} role="status" aria-live="polite">
      <span className={styles.workDot} data-mode="working" aria-hidden="true" />
      <span className={styles.workName}>{name}</span>
      <span className={styles.dot} aria-hidden="true">·</span>
      <span className={styles.workTask}>{doing}</span>
      {desk.group ? <span className={styles.workGroup} title={desk.group}>{desk.group}</span> : null}
      <button
        type="button"
        className={styles.workStop}
        onClick={() => void mcpFrontDesk()?.stop()}
        title={t('statusBar.assistant.stopTitle', 'Stop {name} and undo its unfinished change', { name })}
      >
        {t('statusBar.assistant.stop', 'Stop')}
      </button>
    </span>
  );
}
