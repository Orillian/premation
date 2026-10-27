/**
 * The read-through cache: what a navigation costs, and what a mutation clears.
 *
 * The dashboard's "instant navigation" rests on three promises pinned here:
 * a fresh hit issues no request, a stale hit returns at once and refreshes
 * behind it (conditionally, so a 304 keeps the same object), and a tag
 * invalidation or sign-out drops exactly what it should.
 */

const conditionalGet = jest.fn();
jest.mock('./transport', () => ({
  conditionalGet: (...args: unknown[]) => conditionalGet(...args),
}));

import { cachedGet, clear, generation, invalidate, put, stats, subscribe } from './cache';

function ok(data: unknown, etag = 'W/"1"') {
  return Promise.resolve({ data, etag, notModified: false });
}

beforeEach(() => {
  clear();
  conditionalGet.mockReset();
  jest.useRealTimers();
});

describe('cachedGet', () => {
  it('serves a fresh hit without a request', async () => {
    conditionalGet.mockReturnValueOnce(ok({ plan: 'pro' }));
    const first = await cachedGet('/billing/me', { tags: ['billing'] });
    const second = await cachedGet('/billing/me', { tags: ['billing'] });
    expect(second).toBe(first);
    expect(conditionalGet).toHaveBeenCalledTimes(1);
  });

  it('shares one request between callers in the same tick', async () => {
    conditionalGet.mockReturnValueOnce(ok([1, 2]));
    const [a, b] = await Promise.all([cachedGet('/auth/sessions'), cachedGet('/auth/sessions')]);
    expect(a).toBe(b);
    expect(conditionalGet).toHaveBeenCalledTimes(1);
  });

  it('returns stale data at once and revalidates with the ETag', async () => {
    jest.useFakeTimers({ now: 1_000 });
    conditionalGet.mockReturnValueOnce(ok({ v: 1 }, 'W/"a"'));
    const first = await cachedGet('/plugins', { ttlMs: 10 });
    jest.setSystemTime(2_000);
    conditionalGet.mockReturnValueOnce(Promise.resolve({ notModified: true, etag: 'W/"a"' }));
    const second = await cachedGet('/plugins', { ttlMs: 10 });
    expect(second).toBe(first);
    expect(conditionalGet).toHaveBeenLastCalledWith('/plugins', 'W/"a"');
  });

  it('keeps the same object after a 304, so nothing re-renders', async () => {
    jest.useFakeTimers({ now: 1_000 });
    conditionalGet.mockReturnValueOnce(ok({ v: 1 }, 'W/"a"'));
    const first = await cachedGet('/billing/plans', { ttlMs: 10, tags: ['billing'] });
    const heard = jest.fn();
    const off = subscribe(heard);
    jest.setSystemTime(2_000);
    conditionalGet.mockReturnValueOnce(Promise.resolve({ notModified: true, etag: 'W/"a"' }));
    await cachedGet('/billing/plans', { ttlMs: 10, tags: ['billing'], force: false });
    // Let the background revalidation settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(heard).not.toHaveBeenCalled();
    expect(await cachedGet('/billing/plans', { ttlMs: 60_000 })).toBe(first);
    off();
  });

  it('force skips a fresh entry', async () => {
    conditionalGet.mockReturnValueOnce(ok({ v: 1 })).mockReturnValueOnce(ok({ v: 2 }));
    await cachedGet('/billing/me');
    expect(await cachedGet('/billing/me', { force: true })).toEqual({ v: 2 });
    expect(conditionalGet).toHaveBeenLastCalledWith('/billing/me', undefined);
  });
});

describe('invalidation', () => {
  it('drops only entries under the invalidated tags and notifies them', async () => {
    conditionalGet.mockReturnValueOnce(ok('billing')).mockReturnValueOnce(ok('plugins'));
    await cachedGet('/billing/me', { tags: ['billing', 'account'] });
    await cachedGet('/plugins', { tags: ['plugins'] });
    const heard = jest.fn();
    const off = subscribe(heard);

    invalidate('account');
    expect(heard).toHaveBeenCalledWith(['account']);
    expect(stats().entries).toBe(1);

    conditionalGet.mockReturnValueOnce(ok('billing 2'));
    expect(await cachedGet('/billing/me', { tags: ['billing'] })).toBe('billing 2');
    expect(await cachedGet('/plugins', { tags: ['plugins'] })).toBe('plugins');
    expect(conditionalGet).toHaveBeenCalledTimes(3);
    off();
  });

  it('put stores a mutation result as fresh', async () => {
    put('/auth/me', { name: 'New' }, ['account']);
    expect(await cachedGet('/auth/me')).toEqual({ name: 'New' });
    expect(conditionalGet).not.toHaveBeenCalled();
  });

  it('clear empties everything and moves the session generation', async () => {
    conditionalGet.mockReturnValueOnce(ok('x'));
    await cachedGet('/auth/me', { tags: ['account'] });
    const before = generation();
    const heard = jest.fn();
    const off = subscribe(heard);
    clear();
    expect(generation()).toBe(before + 1);
    expect(stats().entries).toBe(0);
    expect(heard.mock.calls[0][0]).toEqual(expect.arrayContaining(['account', 'billing', 'sessions', 'plugins']));
    off();
  });

  it('a 401 clears the cache', async () => {
    conditionalGet.mockReturnValueOnce(ok('x'));
    await cachedGet('/auth/me', { tags: ['account'] });
    const before = generation();
    conditionalGet.mockReturnValueOnce(Promise.reject(Object.assign(new Error('gone'), { status: 401 })));
    await expect(cachedGet('/auth/sessions')).rejects.toThrow('gone');
    expect(generation()).toBe(before + 1);
    expect(stats().entries).toBe(0);
  });
});
