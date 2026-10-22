/**
 * How much of the cloud allowance this account is using, and what that means.
 *
 * Shared by the Billing page and the Settings profile card so the two cannot
 * describe the same allowance in different words. Every number comes from the
 * server (`cloudProjects` on /billing/me, `projectCount` + `access` on
 * /auth/me); this only draws them. The one piece of arithmetic — how many
 * projects are past the cap — is a subtraction of two server numbers, never a
 * second opinion about which projects those are (the project list's per-row
 * `readOnly` says that).
 */

import { Icon } from '@components/Icon';
import { t } from '@core/i18n';
import styles from './CloudUsage.module.css';

export interface CloudUsageProps {
  /** Live cloud projects. */
  used: number;
  /** The cap in force; null = unlimited. */
  limit: number | null;
  /** Days of autosave history the plan keeps. */
  historyDays?: number;
  /**
   * The Free allowance starts applying at this moment (launch grace period).
   * While set, `limit` is the uncapped allowance and `freeLimit` is the one
   * that is coming.
   */
  limitsFrom?: string | null;
  /** The Free plan's cap, for the grace-period sentence. */
  freeLimit?: number | null;
  /** Rendered after the sentences — e.g. an Upgrade button. */
  action?: React.ReactNode;
}

type Level = 'ok' | 'near' | 'full' | 'over';

function levelOf(used: number, limit: number | null): Level {
  if (limit === null || limit <= 0) return 'ok';
  if (used > limit) return 'over';
  if (used === limit) return 'full';
  return used >= limit - 1 ? 'near' : 'ok';
}

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * A translated sentence with the date drawn bold. `{date}` is left out of the
 * vars on purpose, so it survives interpolation and marks where <strong> goes.
 */
function withDate(template: string, date: string): React.ReactNode {
  const at = template.indexOf('{date}');
  if (at < 0) return template;
  return (
    <>
      {template.slice(0, at)}
      <strong>{date}</strong>
      {template.slice(at + '{date}'.length)}
    </>
  );
}

export function CloudUsage({
  used,
  limit,
  historyDays,
  limitsFrom,
  freeLimit,
  action,
}: CloudUsageProps): JSX.Element {
  const level = levelOf(used, limit);
  const capped = limit !== null && limit > 0;
  const fill = capped ? Math.min(100, (used / limit) * 100) : 0;
  const graceCap = limitsFrom && freeLimit != null ? freeLimit : null;

  let note: React.ReactNode = null;
  if (graceCap !== null && limitsFrom) {
    const date = longDate(limitsFrom);
    const extra = used - graceCap;
    note =
      used > graceCap
        ? withDate(
            extra === 1
              ? t('settings.cloudUsage.graceOverOne', 'Free plan limits start on {date}. From then on, your {cap} most recently edited projects stay editable and the other {n} project turns read-only. Nothing is deleted.', { cap: graceCap, n: extra })
              : t('settings.cloudUsage.graceOverOther', 'Free plan limits start on {date}. From then on, your {cap} most recently edited projects stay editable and the other {n} projects turn read-only. Nothing is deleted.', { cap: graceCap, n: extra }),
            date,
          )
        : withDate(
            t('settings.cloudUsage.graceWithin', 'Free plan limits start on {date}: {cap} cloud projects and {days} days of history. You are within them.', { cap: graceCap, days: historyDays ?? 7 }),
            date,
          );
  } else if (level === 'over' && limit !== null) {
    const extra = used - limit;
    note =
      extra === 1
        ? t('settings.cloudUsage.overOne', '{n} project is past your plan and read-only. You can still open and export it; your {limit} most recently edited projects keep saving.', { n: extra, limit })
        : t('settings.cloudUsage.overOther', '{n} projects are past your plan and read-only. You can still open and export them; your {limit} most recently edited projects keep saving.', { n: extra, limit });
  } else if (level === 'full') {
    note = t('settings.cloudUsage.full', 'You have used every cloud project on your plan. New projects can still be saved locally.');
  } else if (level === 'near' && limit !== null) {
    const left = limit - used;
    note =
      left === 1
        ? t('settings.cloudUsage.leftOne', '{n} cloud project left on your plan.', { n: left })
        : t('settings.cloudUsage.leftOther', '{n} cloud projects left on your plan.', { n: left });
  }

  const tone =
    graceCap !== null && used > graceCap ? 'warn' : level === 'over' || level === 'full' ? 'warn' : 'info';

  return (
    <div className={styles.usage}>
      <div className={styles.row}>
        <span className={styles.label}>{t('settings.cloudUsage.projects', 'Cloud projects')}</span>
        <span className={styles.value}>
          {capped ? (
            <>
              {used} <span className={styles.of}>{t('settings.cloudUsage.of', 'of {limit}', { limit })}</span>
            </>
          ) : (
            <>
              {used} <span className={styles.of}>{t('settings.cloudUsage.unlimited', '· unlimited')}</span>
            </>
          )}
        </span>
      </div>
      {capped ? (
        <div
          className={styles.track}
          role="progressbar"
          aria-label={t('settings.cloudUsage.usedAria', 'Cloud projects used')}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
        >
          <div className={`${styles.fill} ${styles[level]}`} style={{ transform: `scaleX(${fill / 100})` }} />
        </div>
      ) : null}
      {historyDays ? (
        <div className={styles.row}>
          <span className={styles.label}>{t('settings.cloudUsage.history', 'Version history')}</span>
          <span className={styles.value}>
            {historyDays === 1
              ? t('settings.cloudUsage.daysOne', '{n} day', { n: historyDays })
              : t('settings.cloudUsage.daysOther', '{n} days', { n: historyDays })}
          </span>
        </div>
      ) : null}
      {note || action ? (
        <div className={`${styles.note} ${tone === 'warn' ? styles.noteWarn : ''}`}>
          {note ? (
            <>
              <Icon name={tone === 'warn' ? 'warning' : 'info'} size="sm" className={styles.noteIcon} />
              <span className={styles.noteText}>{note}</span>
            </>
          ) : (
            <span className={styles.noteText} />
          )}
          {action ? <span className={styles.noteAction}>{action}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
