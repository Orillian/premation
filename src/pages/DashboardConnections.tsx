/**
 * Connections — Claude, Cursor, Antigravity and ChatGPT on this computer.
 *
 * One page, not a stack at the bottom of Settings. The desktop app is the
 * only place a local assistant can be started; a browser build says so.
 */

import { Button } from '@components/Button';
import { billingEnabled } from '@core/config/edition';
import { CLAUDE_REQUIRES_PRO } from '@core/ai/mcp/mcpAccess';
import type { AccountRecord } from '@core/api/client';
import { ClaudeConnectSection } from '@layout/Settings/ClaudeConnectSection';
import { McpAppsSection } from '@layout/Settings/McpAppsSection';
import styles from './DashboardConnections.module.css';

export function DashboardConnections({
  account,
  onOpenBilling,
}: {
  account: AccountRecord | null;
  onOpenBilling: () => void;
}): JSX.Element {
  const desktop = typeof window !== 'undefined' && window.motionEditor?.mcp != null;
  const pro = account?.plan === 'pro' || account?.access.reason === 'granted';
  const locked = CLAUDE_REQUIRES_PRO && billingEnabled() && account != null && !pro;

  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        An assistant edits the project you have open. You watch each change, and you can stop it.
        The connection stays on this computer.
      </p>

      {billingEnabled() && account && (
        <div className={styles.plan} data-plan={pro ? 'pro' : 'free'}>
          <span className={styles.planName}>{pro ? 'Premation Cloud' : 'Free plan'}</span>
          <span className={styles.planDetail}>
            {locked
              ? 'Assistant connections are part of Premation Cloud.'
              : 'Assistant connections are free on every plan.'}
          </span>
          {locked && (
            <Button variant="secondary" size="sm" onClick={onOpenBilling}>
              View plans
            </Button>
          )}
        </div>
      )}

      {desktop ? (
        <div className={styles.list}>
          <ClaudeConnectSection />
          <McpAppsSection />
        </div>
      ) : (
        <p className={styles.desktopOnly}>
          Open the Premation app on this computer to connect an assistant. A browser tab cannot start one.
        </p>
      )}
    </div>
  );
}
