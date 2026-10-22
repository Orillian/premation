/**
 * The premium shelf's behaviour in the Library: a Free viewer sees the PRO
 * mark, previews, and gets the Pro dialog — never an insert; a Cloud account
 * inserts; a free-tier taster inserts for anyone; the dialog offers the right
 * way in, closes on Esc, and is one dialog over the app; the Free / Pro filter
 * narrows the list.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';

jest.mock('@core/config/edition', () => ({
  ...jest.requireActual('@core/config/edition'),
  billingEnabled: () => true,
  cloudProjectsEnabled: () => true,
}));
jest.mock('@hooks/useProSalesOpen', () => ({ useProSalesOpen: () => true }));
const insertPremiumItem = jest.fn(async () => ({ ok: true, message: 'Inserted' }));
const insertPremiumWithToast = jest.fn(async () => ({ ok: true, message: 'Inserted' }));
jest.mock('./premiumInsertEdits', () => ({
  insertPremiumItem: (...a: unknown[]) => insertPremiumItem(...(a as [])),
  insertPremiumWithToast: (...a: unknown[]) => insertPremiumWithToast(...(a as [])),
  PREMIUM_TRANSITION_PREFIX: 'premium:',
}));

import { PremiumCard, PremiumPromptHost, PremiumSheet } from './LibraryCards';
import { LibraryBrowser } from './LibraryBrowser';
import { useProPromptStore } from '@stores/proPromptStore';

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => undefined });
});
beforeEach(() => {
  insertPremiumItem.mockClear();
  insertPremiumWithToast.mockClear();
  useProPromptStore.getState().close();
});

/** The card itself (its favourite star is a button too, named after the item). */
const card = (): HTMLElement => document.querySelector<HTMLElement>('[data-premium="true"]')!;

const ITEM: PremiumCatalogItem = {
  id: 'pro.template.aurora-title', kind: 'template', name: 'Aurora Title', category: 'Openers', tags: [],
  tier: 'cloud', version: 1, durationSec: 6, aspect: '16:9', width: 1920, height: 1080, fieldCount: 4,
  fieldLabels: ['Title', 'Subtitle'], mode: 'scene', description: 'A cinematic opener.',
  poster: '/library/media/p', preview: '/library/media/v',
};

describe('premium cards', () => {
  it('a Free viewer gets the Pro dialog, never an insert, and cannot drag', () => {
    render(<PremiumCard item={ITEM} access="free" />);
    expect(card().getAttribute('draggable')).toBe('false');
    expect(screen.getByText('PRO')).toBeTruthy();
    fireEvent.click(card());
    expect(useProPromptStore.getState().item).toBe(ITEM);
    expect(insertPremiumItem).not.toHaveBeenCalled();
  });

  it('a signed-out viewer gets the Pro dialog too', () => {
    render(<PremiumCard item={ITEM} access="signedOut" />);
    fireEvent.click(card());
    expect(useProPromptStore.getState().item).toBe(ITEM);
    expect(insertPremiumItem).not.toHaveBeenCalled();
  });

  it('a Cloud account inserts', async () => {
    render(<PremiumCard item={ITEM} access="pro" />);
    expect(card().getAttribute('draggable')).toBe('true');
    fireEvent.click(card());
    expect(insertPremiumItem).toHaveBeenCalledWith(ITEM);
    expect(useProPromptStore.getState().item).toBeNull();
  });

  it('a free-tier taster inserts for a Free viewer and carries no PRO mark', () => {
    const taster = { ...ITEM, id: 'free.template.taster', tier: 'free' as const };
    render(<PremiumCard item={taster} access="free" />);
    expect(screen.queryByText('PRO')).toBeNull();
    expect(card().getAttribute('draggable')).toBe('true');
    fireEvent.click(card());
    expect(insertPremiumItem).toHaveBeenCalledWith(taster);
    expect(useProPromptStore.getState().item).toBeNull();
  });

  it('an unknown plan tries (the insert path decides and opens the dialog itself)', () => {
    render(<PremiumCard item={ITEM} access="unknown" />);
    expect(card().getAttribute('draggable')).toBe('true');
    fireEvent.click(card());
    expect(insertPremiumItem).toHaveBeenCalledWith(ITEM);
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

  it('says plainly that the item is Pro', () => {
    render(<PremiumSheet item={ITEM} access="free" onClose={() => undefined} />);
    expect(screen.getByText('This is a Pro template. Upgrade to Premation Cloud to use it in your projects.')).toBeTruthy();
  });

  it('offers Insert once the plan includes the item', () => {
    const onClose = jest.fn();
    render(<PremiumSheet item={ITEM} access="pro" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(onClose).toHaveBeenCalled();
    expect(insertPremiumWithToast).toHaveBeenCalledWith(ITEM);
  });

  it('is one dialog over the app, opened from anywhere through the store', () => {
    render(<PremiumPromptHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useProPromptStore.getState().open(ITEM));
    const dialog = screen.getByRole('dialog', { name: 'Aurora Title' });
    expect(dialog.closest('body')).toBe(document.body);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(useProPromptStore.getState().item).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
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
