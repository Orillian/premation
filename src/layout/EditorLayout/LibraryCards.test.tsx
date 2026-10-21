/**
 * The premium shelf's behaviour in the Library: a Free viewer sees the PRO
 * mark, previews, and gets the Premium sheet — never an insert; a Cloud
 * account inserts; the sheet offers the right way in and closes on Esc; the
 * Free / Pro filter narrows the list.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';

jest.mock('@core/config/edition', () => ({
  ...jest.requireActual('@core/config/edition'),
  billingEnabled: () => true,
  cloudProjectsEnabled: () => true,
}));
jest.mock('@hooks/useProSalesOpen', () => ({ useProSalesOpen: () => true }));
const insertPremiumItem = jest.fn(async () => ({ ok: true, message: 'Inserted' }));
jest.mock('./premiumInsertEdits', () => ({
  insertPremiumItem: (...a: unknown[]) => insertPremiumItem(...(a as [])),
  PREMIUM_TRANSITION_PREFIX: 'premium:',
}));

import { PremiumCard, PremiumSheet } from './LibraryCards';
import { LibraryBrowser } from './LibraryBrowser';

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => undefined });
});
beforeEach(() => insertPremiumItem.mockClear());

/** The card itself (its favourite star is a button too, named after the item). */
const card = (): HTMLElement => document.querySelector<HTMLElement>('[data-premium="true"]')!;

const ITEM: PremiumCatalogItem = {
  id: 'pro.template.aurora-title', kind: 'template', name: 'Aurora Title', category: 'Openers', tags: [],
  tier: 'cloud', version: 1, durationSec: 6, aspect: '16:9', width: 1920, height: 1080, fieldCount: 4,
  fieldLabels: ['Title', 'Subtitle'], mode: 'scene', description: 'A cinematic opener.',
  poster: '/library/media/p', preview: '/library/media/v',
};

describe('premium cards', () => {
  it('a Free viewer gets the sheet, never an insert, and cannot drag', () => {
    const onLocked = jest.fn();
    render(<PremiumCard item={ITEM} access="free" onLocked={onLocked} />);
    expect(card().getAttribute('draggable')).toBe('false');
    expect(screen.getByText('PRO')).toBeTruthy();
    fireEvent.click(card());
    expect(onLocked).toHaveBeenCalledWith(ITEM);
    expect(insertPremiumItem).not.toHaveBeenCalled();
  });

  it('a Cloud account inserts', async () => {
    const onLocked = jest.fn();
    render(<PremiumCard item={ITEM} access="pro" onLocked={onLocked} />);
    expect(card().getAttribute('draggable')).toBe('true');
    fireEvent.click(card());
    expect(insertPremiumItem).toHaveBeenCalledWith(ITEM);
    expect(onLocked).not.toHaveBeenCalled();
  });

  it('an unknown plan tries, and a refusal opens the sheet', async () => {
    insertPremiumItem.mockResolvedValueOnce({ ok: false, code: 'plan-required', message: 'no' } as never);
    const onLocked = jest.fn();
    render(<PremiumCard item={ITEM} access="unknown" onLocked={onLocked} />);
    fireEvent.click(card());
    await Promise.resolve();
    await Promise.resolve();
    expect(onLocked).toHaveBeenCalledWith(ITEM);
  });
});

describe('the Premium sheet', () => {
  it('offers Premation Cloud to a Free viewer, lists the fields, closes on Esc', () => {
    const onClose = jest.fn();
    render(<PremiumSheet item={ITEM} access="free" onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Aurora Title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get Premation Cloud' })).toBeTruthy();
    expect(screen.getByText(/You can edit: Title, Subtitle/)).toBeTruthy();
    expect(screen.getByText(/new composition/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('asks a signed-out viewer to sign in', () => {
    render(<PremiumSheet item={ITEM} access="signedOut" onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('the Free / Pro filter', () => {
  it('narrows the list to premium or bundled items', () => {
    const items = [
      { id: 'a', name: 'Alpha', cat: 'x', tier: 'cloud' as const },
      { id: 'b', name: 'Beta', cat: 'x' },
    ];
    render(
      <LibraryBrowser items={items} categories={['x']} noun="template" showTier>
        {(list) => <ul>{list.map((i) => <li key={i.id}>{i.name}</li>)}</ul>}
      </LibraryBrowser>,
    );
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Free' }));
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByText('Beta')).toBeTruthy();
  });
});
