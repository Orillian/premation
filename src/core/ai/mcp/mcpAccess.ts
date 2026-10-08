/**
 * Who may use Claude for Premation: the paid plan (docs/MCP_PLAN.md D8).
 *
 * The SERVER decides — `CloudAccess.plan`, the same answer the billing screens
 * read — and this only reads the cached decision (`entitlementStore`). It never
 * works out "is this account paid" itself; a second implementation of that
 * would disagree with the server the first time either changed.
 *
 *   • local (self-hosted) edition: no billing, so no gate — the rule every
 *     other gated feature follows (`billingEnabled`);
 *   • signed out: ask to sign in;
 *   • no decision cached yet: fetch it once, then decide;
 *   • `plan === 'pro'`: allowed; anything else: the upgrade sentence.
 */

import { billingEnabled } from '@core/config/edition';
import { isAuthenticated, type CloudAccess } from '@core/api/client';
import { useEntitlementStore } from '@stores/entitlementStore';
import type { AccessDecision } from './mcpHost';

export const NEEDS_PRO =
  'Claude for Premation needs a Premation Pro plan. The user can upgrade in Premation (Settings → Billing); until then these tools are unavailable.';
export const NEEDS_SIGN_IN =
  'Sign in to Premation to use Claude for Premation (it needs a Premation Pro plan).';

/** The decision for a known access record (pure; the table the tests cover). */
export function decideClaudeAccess(opts: { billing: boolean; signedIn: boolean; access: CloudAccess | null }): AccessDecision | 'unknown' {
  if (!opts.billing) return { ok: true };
  if (!opts.signedIn) return { ok: false, message: NEEDS_SIGN_IN };
  if (!opts.access) return 'unknown';
  return opts.access.plan === 'pro' ? { ok: true } : { ok: false, message: NEEDS_PRO };
}

export async function claudeAccess(): Promise<AccessDecision> {
  const read = (): AccessDecision | 'unknown' =>
    decideClaudeAccess({ billing: billingEnabled(), signedIn: isAuthenticated(), access: useEntitlementStore.getState().access });
  let d = read();
  if (d === 'unknown') {
    await useEntitlementStore.getState().refresh();
    d = read();
  }
  // Still nothing (offline at boot): refuse with the reason rather than guess.
  return d === 'unknown' ? { ok: false, message: 'Premation could not confirm the account\'s plan (is it offline?). Try again in a moment.' } : d;
}
