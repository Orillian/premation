/**
 * After sign-in with the welcome question owed, the dashboard came up blank
 * until a reload (2026-10-13 QA, real app). The gate had rendered
 * <Navigate to="/welcome">, which navigated; the sign-in page's own
 * navigate('/dashboard') then landed on the same path before React rendered
 * /welcome, so the SAME <Navigate> element stayed mounted — it navigates only
 * when it mounts — and rendered nothing. The gate's redirect is keyed by the
 * location now: a new location is a new redirect.
 */

import { act, render } from '@testing-library/react';
import { Route, Router, Routes, type Navigator } from 'react-router-dom';
import { RequireAuth } from '../RequireAuth';
import { useAuthStore } from '@stores/authStore';

jest.mock('@core/config/edition', () => ({ ...jest.requireActual('@core/config/edition'), cloudAccountsEnabled: () => true }));

const at = (pathname: string, key: string) => ({ pathname, search: '', hash: '', state: null, key });

it('redirects to the welcome question again when a navigation lands back on the gated path', () => {
  useAuthStore.setState({
    status: 'authenticated',
    error: null,
    user: { id: 'u1', email: 'a@b.c', name: 'Ada', role: 'user', emailVerified: true, needsSignupSource: true } as never,
  });
  const replace = jest.fn();
  const navigator = { push: jest.fn(), replace, go: jest.fn(), createHref: (t: unknown) => String(t) } as unknown as Navigator;
  const tree = (key: string) => (
    <Router location={at('/dashboard', key)} navigator={navigator}>
      <Routes>
        <Route path="/dashboard" element={<RequireAuth><p>dashboard</p></RequireAuth>} />
      </Routes>
    </Router>
  );
  const { rerender, container } = render(tree('k1'));
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace.mock.calls[0]![0]).toMatchObject({ pathname: '/welcome' });
  expect(container.textContent).toBe('');

  // The sign-in page's late navigate('/dashboard', { replace: true }): the same path, a new location.
  act(() => { rerender(tree('k2')); });
  expect(replace).toHaveBeenCalledTimes(2);
  expect(replace.mock.calls[1]![0]).toMatchObject({ pathname: '/welcome' });
});
