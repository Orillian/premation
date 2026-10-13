/**
 * premation://connections, the page half: which screen the link lands on.
 *
 * The rule worth pinning is the editor's. A web page can open this link at any
 * moment, so it must never be able to pull an open project out from under the
 * user — over the editor it opens Settings ▸ AI Engine, and only the dashboard
 * itself (or the bare root) is navigated.
 */

import { render, act, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { setEdition } from '@core/config/edition';
import { connectionsDestination, useConnectionsDeepLink } from './useConnectionsDeepLink';

const openCustomizeDialog = jest.fn();
jest.mock('@layout/Settings/openCustomizeDialog', () => ({
  openCustomizeDialog: (...args: unknown[]) => openCustomizeDialog(...args),
}));

describe('connectionsDestination', () => {
  it.each([
    ['/dashboard', 'dashboard'],
    ['/dashboard/', 'dashboard'],
    ['/', 'dashboard'],
    ['/editor', 'settings'],
    ['/editor/3f2a-project', 'settings'],
    ['/login', 'stay'],
    ['/register', 'stay'],
    ['/oauth', 'stay'],
    ['/verify-email', 'stay'],
    ['/welcome', 'stay'],
    ['/reset-password', 'stay'],
    ['/editorial', 'stay'],
  ] as const)('server edition, on %s → %s', (route, expected) => {
    expect(connectionsDestination(route, true)).toBe(expected);
  });

  it.each(['/', '/editor', '/editor/abc'])('local edition (no dashboard), on %s → settings', (route) => {
    expect(connectionsDestination(route, false)).toBe('settings');
  });
});

describe('useConnectionsDeepLink', () => {
  let subscribers: Set<() => void>;

  beforeEach(() => {
    subscribers = new Set();
    openCustomizeDialog.mockClear();
    (window as unknown as { motionEditor: unknown }).motionEditor = {
      deepLink: {
        onOpenConnections: (handler: () => void) => {
          subscribers.add(handler);
          return () => subscribers.delete(handler);
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    setEdition('server');
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  });

  function Where(): JSX.Element {
    const { pathname, search } = useLocation();
    return <p data-testid="where">{pathname + search}</p>;
  }

  function Harness(): JSX.Element {
    useConnectionsDeepLink();
    return <Where />;
  }

  function renderAt(path: string): void {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  const fire = (): void => act(() => { subscribers.forEach((h) => h()); });

  it('on the dashboard, opens the Connections tab', () => {
    renderAt('/dashboard?tab=projects');
    fire();
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard?tab=connections');
    expect(openCustomizeDialog).not.toHaveBeenCalled();
  });

  it('over the editor, opens Settings ▸ AI Engine and leaves the project where it is', async () => {
    renderAt('/editor/p1');
    fire();
    await waitFor(() => expect(openCustomizeDialog).toHaveBeenCalledWith('ai'));
    expect(screen.getByTestId('where')).toHaveTextContent('/editor/p1');
  });

  it('in the local edition, opens Settings ▸ AI Engine', async () => {
    setEdition('local');
    renderAt('/editor');
    fire();
    await waitFor(() => expect(openCustomizeDialog).toHaveBeenCalledWith('ai'));
    expect(screen.getByTestId('where')).toHaveTextContent('/editor');
  });

  it('on the sign-in page, stays (no navigation, no dialog)', async () => {
    renderAt('/login');
    fire();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('where')).toHaveTextContent('/login');
    expect(openCustomizeDialog).not.toHaveBeenCalled();
  });

  it('subscribes once, and lets go on unmount', () => {
    renderAt('/dashboard');
    expect(subscribers.size).toBe(1);
    cleanup();
    expect(subscribers.size).toBe(0);
  });

  it('does nothing without the desktop bridge', () => {
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    expect(() => renderAt('/dashboard')).not.toThrow();
  });
});
