/**
 * useCachedQuery — a screen's last answer, kept across remounts.
 *
 * `cachedGet` already dedupes and serves stale data, but it is a promise: a
 * component that starts in `useState(null)` paints its skeleton for at least
 * one frame even on a cache hit, and every dashboard tab switch unmounts the
 * page that held the answer. So Billing, Home, Devices and the plugin store
 * blinked to "loading" on every visit although nothing had changed.
 *
 * This hook keeps the last RESULT (after whatever combining or mapping the
 * fetcher does) in a module-scope memo keyed by a string, and seeds the first
 * render from it. The fetcher runs on mount anyway — through `cachedGet`, so
 * inside the TTL that costs no request, and past it one conditional GET —
 * and the screen only updates if the answer changed.
 *
 * Freshness after a mutation rides the cache's tags: every write in
 * `client.ts` invalidates the tags it dirties, the cache notifies, and every
 * memo entry under those tags refetches — mounted or not, so going back to a
 * page after changing the plan shows the new plan, not the old one first.
 * The memo is dropped wholesale when the cache's session generation changes
 * (sign-out, any 401), so one account's data never seeds another's screen.
 */

import { useCallback, useEffect, useState } from 'react';
import { generation, subscribe, type CacheTag } from '@core/api/cache';

interface MemoEntry {
  data?: unknown;
  hasData: boolean;
  error: string | null;
  /** The newest fetcher for this key — what a tag invalidation re-runs. */
  fetcher: () => Promise<unknown>;
  tags: readonly CacheTag[];
  inflight: Promise<void> | null;
  /** Set when a refresh was asked for while one was running. */
  again: boolean;
  listeners: Set<() => void>;
}

const memo = new Map<string, MemoEntry>();
let memoGeneration = generation();
let cacheSubscribed = false;

/** Drop everything remembered under a previous session. True when it did. */
function checkGeneration(): boolean {
  const current = generation();
  if (current === memoGeneration) return false;
  memoGeneration = current;
  for (const entry of memo.values()) {
    entry.data = undefined;
    entry.hasData = false;
    entry.error = null;
    entry.listeners.forEach((fn) => fn());
  }
  return true;
}

function ensureSubscribed(): void {
  if (cacheSubscribed) return;
  cacheSubscribed = true;
  subscribe((changed) => {
    // Sign-out (or a 401) notifies every tag. That is the old session ending,
    // not data going stale: forget it, and fetch nothing on its behalf — the
    // screens that mount next ask under the new session.
    if (checkGeneration()) return;
    const set = new Set(changed);
    for (const [key, entry] of memo) {
      if (entry.tags.some((t) => set.has(t))) void refreshKey(key);
    }
  });
}

function readable(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Re-run a key's fetcher and publish the answer. Single-flight per key: a
 * request made while one is running is folded into one more run afterwards, so
 * the last word is always from a fetch that started after the last change.
 */
function refreshKey(key: string): Promise<void> {
  const entry = memo.get(key);
  if (!entry) return Promise.resolve();
  if (entry.inflight) {
    entry.again = true;
    return entry.inflight;
  }
  const started = generation();
  const run = entry
    .fetcher()
    .then(
      (data) => {
        // A response that left before sign-out belongs to the old session.
        if (generation() !== started) return;
        const changed = !entry.hasData || entry.data !== data || entry.error !== null;
        entry.data = data;
        entry.hasData = true;
        entry.error = null;
        if (changed) entry.listeners.forEach((fn) => fn());
      },
      (err: unknown) => {
        if (generation() !== started) return;
        // A failed refresh keeps the last good answer on screen; only a screen
        // with nothing to show surfaces the error.
        entry.error = readable(err, 'Request failed');
        entry.listeners.forEach((fn) => fn());
      },
    )
    .finally(() => {
      entry.inflight = null;
      if (entry.again) {
        entry.again = false;
        void refreshKey(key);
      }
    });
  entry.inflight = run;
  return run;
}

function entryFor(key: string, fetcher: () => Promise<unknown>, tags: readonly CacheTag[]): MemoEntry {
  ensureSubscribed();
  checkGeneration();
  let entry = memo.get(key);
  if (!entry) {
    entry = { hasData: false, error: null, fetcher, tags, inflight: null, again: false, listeners: new Set() };
    memo.set(key, entry);
  } else {
    entry.fetcher = fetcher;
    entry.tags = tags;
  }
  return entry;
}

/** What a key last resolved to, if anything — for seeding state outside the hook. */
export function peekQuery<T>(key: string): T | undefined {
  checkGeneration();
  const entry = memo.get(key);
  return entry?.hasData ? (entry.data as T) : undefined;
}

/**
 * Warm a key before its screen mounts (a hovered nav link). Cheap by
 * construction: the fetcher goes through `cachedGet`, so a warm key costs
 * nothing and a cold one is the request the click was about to make anyway.
 */
export function prefetchQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  tags: readonly CacheTag[] = [],
): Promise<void> {
  const entry = entryFor(key, fetcher, tags);
  if (entry.inflight) return entry.inflight;
  return refreshKey(key);
}

export interface CachedQuery<T> {
  data: T | undefined;
  /** Only when there is nothing to show yet: the first load of this key. */
  loading: boolean;
  /** The last fetch failed. `data` may still hold the answer before it. */
  error: string | null;
  /** Refetch now. Pair with a `force`d client call to skip the HTTP cache too. */
  reload: () => Promise<void>;
}

export interface UseCachedQueryOptions {
  /** Cache tags whose invalidation means this answer is out of date. */
  tags?: readonly CacheTag[];
  /** False skips fetching (signed out, edition without the feature). */
  enabled?: boolean;
}

/**
 * The fetcher should read through `cachedGet` (the `api.*` reads do); it may
 * combine several. It need not be stable — the newest one is used — but the
 * KEY must name everything the answer depends on (ids, filters, pages).
 *
 * Never pass `force` inside the fetcher: a forced read always comes back as new
 * data, which notifies its tags, which re-runs the fetcher. To bypass the HTTP
 * cache (after a checkout), make the forced call first, then `reload()` — the
 * fetcher then reads the value the forced call just stored.
 */
export function useCachedQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  { tags = [], enabled = true }: UseCachedQueryOptions = {},
): CachedQuery<T> {
  // A disabled query registers nothing, so a tag change cannot run its fetcher
  // behind a screen that said not to (signed out, the local edition).
  const entry = enabled ? entryFor(key, fetcher, tags) : undefined;
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const current = memo.get(key);
    if (!current) return undefined;
    const bump = (): void => setVersion((v) => v + 1);
    current.listeners.add(bump);
    // Revalidate on every mount: a cache hit is free, a stale one is the
    // background refresh that keeps this from showing an old answer forever.
    void refreshKey(key);
    return () => {
      current.listeners.delete(bump);
    };
  }, [key, enabled]);

  const reload = useCallback(() => refreshKey(key), [key]);

  if (!entry) return { data: undefined, loading: false, error: null, reload };
  return {
    data: entry.hasData ? (entry.data as T) : undefined,
    loading: !entry.hasData && entry.error === null,
    error: entry.error,
    reload,
  };
}

/** Test hook: forget every remembered answer. */
export function resetCachedQueriesForTests(): void {
  memo.clear();
  memoGeneration = generation();
}
