/**
 * "Your plan" on the Settings (profile) page.
 *
 * A summary, not a second Billing page: which plan, how much of its cloud
 * allowance is used, and the one action that matters from here — Upgrade for
 * someone on Free while sales are open, otherwise a way to the Billing page.
 * Checkout, cancel and resume stay on Billing, where the confirmations live.
 *
 * Everything is the server's: `account` is /auth/me (plan, access,
 * projectCount) and the catalog is /billing/plans (cached for an hour), used
 * only for the paid plan's name/price and the Free cap during the grace period.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { api, paidSalesOpen, type AccountRecord, type PlanDto } from '@core/api/client';
import { t } from '@core/i18n';
import { CloudUsage } from './CloudUsage';
import styles from './PlanCard.module.css';

interface PlanCardProps {
  account: AccountRecord;
  /** Open the dashboard's Billing page. */
  onOpenBilling: () => void;
}

/** The badge under the plan name, from the server's entitlement reason. */
export function planStatusLabel(account: Pick<AccountRecord, 'access'>): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (account.access.reason) {
    case 'active':
      return { text: t('settings.plan.active', 'Active'), tone: 'ok' };
    // Cancelled-at-period-end and a failed card both land here; Billing says which.
    case 'grace':
      return { text: t('settings.plan.ending', 'Ending'), tone: 'warn' };
    case 'beta':
      return { text: t('settings.plan.beta', 'Free during beta'), tone: 'muted' };
    case 'staff':
      return { text: t('settings.plan.operator', 'Operator'), tone: 'muted' };
    case 'granted':
      return { text: t('settings.plan.included', 'Included'), tone: 'ok' };
    case 'unverified':
      return { text: t('settings.plan.unverified', 'Email not confirmed'), tone: 'warn' };
    default:
      return { text: t('settings.plan.free', 'Free'), tone: 'muted' };
  }
}

export function PlanCard({ account, onOpenBilling }: PlanCardProps): JSX.Element {
  const [plans, setPlans] = useState<PlanDto[]>([]);

  useEffect(() => {
    let live = true;
    api
      .listPlans()
      .then((list) => {
        if (live) setPlans(list);
      })
      .catch(() => {
        /* The card still renders from /auth/me; only the upgrade price is missing. */
      });
    return () => {
      live = false;
    };
  }, []);

  const { access } = account;
  const paid = account.plan === 'pro' || account.access.reason === 'granted';
  const paidPlan = plans.find((p) => p.priceCents > 0);
  const freeCap = plans.find((p) => p.priceCents === 0)?.limits?.cloudProjects ?? null;
  const salesOpen = paidSalesOpen(plans);
  const status = planStatusLabel(account);
  const isBeta = access.reason === 'beta';
  const name = paid ? (paidPlan?.name ?? 'Premation Cloud') : t('settings.plan.free', 'Free');

  const canUpgrade = !paid && !isBeta && salesOpen && paidPlan !== undefined;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>{t('settings.plan.eyebrow', 'Your plan')}</span>
          <div className={styles.titleRow}>
            <h3 className={styles.planName}>{name}</h3>
            <span className={`${styles.badge} ${status.tone === 'muted' ? '' : styles[status.tone]}`}>{status.text}</span>
          </div>
          <p className={styles.sub}>
            {paid
              ? access.writeEndsAt
                ? access.reason === 'grace'
                  ? t('settings.plan.paidThrough', 'Paid through {date}. See Billing for details.', { date: new Date(access.writeEndsAt).toLocaleDateString() })
                  : access.reason === 'granted'
                    ? t('settings.plan.includedUntil', 'Included until {date}. See Billing for details.', { date: new Date(access.writeEndsAt).toLocaleDateString() })
                    : t('settings.plan.renews', 'Renews {date}. See Billing for details.', { date: new Date(access.writeEndsAt).toLocaleDateString() })
                : t('settings.plan.paidSub', 'Unlimited cloud projects and long version history.')
              : isBeta
                ? t('settings.plan.betaSub', 'Cloud saving is free and uncapped while paid plans are not open yet.')
                : t('settings.plan.freeSub', 'The editor is free forever. Premation Cloud adds unlimited cloud projects and longer history.')}
          </p>
        </div>
        <div className={styles.headActions}>
          {canUpgrade ? (
            <Button variant="primary" size="sm" onClick={onOpenBilling}>
              {t('settings.plan.upgrade', 'Upgrade · {price}/mo', { price: paidPlan.priceLabel })}
            </Button>
          ) : null}
          <Button variant={canUpgrade ? 'ghost' : 'secondary'} size="sm" onClick={onOpenBilling}>
            {paid ? t('settings.plan.manage', 'Manage plan') : t('settings.plan.view', 'View plans')}
          </Button>
        </div>
      </div>

      {access.limits && !isBeta ? (
        <CloudUsage
          used={account.projectCount}
          limit={access.limits.cloudProjects}
          historyDays={access.limits.historyDays}
          limitsFrom={access.limitsFrom ?? null}
          freeLimit={freeCap}
        />
      ) : null}
    </div>
  );
}
