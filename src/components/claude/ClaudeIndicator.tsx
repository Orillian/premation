/**
 * The assistant pill in the title bar, on every page (docs/MCP_PLAN.md §13).
 *
 * It names whoever is connected — Claude, Cursor, Antigravity, ChatGPT —
 * and nothing else. What they are doing lives in the status bar.
 *
 * Click it for the activity panel: what is happening now, approvals, the
 * recent steps, undo and Stop. Draws nothing while Claude is turned off — the
 * Settings card is where it gets turned on.
 */

import { useMemo } from 'react';
import { Popover } from '@components/Popover';
import { claudeMode, useClaudeStore, type ClaudeMode } from '@stores/claudeStore';
import { assistantName, claudeToolLabel } from './claudeLabels';
import { ClaudePanel } from './ClaudePanel';
import { t } from '@core/i18n';
import styles from './Claude.module.css';

function titles(brand: string): Record<ClaudeMode, string> {
  return {
    off: t('ui.claude.indicator.off', '{name} for Premation is off', { name: brand }),
    setup: t('ui.claude.indicator.setup', 'Finish connecting {name}', { name: brand }),
    ready: t('ui.claude.canWork', '{name} can work in Premation. Ask it in a new chat.', { name: brand }),
    connected: t('ui.claude.indicator.connected', '{name} is connected', { name: brand }),
    working: t('ui.claude.indicator.working', '{name} is working in this project', { name: brand }),
    'needs-you': t('ui.claude.indicator.waiting', '{name} is waiting for your answer', { name: brand }),
  };
}

export function ClaudeIndicator(): JSX.Element | null {
  const setup = useClaudeStore((s) => s.setup);
  const desk = useClaudeStore((s) => s.desk);
  const approvals = useClaudeStore((s) => s.approvals.length);
  const open = useClaudeStore((s) => s.panelOpen);
  const setOpen = useClaudeStore((s) => s.setPanelOpen);
  const mode = useMemo(() => claudeMode(setup, desk, approvals), [setup, desk, approvals]);
  const brand = useMemo(() => assistantName(setup), [setup]);

  if (mode === 'off') return null;
  const doing = mode === 'working' ? (desk.tool ? claudeToolLabel(desk.tool) : desk.group ? `“${desk.group}”` : t('ui.claude.indicator.workingShort', 'Working')) : null;
  const title = doing ? `${brand} · ${doing}` : titles(brand)[mode];

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
          title={title}
          aria-label={t('ui.claude.indicator.openActivity', '{title}. Open activity.', { title })}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.pillText}>{mode === 'needs-you' ? t('ui.claude.indicator.needsYou', '{name} needs you', { name: brand }) : brand}</span>
        </button>
      }
    >
      <ClaudePanel mode={mode} onClose={() => setOpen(false)} />
    </Popover>
  );
}
