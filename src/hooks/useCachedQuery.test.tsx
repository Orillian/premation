/**
 * useCachedQuery — the dashboard pages' "come back to content, not a skeleton".
 *
 * Runs on the real cache (src/core/api/cache.ts) with only the network mocked,
 * so what is counted here is what a navigation actually costs.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

const conditionalGet = jest.fn();
jest.mock('@core/api/transport', () => ({
  conditionalGet: (...args: unknown[]) => conditionalGet(...args),
}));

import { cachedGet, clear, invalidate } from '@core/api/cache';
import { peekQuery, prefetchQuery, resetCachedQueriesForTests, useCachedQuery } from './useCachedQuery';

let served: Record<string, unknown>;
function serve(path: string, data: unknown): void {
  served[path] = data;
}

beforeEach(() => {
  clear();
  resetCachedQueriesForTests();
  served = {};
  conditionalGet.mockReset();
  conditionalGet.mockImplementation((path: string) =>
    Promise.resolve({ data: served[path], etag: undefined, notModified: false }),
  );
});
afterEach(cleanup);

const fetchPlan = (): Promise<{ plan: string }> => cachedGet('/billing/me', { tags: ['billing'] });

function Plan({ onRender }: { onRender?: (state: string) => void }): JSX.Element {
  const q = useCachedQuery('test:plan', fetchPlan, { tags: ['billing'] });
  const state = q.loading ? 'loading' : (q.data?.plan ?? `error:${q.error}`);
  onRender?.(state);
  return <span data-testid="plan">{state}</span>;
}

describe('useCachedQuery', () => {
  it('loads once, then a remount paints the last answer on its first render with no request', async () => {
    serve('/billing/me', { plan: 'free' });
    const first = render(<Plan />);
    expect(screen.getByTestId('plan').textContent).toBe('loading');
    await waitFor(() => expect(screen.getByTestId('plan').textContent).toBe('free'));
    first.unmount();
    expect(conditionalGet).toHaveBeenCalledTimes(1);

    const frames: string[] = [];
    render(<Plan onRender={(s) => frames.push(s)} />);
    // The very first frame of the second visit already has the data.
    expect(frames[0]).toBe('free');
    await act(async () => {});
    expect(frames).not.toContain('loading');
    // Inside the TTL the revalidation on mount is a cache hit.
    expect(conditionalGet).toHaveBeenCalledTimes(1);
  });

  it('refetches after a mutation invalidates its tag — even while unmounted', async () => {
    serve('/billing/me', { plan: 'free' });
    const view = render(<Plan />);
    await waitFor(() => expect(screen.getByTestId('plan').textContent).toBe('free'));
    view.unmount();

    // The user upgrades on another screen; the mutation dirties `billing`.
    serve('/billing/me', { plan: 'pro' });
    await act(async () => {
      invalidate('billing');
    });
    await waitFor(() => expect(peekQuery<{ plan: string }>('test:plan')?.plan).toBe('pro'));

    const frames: string[] = [];
    render(<Plan onRender={(s) => frames.push(s)} />);
    expect(frames[0]).toBe('pro');
  });

  it('updates a mounted screen in place when its tag is invalidated', async () => {
    serve('/billing/me', { plan: 'free' });
    render(<Plan />);
    await waitFor(() => expect(screen.getByTestId('plan').textContent).toBe('free'));
    serve('/billing/me', { plan: 'pro' });
    await act(async () => {
      invalidate('billing');
    });
    await waitFor(() => expect(screen.getByTestId('plan').textContent).toBe('pro'));
  });

  it('ignores invalidations of unrelated tags', async () => {
    serve('/billing/me', { plan: 'free' });
    render(<Plan />);
    await waitFor(() => expect(screen.getByTestId('plan').textContent).toBe('free'));
    const calls = conditionalGet.mock.calls.length;
    await act(async () => {
      invalidate('plugins', 'trash');
    });
    expect(conditionalGet.mock.calls.length).toBe(calls);
  });

  it('forgets everything on sign-out, so the next account never sees it', async () => {
    serve('/billing/me', { plan: 'pro' });
    const view = render(<Plan />);
    await waitFor(() => expect(screen.getByTestId('plan').textContent).toBe('pro'));
    view.unmount();

    // Sign-out: the next fetch must not land before we look, so hold it.
    conditionalGet.mockImplementation(() => new Promise(() => {}));
    const calls = conditionalGet.mock.calls.length;
    act(() => clear());
    expect(peekQuery('test:plan')).toBeUndefined();
    // Ending the session refetches nothing on the old session's behalf.
    expect(conditionalGet.mock.calls.length).toBe(calls);
    render(<Plan />);
    expect(screen.getByTestId('plan').textContent).toBe('loading');
  });

  it('keeps the last answer on screen when a refresh fails', async () => {
    serve('/billing/me', { plan: 'free' });
    render(<Plan />);
    await waitFor(() => expect(screen.getByTestId('plan').textContent).toBe('free'));
    conditionalGet.mockImplementation(() => Promise.reject(new Error('offline')));
    await act(async () => {
      invalidate('billing');
    });
    expect(screen.getByTestId('plan').textContent).toBe('free');
  });

  it('shows the error when there is nothing to fall back on', async () => {
    conditionalGet.mockImplementation(() => Promise.reject(new Error('offline')));
    render(<Plan />);
    await waitFor(() => expect(screen.getByTestId('plan').textContent).toBe('error:offline'));
  });

  it('a prefetch makes the first visit instant', async () => {
    serve('/billing/me', { plan: 'pro' });
    await prefetchQuery('test:plan', fetchPlan, ['billing']);
    const frames: string[] = [];
    render(<Plan onRender={(s) => frames.push(s)} />);
    expect(frames[0]).toBe('pro');
    await act(async () => {});
    expect(conditionalGet).toHaveBeenCalledTimes(1);
  });

  it('a disabled query fetches nothing', async () => {
    function Off(): JSX.Element {
      const q = useCachedQuery('test:off', fetchPlan, { tags: ['billing'], enabled: false });
      return <span data-testid="off">{q.loading ? 'loading' : String(q.data)}</span>;
    }
    render(<Off />);
    await act(async () => {});
    expect(screen.getByTestId('off').textContent).toBe('undefined');
    expect(conditionalGet).not.toHaveBeenCalled();
  });
});
