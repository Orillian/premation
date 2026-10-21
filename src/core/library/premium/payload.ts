/**
 * Getting a premium item's payload — the part only an entitled account may
 * have.
 *
 * Desktop: Electron main does all of it (electron/ipc/libraryCache.ts) — the
 * session-authenticated download record, the bytes, the sha256 check and the
 * on-disk copy that keeps working offline. Browser build: the same steps here,
 * with no disk copy.
 *
 * The backend's 402 is the paywall; this only turns its answer into a
 * `PremiumError` the panel can word ("Get Premation Cloud", "Sign in", "You're
 * offline"). Parsed payloads are memoised by id@version for the session, so a
 * second insert of the same item is instant.
 */

import { request } from '@core/api/transport';
import { parsePayload, type PremiumCatalogItem, type PremiumPayload } from './packFormat';

export type PremiumErrorCode = 'plan-required' | 'signed-out' | 'offline' | 'io' | 'bad';

export class PremiumError extends Error {
  constructor(readonly code: PremiumErrorCode, message: string) {
    super(message);
    this.name = 'PremiumError';
  }
}

const memo = new Map<string, Promise<PremiumPayload>>();
const memoKey = (item: Pick<PremiumCatalogItem, 'id' | 'version'>): string => `${item.id}@${item.version}`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchInPage(item: PremiumCatalogItem): Promise<Uint8Array> {
  let record: { id: string; sha256: string; size: number; url: string };
  try {
    record = await request(`/library/items/${encodeURIComponent(item.id)}/payload`);
  } catch (e) {
    const status = (e as { status?: number }).status;
    const message = (e as Error).message;
    if (status === 402) throw new PremiumError('plan-required', message);
    if (status === 401) throw new PremiumError('signed-out', message);
    if (status === 0) throw new PremiumError('offline', message);
    throw new PremiumError('io', message);
  }
  if (record.id !== item.id) throw new PremiumError('bad', 'The library answered for a different item.');
  let bytes: Uint8Array;
  try {
    const res = await fetch(record.url);
    if (!res.ok) throw new PremiumError('io', `The download failed (${res.status}).`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof PremiumError) throw e;
    throw new PremiumError('offline', `The download failed: ${(e as Error).message}`);
  }
  if (bytes.length !== record.size || (await sha256Hex(bytes)) !== record.sha256) {
    throw new PremiumError('bad', 'The download did not match what the library promised.');
  }
  return bytes;
}

async function fetchBytes(item: PremiumCatalogItem): Promise<Uint8Array> {
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.library : undefined;
  if (bridge?.payload) {
    const res = await bridge.payload({ id: item.id, version: item.version, tier: item.tier });
    if (!res.ok) throw new PremiumError(res.code, res.reason);
    return res.bytes;
  }
  return fetchInPage(item);
}

/** The item's parsed payload. Rejects with a `PremiumError`. */
export function getPremiumPayload(item: PremiumCatalogItem): Promise<PremiumPayload> {
  const key = memoKey(item);
  const hit = memo.get(key);
  if (hit) return hit;
  const p = fetchBytes(item).then((bytes) => {
    try {
      return parsePayload(item.kind, bytes);
    } catch (e) {
      throw new PremiumError('bad', `This item could not be read: ${(e as Error).message}`);
    }
  });
  memo.set(key, p);
  // A failure is not remembered: the next click asks again (after an upgrade, say).
  p.catch(() => memo.delete(key));
  return p;
}

/** Forget memoised payloads — after sign-out, so the next account cannot reuse them. */
export function forgetPremiumPayloads(): void {
  memo.clear();
}
