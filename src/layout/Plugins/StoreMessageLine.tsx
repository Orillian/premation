/**
 * The line under the Plugins page / panel toolbar after an install, uninstall
 * or plan check. A store refusal for want of Premation Cloud (402
 * `plan_required`) carries the way out: an Upgrade button to the dashboard's
 * Plan page (docs/PLUGIN_PLATFORM_PLAN.md P3: "Included with Premation Cloud —
 * Upgrade"), not only the text.
 */

import { useNavigate } from 'react-router-dom';
import { Button } from '@components/Button';
import { billingEnabled, cloudProjectsEnabled } from '@core/config/edition';
import type { StoreMessage } from '@hooks/usePluginStore';
import styles from './NativePlugins.module.css';

function UpgradeButton(): JSX.Element {
  const navigate = useNavigate();
  return (
    <Button size="sm" variant="primary" onClick={() => navigate('/dashboard?tab=billing')}>
      Upgrade
    </Button>
  );
}

export function StoreMessageLine({ message }: { message: StoreMessage | null }): JSX.Element | null {
  if (!message) return null;
  const text = (
    <span className={message.error ? styles.error : styles.message} role={message.error ? 'alert' : 'status'}>
      {message.text}
    </span>
  );
  // /dashboard exists only under cloudProjectsEnabled() (AppRouter).
  if (!message.upgrade || !billingEnabled() || !cloudProjectsEnabled()) return text;
  return (
    <div className={styles.toolbar}>
      {text}
      <UpgradeButton />
    </div>
  );
}
