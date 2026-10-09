/** The paid-plan gate's decision table (docs/MCP_PLAN.md D8). */

import type { CloudAccess } from '@core/api/client';
import { setDevBuild } from '@core/config/devBuild';
import { CLAUDE_REQUIRES_PRO, NEEDS_PRO, NEEDS_SIGN_IN, decideClaudeAccess, mcpDevPlan, parseMcpDevPlan, setMcpDevPlan } from './mcpAccess';

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
  it('with the Pro requirement on: waits for the server when nothing is cached yet', () => {
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: null, requirePro: true })).toBe('unknown');
  });
  it('with the Pro requirement on: allows Pro and refuses Free (and a server that sends no plan)', () => {
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: access('pro'), requirePro: true })).toEqual({ ok: true });
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: access('free'), requirePro: true })).toEqual({ ok: false, message: NEEDS_PRO });
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: access(undefined), requirePro: true })).toEqual({ ok: false, message: NEEDS_PRO });
  });
  it('with the Pro requirement off: lets any signed-in account in, Free included', () => {
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: access('free'), requirePro: false })).toEqual({ ok: true });
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: null, requirePro: false })).toEqual({ ok: true });
    expect(decideClaudeAccess({ billing: true, signedIn: false, access: null, requirePro: false })).toEqual({ ok: false, message: NEEDS_SIGN_IN });
  });
  it('is off for now: a Free account may use Claude', () => {
    expect(CLAUDE_REQUIRES_PRO).toBe(false);
    expect(decideClaudeAccess({ billing: true, signedIn: true, access: access('free') })).toEqual({ ok: true });
  });
});

describe('the development plan override (VITE_MCP_DEV_PLAN)', () => {
  afterEach(() => { setMcpDevPlan(null); setDevBuild(false); });

  it('parses pro and free, and nothing else', () => {
    expect(parseMcpDevPlan(' PRO ')).toBe('pro');
    expect(parseMcpDevPlan('free')).toBe('free');
    expect(parseMcpDevPlan('enterprise')).toBeNull();
    expect(parseMcpDevPlan(undefined)).toBeNull();
  });

  it('lets a dev use Claude signed out on the server edition, or forces the refusal', () => {
    expect(decideClaudeAccess({ billing: true, signedIn: false, access: null, devPlan: 'pro' })).toEqual({ ok: true });
    const refused = decideClaudeAccess({ billing: false, signedIn: true, access: access('pro'), devPlan: 'free' });
    expect(refused).toMatchObject({ ok: false });
  });

  it('is ignored outside a development build, whatever was set', () => {
    setMcpDevPlan('pro');
    setDevBuild(false);
    expect(mcpDevPlan()).toBeNull();
    setDevBuild(true);
    expect(mcpDevPlan()).toBe('pro');
  });
});
