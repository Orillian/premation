/**
 * Settings — account on one tab, signed-in devices on another.
 *
 * Plan and assistant connections have their own sidebar pages. This page is
 * who you are and where you are signed in.
 */

import { useSearchParams } from 'react-router-dom';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { billingEnabled } from '@core/config/edition';
import type { AccountRecord } from '@core/api/client';
import { AccountSection, DevicesPanel } from '@layout/Settings/AccountSection';
import { AiSettingsSection } from '@layout/Settings/AiSettingsSection';
import { cn } from '@utils/cn';
import page from './DashboardPage.module.css';
import styles from './DashboardSettings.module.css';

type SettingsSection = 'account' | 'devices';

export interface DashboardSettingsProps {
  user: { name?: string | null; email?: string | null } | null;
  account: AccountRecord | null;
  onAccountChanged: () => void | Promise<void>;
  onOpenBilling: () => void;
  onOpenConnections: () => void;
  onOpenPreferences: () => void;
}

function sectionOf(value: string | null): SettingsSection {
  return value === 'devices' ? 'devices' : 'account';
}

export function DashboardSettings({
  user,
  account,
  onAccountChanged,
  onOpenBilling,
  onOpenConnections,
  onOpenPreferences,
}: DashboardSettingsProps): JSX.Element {
  const [params, setParams] = useSearchParams();
  const section = sectionOf(params.get('section'));

  const select = (next: SettingsSection): void => {
    const q = new URLSearchParams(params);
    q.set('tab', 'settings');
    if (next === 'account') q.delete('section');
    else q.set('section', next);
    setParams(q, { replace: true });
  };

  const displayName = user?.name || user?.email?.split('@')[0] || 'Account';
  const planLabel = account
    ? account.plan === 'pro'
      ? 'Premation Cloud'
      : 'Free plan'
    : null;

  return (
    <div className={page.settingsPanel}>
      <div className={styles.tabs} role="tablist" aria-label="Settings">
        {([
          ['account', 'Account', 'user'],
          ['devices', 'Devices', 'app'],
        ] as const).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={section === id}
            aria-controls={`settings-panel-${id}`}
            className={cn(styles.tab, section === id && styles.tabActive)}
            onClick={() => select(id)}
          >
            <Icon name={icon} size="sm" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {section === 'account' ? (
        <div className={styles.stack} role="tabpanel" id="settings-panel-account" aria-labelledby="settings-tab-account">
          <div className={page.settingsCard} id="account-settings">
            <div className={page.profileHeaderRow}>
              <div className={page.profileAvatarLarge}>
                <Icon name="user" size="lg" />
              </div>
              <div className={page.profileMetaInfo}>
                <div className={page.profileDisplayName}>{displayName}</div>
                <div className={page.profileEmailText}>{user?.email}</div>
                {account && planLabel && (
                  <div className={page.profileNodeBadge}>
                    {`${planLabel} · member since ${new Date(account.createdAt).toLocaleDateString()}`}
                  </div>
                )}
              </div>
              {account && billingEnabled() && (
                <Button className={styles.planAction} variant="secondary" size="sm" onClick={onOpenBilling}>
                  {account.plan === 'pro' ? 'Manage plan' : 'View plan'}
                </Button>
              )}
            </div>

            {account && (
              <div className={page.storageBarSection}>
                <div className={page.storageBarHeader}>
                  <span>Storage</span>
                  <span className={page.monoValue}>
                    {formatBytes(account.storageBytes)} across {account.assetCount} {account.assetCount === 1 ? 'asset' : 'assets'}
                  </span>
                </div>
              </div>
            )}

            {account && (
              <AccountSection
                account={account}
                onAccountChanged={onAccountChanged}
                onOpenBilling={onOpenBilling}
              />
            )}
          </div>

          <div className={page.settingsCard} id="ai-settings">
            <h3 className={page.settingsLabel}>Assistant</h3>
            <AiSettingsSection />
            <p className={page.optionDesc}>
              Claude, Cursor, Antigravity and ChatGPT connect on their own page.
            </p>
            <div className={page.settingsRow}>
              <Button variant="secondary" onClick={onOpenConnections}>
                Open Connections
              </Button>
            </div>
          </div>

          <div className={page.settingsCard}>
            <h3 className={page.settingsLabel}>Editor preferences</h3>
            <p className={page.optionDesc}>
              Appearance, interface scale, panel layout, editing behaviour and keyboard
              shortcuts are on the Preferences page.
            </p>
            <div className={page.settingsRow}>
              <Button variant="secondary" onClick={onOpenPreferences}>
                Open Preferences
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div
          className={page.settingsCard}
          role="tabpanel"
          id="settings-panel-devices"
          aria-labelledby="settings-tab-devices"
        >
          <h3 className={page.settingsLabel}>Signed-in devices</h3>
          <p className={page.optionDesc}>
            Every place this account is signed in. Signing out a device ends that session.
            It does not delete anything on it.
          </p>
          <DevicesPanel />
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
