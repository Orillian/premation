/**
 * Premium library payloads in main: the backend's 402 is the paywall, bytes
 * are checked against the record's size and sha256, a kept copy is reused
 * without downloading, and offline a kept copy works only while the Cloud
 * entitlement token is inside its validUntil.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('./ipcGuard', () => ({ handle: jest.fn() }));

import { libraryHandlers, type LibraryDeps } from './ipc/libraryCache';

const BASE = 'https://api.example.com/api';
const BYTES = new TextEncoder().encode('{"v":1,"doc":{}}');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const REQ = { id: 'pro.lottie.success-burst', version: 1, tier: 'cloud' as const };

let dir = '';
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'libcache-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A minimal fetch Response (the jsdom test environment has no global Response). */
function res(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}
function json(status: number, body: unknown): Response {
  return res(status, new TextEncoder().encode(JSON.stringify(body)));
}

function deps(over: Partial<LibraryDeps> = {}): LibraryDeps & { downloads: number } {
  const d = {
    downloads: 0,
    dir: () => dir,
    apiBase: () => BASE,
    authedFetch: jest.fn(async () => json(200, { id: REQ.id, version: 1, sha256: SHA, size: BYTES.length, url: 'https://cdn.example.com/x' })),
    publicFetch: jest.fn(async () => { d.downloads += 1; return res(200, BYTES); }),
    entitlementValidUntil: async () => null,
    now: () => Date.parse('2026-10-21T00:00:00Z'),
    ...over,
  };
  return d;
}

describe('library payload cache', () => {
  it('downloads, verifies and keeps a payload; the next ask reuses it', async () => {
    const d = deps();
    const h = libraryHandlers(d);
    const first = await h.payload(REQ);
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(existsSync(path.join(dir, REQ.id, '1.bin'))).toBe(true);
    const second = await h.payload(REQ);
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(d.downloads).toBe(1);
  });

  it('turns a 402 into plan-required, and 401 into signed-out', async () => {
    const h402 = libraryHandlers(deps({ authedFetch: async () => json(402, { code: 'plan_required', message: 'Needs Cloud' }) }));
    expect(await h402.payload(REQ)).toEqual({ ok: false, code: 'plan-required', reason: 'Needs Cloud' });
    const h401 = libraryHandlers(deps({ authedFetch: async () => json(401, { message: 'Sign in' }) }));
    expect(await h401.payload(REQ)).toMatchObject({ ok: false, code: 'signed-out' });
  });

  it('refuses bytes that do not match the record', async () => {
    const h = libraryHandlers(deps({ publicFetch: async () => res(200, new TextEncoder().encode('tampered!!!!!!!!')) }));
    expect(await h.payload(REQ)).toMatchObject({ ok: false, code: 'bad' });
    expect(existsSync(path.join(dir, REQ.id, '1.bin'))).toBe(false);
  });

  it('refuses a non-https link to another origin', async () => {
    const h = libraryHandlers(deps({ authedFetch: async () => json(200, { id: REQ.id, version: 1, sha256: SHA, size: BYTES.length, url: 'http://evil.example.com/x' }) }));
    expect(await h.payload(REQ)).toMatchObject({ ok: false, code: 'bad' });
  });

  it('offline: a kept copy works only inside the entitlement window', async () => {
    await libraryHandlers(deps()).payload(REQ);
    const offline = async () => { throw new TypeError('fetch failed'); };
    const lapsed = libraryHandlers(deps({ authedFetch: offline, entitlementValidUntil: async () => Date.parse('2026-10-01T00:00:00Z') }));
    expect(await lapsed.payload(REQ)).toMatchObject({ ok: false, code: 'offline' });
    const valid = libraryHandlers(deps({ authedFetch: offline, entitlementValidUntil: async () => Date.parse('2026-11-01T00:00:00Z') }));
    expect(await valid.payload(REQ)).toMatchObject({ ok: true, cached: true });
    const free = libraryHandlers(deps({ authedFetch: offline }));
    expect(await free.payload({ ...REQ, id: REQ.id, tier: 'free' })).toMatchObject({ ok: true, cached: true });
  });

  it('rejects malformed requests without touching the network', async () => {
    const d = deps();
    const h = libraryHandlers(d);
    expect(await h.payload({ id: '../../etc/passwd', version: 1, tier: 'cloud' })).toMatchObject({ ok: false, code: 'bad' });
    expect(await h.payload({ ...REQ, version: 0 })).toMatchObject({ ok: false, code: 'bad' });
    expect(d.authedFetch).not.toHaveBeenCalled();
  });

  it('drops older versions once a newer one is kept', async () => {
    await libraryHandlers(deps()).payload(REQ);
    const v2 = libraryHandlers(deps({ authedFetch: async () => json(200, { id: REQ.id, version: 2, sha256: SHA, size: BYTES.length, url: 'https://cdn.example.com/x' }) }));
    expect(await v2.payload(REQ)).toMatchObject({ ok: true });
    expect(existsSync(path.join(dir, REQ.id, '2.bin'))).toBe(true);
    expect(existsSync(path.join(dir, REQ.id, '1.bin'))).toBe(false);
  });
});
