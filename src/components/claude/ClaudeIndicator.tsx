/**
 * The Claude pill in the title bar, on every page (docs/MCP_PLAN.md §13).
 *
 *   Ready      Premation is waiting for Claude (open Claude Desktop)
 *   Connected  a Claude is on the line
 *   Working    Claude is running a tool or holds an open change
 *   Needs you  Claude asked for something only the user may allow
 *
 * Click it for the activity panel: what is happening now, approvals, the
 * recent steps, undo and Stop. Draws nothing while Claude is turned off — the
 * Settings card is where it gets turned on.
 */

import { useMemo } from 'react';
import { Popover } from '@components/Popover';
import { claudeMode, useClaudeStore, type ClaudeMode } from '@stores/claudeStore';
import { claudeToolLabel } from './claudeLabels';
import { ClaudePanel } from './ClaudePanel';
import styles from './Claude.module.css';

const LABEL: Record<ClaudeMode, string> = {
  off: 'Claude',
  setup: 'Claude',
  ready: 'Claude',
  connected: 'Claude',
  working: 'Claude',
  'needs-you': 'Claude needs you',
};

const TITLE: Record<ClaudeMode, string> = {
  off: 'Claude for Premation is off',
  setup: 'Finish connecting Claude',
  ready: 'Claude for Premation is ready — open Claude Desktop and ask it to work in Premation',
  connected: 'Claude is connected',
  working: 'Claude is working in this project',
  'needs-you': 'Claude is waiting for your answer',
};

export function ClaudeIndicator(): JSX.Element | null {
  const setup = useClaudeStore((s) => s.setup);
  const desk = useClaudeStore((s) => s.desk);
  const approvals = useClaudeStore((s) => s.approvals.length);
  const open = useClaudeStore((s) => s.panelOpen);
  const setOpen = useClaudeStore((s) => s.setPanelOpen);
  const mode = useMemo(() => claudeMode(setup, desk, approvals), [setup, desk, approvals]);

  if (mode === 'off') return null;
  const doing = mode === 'working' ? (desk.tool ? claudeToolLabel(desk.tool) : desk.group ? `“${desk.group}”` : 'Working') : null;

  return (
    <Popover
      placement="bottom-end"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className={styles.pill}
          data-mode={mode}
          title={TITLE[mode]}
          aria-label={`${TITLE[mode]}. Open Claude activity.`}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.pillText}>{LABEL[mode]}</span>
          {doing ? <span className={styles.pillDoing}>{doing}</span> : null}
        </button>
      }
    >
      <ClaudePanel mode={mode} onClose={() => setOpen(false)} />
    </Popover>
  );
}
