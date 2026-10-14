/**
 * Make 3D from Photo's depth model on disk (depthModel.ts, camera program D3):
 * a PINNED download — the URL (an exact revision) and SHA-256 are constants, a
 * checksum mismatch installs nothing, removal empties the folder.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEPTH_MODEL_FILE, DEPTH_MODEL_SHA256, DEPTH_MODEL_URL, depthModelUserDir, installDepthModel, readDepthModelInstall,
  removeDepthModel, sha256Hex,
} from './depthModel';

const ONNX = new Uint8Array([0x08, 0x07, ...new Array(30).fill(2)]);
const URL_ = 'https://models.example/depth_anything_v2_small.onnx';

const realFetch = globalThis.fetch;
function stubFetch(bytes: Uint8Array): void {
  globalThis.fetch = (async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => String(bytes.byteLength) },
    body: (async function* () { yield bytes; })(),
  })) as unknown as typeof fetch;
}

let root = '';
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'dm-')); });
afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true });
});

describe('depthModel', () => {
  it('pins one https URL at an exact revision and its SHA-256; other bytes from it are refused', async () => {
    expect(DEPTH_MODEL_URL).toMatch(/^https:\/\/huggingface\.co\/onnx-community\/depth-anything-v2-small\/resolve\/[0-9a-f]{40}\/onnx\/model\.onnx$/);
    expect(DEPTH_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    stubFetch(ONNX);
    const dir = depthModelUserDir(root);
    const res = await installDepthModel(dir, new AbortController().signal, () => undefined);
    expect(res).toMatchObject({ ok: false });
    expect(await readDepthModelInstall(dir)).toBeNull();
  });

  it('installs a download matching its pin into userData/models/depth-anything; removal empties it', async () => {
    stubFetch(ONNX);
    const dir = depthModelUserDir(root);
    expect(dir).toBe(path.join(root, 'models', 'depth-anything'));
    const res = await installDepthModel(dir, new AbortController().signal, () => undefined, { url: URL_, sha256: sha256Hex(ONNX) });
    expect(res.ok).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([DEPTH_MODEL_FILE, 'model.json'].sort());
    expect(await readDepthModelInstall(dir)).toMatchObject({ url: URL_, bytes: ONNX.byteLength, sha256: sha256Hex(ONNX) });
    await removeDepthModel(dir);
    expect(await readDepthModelInstall(dir)).toBeNull();
  });

  it('refuses a download whose checksum is not the pinned one, writing nothing', async () => {
    stubFetch(ONNX);
    const dir = depthModelUserDir(root);
    const res = await installDepthModel(dir, new AbortController().signal, () => undefined, { url: URL_, sha256: '0'.repeat(64) });
    expect(res.ok).toBe(false);
    expect(await readDepthModelInstall(dir)).toBeNull();
  });
});
