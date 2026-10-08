/** The paid-plan gate's decision table (docs/MCP_PLAN.md D8). */

import type { CloudAccess } from '@core/api/client';
import { NEEDS_PRO, NEEDS_SIGN_IN, decideClaudeAccess } from './mcpAccess';

const access = (plan: CloudAccess['plan']): CloudAccess => ({
  read: true, write: true, reason: 'active' as CloudAccess['reason'], daysRemaining: null, writeEndsAt: null, plan,
});

describe('decideClaudeAccess', () => {
  it('lets the local edition (no billing) through', () => {
    expect(decideClaudeAccess({ billing: false, signedIn: false, access: null })).toEqual({ ok: true });
  });
  it('asks a signed-out user to sign in', () => {
    expect(decideClaudeAccess({ billing: true, signedIn: false, access: null })).toEqual({ ok: false, message: NEEDS_SIGN_IN });
  });
  it('waits for the server when nothing is cached yet', () => {
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: null })).toBe('unknown');
  });
  it('allows Pro and refuses Free (and a server that sends no plan)', () => {
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: access('pro') })).toEqual({ ok: true });
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: access('free') })).toEqual({ ok: false, message: NEEDS_PRO });
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: access(undefined) })).toEqual({ ok: false, message: NEEDS_PRO });
  });
});
