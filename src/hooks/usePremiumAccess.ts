/**
 * Who is looking at a premium library item, and what they may do with it.
 *
 * Premium items are shown to everyone — the preview is the sales pitch — but
 * only a Premation Cloud account can insert one. The backend is the real gate
 * (a payload download answers 402 `plan_required`); this decides what the card
 * and the Premium sheet offer, so a Free account sees "Get Premation Cloud"
 * instead of a download that is about to be refused.
 *
 *   `local`     — the local edition: no accounts, no server, no premium shelf.
 *   `signedOut` — server edition, nobody signed in: offer sign-in.
 *   `unknown`   — signed in, the plan has not been fetched yet.
 *   `free`      — signed in without Cloud: offer the upgrade.
 *   `pro`       — may insert.
 */

import { useEffect } from 'react';
import { isAuthenticated } from '@core/api/client';
import { billingEnabled, cloudProjectsEnabled } from '@core/config/edition';
import { isPaidPlan, useEntitlementStore } from '@stores/entitlementStore';
import { useAuthStore } from '@stores/authStore';

export type PremiumAccess = 'local' | 'signedOut' | 'unknown' | 'free' | 'pro';

export function premiumAccessOf(opts: {
  billing: boolean;
  signedIn: boolean;
  access: Parameters<typeof isPaidPlan>[0];
}): PremiumAccess {
  if (!opts.billing) return 'local';
  if (!opts.signedIn) return 'signedOut';
  if (!opts.access) return 'unknown';
  return isPaidPlan(opts.access) ? 'pro' : 'free';
}

export function usePremiumAccess(): PremiumAccess {
  const access = useEntitlementStore((s) => s.access);
  const refresh = useEntitlementStore((s) => s.refresh);
  // Subscribed so the state flips the moment someone signs in or out.
  const user = useAuthStore((s) => s.user);
  const signedIn = !!user && isAuthenticated();
  useEffect(() => {
    if (signedIn && !access) void refresh();
  }, [signedIn, access, refresh]);
  return premiumAccessOf({ billing: billingEnabled(), signedIn, access });
}

/**
 * Billing lives on the dashboard, which only the cloud edition registers.
 * Through the hash (AppRouter is a HashRouter) so it also works from surfaces
 * rendered outside a router. Null where there is nowhere to go.
 */
export function useOpenBilling(): (() => void) | null {
  if (!billingEnabled() || !cloudProjectsEnabled()) return null;
  return () => { window.location.hash = '#/dashboard?tab=billing'; };
}

/** The sign-in page, for a signed-out viewer of a premium item. Null outside the server edition. */
export function useOpenSignIn(): (() => void) | null {
  if (!billingEnabled()) return null;
  return () => { window.location.hash = '#/login'; };
}
