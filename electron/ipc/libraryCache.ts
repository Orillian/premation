/**
 * Premium library payloads: download, verify, keep.
 *
 * The page asks for `{id, version, tier}`; MAIN asks the backend for the
 * item's download record with the user's session (a Free account gets 402
 * `plan_required` there, which is the real paywall), fetches the bytes from the
 * record's short-lived URL, checks size and sha256, and keeps them under
 * `<userData>/library-cache/<id>/<version>.bin` (temp + rename). The renderer
 * never names a path or a URL.
 *
 * A kept payload whose sha256 the server still answers is reused without
 * downloading again. Offline, a kept payload is used while the account's
 * Premation Cloud entitlement token (the one the engine checks for Cloud
 * plugins) is still inside its `validUntil` — so a paying user keeps working on
 * a plane, and a lapse is honest rather than sudden. Free-tier server items are
 * usable offline whenever they are kept.
 *
 * Never throws across IPC: every failure is an `{ok:false, code, reason}`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { handle } from '../ipcGuard';

export interface LibraryDeps {
  /** `<userData>/library-cache`. */
  dir: () => string;
  /** The API base (`<backendOrigin>/api`). */
  apiBase: () => string;
  authedFetch: (url: string, init: RequestInit) => Promise<Response>;
  publicFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The kept Cloud entitlement's end (epoch ms), or null — `readEntitlement` in nativePluginStore.ts. */
  entitlementValidUntil: () => Promise<number | null>;
  now?: () => number;
  /**
   * Development only: a folder of built packs (`<id>/meta.json`, `payload.*`,
   * `poster.webp`, `preview.mp4`, `preview.ogg`) served as if the backend had
   * them, so new library items can be seen and inserted in a dev build before
   * they are uploaded. Null in a packaged app — never a way around the paywall.
   */
  devPackDir?: () => string | null;
}

export interface PayloadRequest {
  id: string;
  version: number;
  tier: 'free' | 'cloud';
}

export type PayloadOutcome =
  | { ok: true; bytes: Uint8Array; cached: boolean }
  | { ok: false; code: 'plan-required' | 'signed-out' | 'offline' | 'io' | 'bad'; reason: string };

interface DownloadRecord {
  id: string;
  version: number;
  sha256: string;
  size: number;
  url: string;
}

/** Same shape the backend accepts (`pro.<kind>.<slug>`); also what makes `id` safe as a folder name. */
const ID_RE = /^(pro|free)\.(template|lottie|sfx|transition)\.[a-z0-9][a-z0-9-]*$/;
/** Largest payload main will hold in memory (the backend caps packs at 64 MB). */
const MAX_BYTES = 64 * 1024 * 1024;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function parseRequest(req: unknown): PayloadRequest | null {
  const r = (req ?? {}) as Partial<PayloadRequest>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return null;
  if (r.tier !== 'free' && r.tier !== 'cloud') return null;
  return { id: r.id, version: r.version, tier: r.tier };
}

async function readKept(dir: string, id: string, version: number): Promise<{ bytes: Uint8Array; sha: string } | null> {
  try {
    const bytes = new Uint8Array(await readFile(path.join(dir, id, `${version}.bin`)));
    const sha = (await readFile(path.join(dir, id, `${version}.sha256`), 'utf8')).trim();
    // A torn or tampered copy is not a copy.
    return sha256(bytes) === sha ? { bytes, sha } : null;
  } catch {
    return null;
  }
}

async function keep(dir: string, id: string, version: number, bytes: Uint8Array, sha: string): Promise<void> {
  const folder = path.join(dir, id);
  await mkdir(folder, { recursive: true });
  const suffix = `${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const bin = path.join(folder, `${version}.bin`);
  const shaFile = path.join(folder, `${version}.sha256`);
  await writeFile(`${bin}.${suffix}`, bytes);
  await rename(`${bin}.${suffix}`, bin);
  await writeFile(`${shaFile}.${suffix}`, sha);
  await rename(`${shaFile}.${suffix}`, shaFile);
  // Older versions of this item are dead weight once a newer one is kept.
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const v = Number.parseInt(name, 10);
    if (Number.isFinite(v) && v !== version && !name.endsWith('.tmp')) await rm(path.join(folder, name), { force: true });
  }
}

export interface DevPack {
  meta: unknown;
  poster?: Uint8Array;
  preview?: Uint8Array;
  audio?: Uint8Array;
}

async function readOptional(file: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    return undefined;
  }
}

/**
 * Every pack folder under a dev root, by item id: `<root>/<id>/` when the root is
 * itself a packs folder, else `<root>/dist/packs/<id>/` and `<root>/*\/pack/<id>/`
 * (the private library repo's layout). A folder with a rendered preview wins.
 */
async function packFolders(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const consider = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!ID_RE.test(name)) continue;
      const folder = path.join(dir, name);
      const prev = out.get(name);
      if (!prev || (!(await readOptional(path.join(prev, 'preview.mp4'))) && (await readOptional(path.join(folder, 'preview.mp4'))))) out.set(name, folder);
    }
  };
  await consider(root);
  await consider(path.join(root, 'dist', 'packs'));
  for (const sub of await readdir(root).catch(() => [] as string[])) {
    if (sub.startsWith('.') || sub === 'dist' || sub === 'node_modules') continue;
    await consider(path.join(root, sub, 'pack'));
  }
  return out;
}

