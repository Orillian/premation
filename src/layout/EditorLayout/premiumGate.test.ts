/**
 * The plan gate every premium insert passes (card, canvas drop, timeline
 * drop): a Pro item for an account without the plan opens the Pro dialog and
 * never reaches the download; a free-tier taster and the local edition pass;
 * a plan not fetched yet is fetched first; and the server's 402 opens the same
 * dialog instead of a toast.
 */

import type { CloudAccess } from '@core/api/client';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';

let billing = true;
let authed = true;
jest.mock('@core/config/edition', () => ({
  ...jest.requireActual('@core/config/edition'),
  billingEnabled: () => billing,
}));
jest.mock('@core/api/client', () => ({
  ...jest.requireActual('@core/api/client'),
  isAuthenticated: () => authed,
}));
const getPremiumPayload = jest.fn();
jest.mock('@core/library/premium/payload', () => ({
  ...jest.requireActual('@core/library/premium/payload'),
  getPremiumPayload: (...a: unknown[]) => getPremiumPayload(...a),
}));

import { PremiumError } from '@core/library/premium/payload';
import { useEntitlementStore } from '@stores/entitlementStore';
import { useProPromptStore } from '@stores/proPromptStore';
import { useUIStore } from '@stores/uiStore';
import { insertPremiumItem, insertPremiumWithToast, premiumGate } from './premiumInsertEdits';

const access = (plan: 'pro' | 'free'): CloudAccess => ({ read: true, write: true, reason: 'active', daysRemaining: null, writeEndsAt: null, plan });

const PRO: PremiumCatalogItem = {
  id: 'pro.sfx.boom', kind: 'sfx', name: 'Boom', category: 'impact', tags: [],
  tier: 'cloud', version: 1, durationSec: 1, description: '',
};
const TASTER: PremiumCatalogItem = { ...PRO, id: 'free.sfx.tick', name: 'Tick', tier: 'free' };

beforeEach(() => {
  billing = true;
  authed = true;
  getPremiumPayload.mockReset();
  useEntitlementStore.setState({ access: null, refresh: async () => undefined });
  useProPromptStore.getState().close();
});

describe('premiumGate', () => {
  it('lets a free-tier taster through for anyone', async () => {
    authed = false;
    await expect(premiumGate(TASTER)).resolves.toBe('allowed');
  });

  it('has no paywall in the local edition', async () => {
    billing = false;
    authed = false;
    await expect(premiumGate(PRO)).resolves.toBe('allowed');
  });

  it('asks a signed-out viewer to sign in', async () => {
    authed = false;
    await expect(premiumGate(PRO)).resolves.toBe('signed-out');
  });

  it('refuses a Free plan and allows Cloud', async () => {
    useEntitlementStore.setState({ access: access('free') });
    await expect(premiumGate(PRO)).resolves.toBe('plan-required');
    useEntitlementStore.setState({ access: access('pro') });
    await expect(premiumGate(PRO)).resolves.toBe('allowed');
  });

  it('fetches a plan that is not known yet before deciding', async () => {
    const refresh = jest.fn(async () => { useEntitlementStore.setState({ access: access('free') }); });
    useEntitlementStore.setState({ access: null, refresh });
    await expect(premiumGate(PRO)).resolves.toBe('plan-required');
    expect(refresh).toHaveBeenCalled();
  });

  it('leaves it to the server when the plan still cannot be fetched (offline)', async () => {
    await expect(premiumGate(PRO)).resolves.toBe('allowed');
  });
});

describe('insertPremiumItem behind the gate', () => {
  it('opens the Pro dialog and never downloads for a Free plan', async () => {
    useEntitlementStore.setState({ access: access('free') });
    const r = await insertPremiumItem(PRO);
    expect(r).toMatchObject({ ok: false, code: 'plan-required' });
    expect(useProPromptStore.getState().item).toBe(PRO);
    expect(getPremiumPayload).not.toHaveBeenCalled();
  });

  it("opens the same dialog on the server's 402, and a drop does not toast it", async () => {
    getPremiumPayload.mockRejectedValueOnce(new PremiumError('plan-required', 'Premation Cloud required'));
    const notify = jest.fn();
    useUIStore.setState({ notify } as never);
    const r = await insertPremiumWithToast(PRO);
    expect(r).toMatchObject({ ok: false, code: 'plan-required' });
    expect(useProPromptStore.getState().item).toBe(PRO);
    expect(notify).not.toHaveBeenCalled();
  });
});
