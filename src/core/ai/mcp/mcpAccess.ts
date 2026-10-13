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
 *   • `plan === 'pro'`: allowed; anything else: the upgrade sentence —
 *     only while `CLAUDE_REQUIRES_PRO` is on (it is off: assistant
 *     connections are on the Free plan).
 *
 * DEVELOPMENT ONLY: `VITE_MCP_DEV_PLAN=pro` (or `free`) in `.env.local` stands in
 * for the server's answer, so the MCP can be used — or the refusal tested —
 * without a paid account or a backend. `main.tsx` passes it in only when
 * `import.meta.env.DEV`, and it is ignored again here unless `isDevBuild()`:
 * a production bundle never reads it, whatever its environment held.
 */

import { billingEnabled } from '@core/config/edition';
import { isDevBuild } from '@core/config/devBuild';
import { isAuthenticated, type CloudAccess } from '@core/api/client';
import { useEntitlementStore } from '@stores/entitlementStore';
import type { AccessDecision } from './mcpHost';

export const NEEDS_PRO =
  'Claude for Premation needs a Premation Pro plan. The user can upgrade in Premation (Settings → Billing); until then these tools are unavailable.';
export const NEEDS_SIGN_IN =
  'Sign in to Premation to use Claude for Premation.';

/**
 * Is Claude for Premation a Pro-only feature? No — assistant connections
 * (Claude, ChatGPT, Cursor, Antigravity) are on the Free plan (owner decisions
 * 2026-10-08, confirmed 2026-10-13); Premation's own plugins are what the paid
 * plan adds. Every signed-in account may use it. Turning it
 * back on is this one line — the gate, its messages, the Settings card notice
 * and the tests all follow it.
 */
export const CLAUDE_REQUIRES_PRO = false;

/** A development build's stand-in for the server's plan answer. */
export type McpDevPlan = 'pro' | 'free';

let devPlan: McpDevPlan | null = null;

/** Parse `VITE_MCP_DEV_PLAN`: `pro` or `free`, anything else is no override. */
export function parseMcpDevPlan(raw: string | undefined | null): McpDevPlan | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'pro' || v === 'free' ? v : null;
}

/** Set at boot by `main.tsx` (dev builds only); also the test seam. */
export function setMcpDevPlan(plan: McpDevPlan | null): void {
  devPlan = plan;
}

/** The override in force: only ever in a development build. */
export function mcpDevPlan(): McpDevPlan | null {
  return isDevBuild() ? devPlan : null;
}

/** The decision for a known access record (pure; the table the tests cover). */
export function decideClaudeAccess(opts: {
  billing: boolean;
  signedIn: boolean;
  access: CloudAccess | null;
  devPlan?: McpDevPlan | null;
  requirePro?: boolean;
}): AccessDecision | 'unknown' {
  if (opts.devPlan === 'pro') return { ok: true };
  if (opts.devPlan === 'free') return { ok: false, message: `${NEEDS_PRO} (Development override: VITE_MCP_DEV_PLAN=free.)` };
  if (!opts.billing) return { ok: true };
  if (!opts.signedIn) return { ok: false, message: NEEDS_SIGN_IN };
  if (!(opts.requirePro ?? CLAUDE_REQUIRES_PRO)) return { ok: true };
  if (!opts.access) return 'unknown';
  return opts.access.plan === 'pro' ? { ok: true } : { ok: false, message: NEEDS_PRO };
}

export async function claudeAccess(): Promise<AccessDecision> {
  const read = (): AccessDecision | 'unknown' =>
    decideClaudeAccess({ billing: billingEnabled(), signedIn: isAuthenticated(), access: useEntitlementStore.getState().access, devPlan: mcpDevPlan() });
  let d = read();
  if (d === 'unknown') {
    await useEntitlementStore.getState().refresh();
    d = read();
  }
  // Still nothing (offline at boot): refuse with the reason rather than guess.
  return d === 'unknown' ? { ok: false, message: 'Premation could not confirm the account\'s plan (is it offline?). Try again in a moment.' } : d;
}