/** The dev root's packs (meta + preview media); [] without a root. */
export async function readDevPacks(root: string | null | undefined): Promise<DevPack[]> {
  if (!root) return [];
  const out: DevPack[] = [];
  for (const [, folder] of [...(await packFolders(root))].sort(([a], [b]) => a.localeCompare(b))) {
    let meta: unknown;
    try {
      meta = JSON.parse(await readFile(path.join(folder, 'meta.json'), 'utf8'));
    } catch {
      continue;
    }
    const [poster, preview, audio] = await Promise.all([
      readOptional(path.join(folder, 'poster.webp')),
      readOptional(path.join(folder, 'preview.mp4')),
      readOptional(path.join(folder, 'preview.ogg')),
    ]);
    out.push({ meta, ...(poster ? { poster } : {}), ...(preview ? { preview } : {}), ...(audio ? { audio } : {}) });
  }
  return out;
}

async function devPayload(root: string | null | undefined, id: string): Promise<Uint8Array | null> {
  if (!root) return null;
  const folder = (await packFolders(root)).get(id);
  if (!folder) return null;
  for (const file of ['payload.json', 'payload.wav']) {
    const bytes = await readOptional(path.join(folder, file));
    if (bytes) return bytes;
  }
  return null;
}

/** The handler body, exported for the test. */
export function libraryHandlers(deps: LibraryDeps): {
  payload: (req: unknown) => Promise<PayloadOutcome>;
  devCatalog: () => Promise<DevPack[]>;
} {
  const now = deps.now ?? Date.now;
  return {
    devCatalog: () => readDevPacks(deps.devPackDir?.()),
    payload: async (raw) => {
      const req = parseRequest(raw);
      if (!req) return { ok: false, code: 'bad', reason: 'Bad library request.' };
      const dev = await devPayload(deps.devPackDir?.(), req.id);
      if (dev) return { ok: true, bytes: dev, cached: true };
      const dir = deps.dir();
      const base = deps.apiBase();
      const kept = await readKept(dir, req.id, req.version);

      const keptOrOffline = async (why: string): Promise<PayloadOutcome> => {
        if (kept) {
          if (req.tier === 'free') return { ok: true, bytes: kept.bytes, cached: true };
          const until = await deps.entitlementValidUntil();
          if (until !== null && until > now()) return { ok: true, bytes: kept.bytes, cached: true };
        }
        return { ok: false, code: 'offline', reason: why };
      };

      let record: DownloadRecord;
      try {
        const res = await deps.authedFetch(`${base}/library/items/${encodeURIComponent(req.id)}/payload`, { method: 'GET' });
        if (!res.ok) {
          let message = `The library answered ${res.status}.`;
          try {
            const body = JSON.parse(await res.text()) as { message?: unknown };
            if (typeof body.message === 'string') message = body.message;
          } catch { /* not JSON */ }
          if (res.status === 402) return { ok: false, code: 'plan-required', reason: message };
          if (res.status === 401) return { ok: false, code: 'signed-out', reason: message };
          if (res.status >= 500) return keptOrOffline(message);
          return { ok: false, code: 'io', reason: message };
        }
        record = (await res.json()) as DownloadRecord;
      } catch (e) {
        return keptOrOffline(`Could not reach the library: ${(e as Error).message}`);
      }

      if (record.id !== req.id || typeof record.sha256 !== 'string' || typeof record.url !== 'string' || typeof record.size !== 'number') {
        return { ok: false, code: 'bad', reason: 'The library answered for a different item.' };
      }
      if (record.size > MAX_BYTES) return { ok: false, code: 'bad', reason: 'That item is larger than this app accepts.' };
      // The server's version wins: the catalog the page holds may be a few minutes old.
      const version = Number.isInteger(record.version) && record.version >= 1 ? record.version : req.version;
      const current = version === req.version ? kept : await readKept(dir, req.id, version);
      if (current && current.sha === record.sha256) return { ok: true, bytes: current.bytes, cached: true };

      let bytes: Uint8Array;
      try {
        const url = new URL(record.url, base);
        // https, or the API's own origin (a dev backend on http://localhost).
        if (url.protocol !== 'https:' && url.origin !== new URL(base).origin) {
          return { ok: false, code: 'bad', reason: 'The library gave a download link this app will not follow.' };
        }
        const res = await (deps.publicFetch ?? fetch)(url.toString(), { redirect: 'follow' });
        if (!res.ok) return { ok: false, code: 'io', reason: `The download failed (${res.status}).` };
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        return keptOrOffline(`The download failed: ${(e as Error).message}`);
      }
      if (bytes.length !== record.size || sha256(bytes) !== record.sha256) {
        return { ok: false, code: 'bad', reason: 'The download did not match what the library promised.' };
      }
      // Keeping is a convenience; failing to keep must not fail the insert.
      await keep(dir, req.id, version, bytes, record.sha256).catch(() => undefined);
      return { ok: true, bytes, cached: false };
    },
  };
}

export function registerLibraryIpc(deps: LibraryDeps): void {
  const h = libraryHandlers(deps);
  /** One premium payload, downloaded or kept (see the file comment). */
  handle('library:payload', (_e, req: unknown) => h.payload(req));
  /** Development only: the packs in the dev folder ([] in a packaged app). */
  handle('library:devCatalog', () => h.devCatalog());
}
