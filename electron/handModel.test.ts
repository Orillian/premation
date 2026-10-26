/**
 * Live input's hand models on disk (handModel.ts): two PINNED downloads —
 * exact revisions and SHA-256s; a mismatch on either installs nothing, a
 * good pair installs both with the metadata last, removal empties the folder.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Hex } from './depthModel';
import {
  HAND_MODEL_FILE, HAND_MODEL_PINS, PALM_MODEL_FILE, handModelUserDir, installHandModel, readHandModelInstall, removeHandModel,
  type PinnedFile,
} from './handModel';

const PALM = new Uint8Array([0x08, 0x07, ...new Array(30).fill(2)]);
const HAND = new Uint8Array([0x08, 0x07, ...new Array(40).fill(3)]);

const realFetch = globalThis.fetch;
/** Answers each URL with its bytes. */
function stubFetch(byUrl: Record<string, Uint8Array>): void {
  globalThis.fetch = (async (url: string) => {
    const bytes = byUrl[url] ?? new Uint8Array();
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => String(bytes.byteLength) },
      body: (async function* () { yield bytes; })(),
    };
  }) as unknown as typeof fetch;
}

const pins = (palmSha: string, handSha: string): PinnedFile[] => [
  { file: PALM_MODEL_FILE, url: 'https://models.example/palm.onnx', sha256: palmSha, bytes: PALM.byteLength },
  { file: HAND_MODEL_FILE, url: 'https://models.example/hand.onnx', sha256: handSha, bytes: HAND.byteLength },
];

let root = '';
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'hm-')); });
afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true });
});

describe('handModel', () => {
  it('pins both files to an exact Hugging Face revision of OpenCV Zoo and a SHA-256', () => {
    expect(HAND_MODEL_PINS.map((p) => p.file)).toEqual([PALM_MODEL_FILE, HAND_MODEL_FILE]);
    for (const p of HAND_MODEL_PINS) {
      expect(p.url).toMatch(/^https:\/\/huggingface\.co\/opencv\/[a-z_]+_mediapipe\/resolve\/[0-9a-f]{40}\/[a-z_]+_2023feb\.onnx$/);
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('installs both into userData/models/hand-landmarks; removal empties it', async () => {
    const p = pins(sha256Hex(PALM), sha256Hex(HAND));
    stubFetch({ [p[0]!.url]: PALM, [p[1]!.url]: HAND });
    const dir = handModelUserDir(root);
    expect(dir).toBe(path.join(root, 'models', 'hand-landmarks'));
    const progress: number[] = [];
    const res = await installHandModel(dir, new AbortController().signal, (r) => progress.push(r), p);
    expect(res.ok).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([HAND_MODEL_FILE, PALM_MODEL_FILE, 'model.json'].sort());
    expect(await readHandModelInstall(dir)).toMatchObject({ bytes: PALM.byteLength + HAND.byteLength, urls: [p[0]!.url, p[1]!.url] });
    // Progress runs over both files: it ends at their sum.
    expect(progress.at(-1)).toBe(PALM.byteLength + HAND.byteLength);
    await removeHandModel(dir);
    expect(await readHandModelInstall(dir)).toBeNull();
  });

  it('installs nothing when the SECOND file fails its checksum', async () => {
    const p = pins(sha256Hex(PALM), '0'.repeat(64));
    stubFetch({ [p[0]!.url]: PALM, [p[1]!.url]: HAND });
    const dir = handModelUserDir(root);
    const res = await installHandModel(dir, new AbortController().signal, () => undefined, p);
    expect(res).toMatchObject({ ok: false });
    expect(await readHandModelInstall(dir)).toBeNull();
    await expect(readdir(dir)).rejects.toThrow();  // never created
  });

  it('a folder with one file and no metadata is not an install', async () => {
    const p = pins(sha256Hex(PALM), sha256Hex(HAND));
    stubFetch({ [p[0]!.url]: PALM, [p[1]!.url]: HAND });
    const dir = handModelUserDir(root);
    await installHandModel(dir, new AbortController().signal, () => undefined, p);
    await rm(path.join(dir, HAND_MODEL_FILE));
    expect(await readHandModelInstall(dir)).toBeNull();
  });
});
