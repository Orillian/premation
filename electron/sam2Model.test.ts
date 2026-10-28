/**
 * Object Matte's SAM 2.1 video model on disk (sam2Model.ts): six PINNED
 * downloads from one Hugging Face revision; a checksum mismatch on any file
 * installs nothing, a good set installs all with the metadata last, and the
 * JSON constants file must carry the memory table.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Hex } from './depthModel';
import { type PinnedFile } from './handModel';
import { SAM2_MODEL_PINS, installSam2Model, readSam2ModelInstall, removeSam2Model, sam2ModelUserDir } from './sam2Model';

const ONNX = new Uint8Array([0x08, 0x07, ...new Array(30).fill(2)]);
const CONSTANTS = new TextEncoder().encode(JSON.stringify({ memory_temporal_positional_encoding: [[0]] }));

const realFetch = globalThis.fetch;
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

const pins = (badSecond = false): PinnedFile[] => [
  { file: 'constants.json', url: 'https://models.example/constants.json', sha256: sha256Hex(CONSTANTS), bytes: CONSTANTS.byteLength },
  { file: 'vision_encoder.onnx', url: 'https://models.example/vision.onnx', sha256: badSecond ? '0'.repeat(64) : sha256Hex(ONNX), bytes: ONNX.byteLength },
];

let root = '';
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 's2-')); });
afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true });
});

describe('sam2Model', () => {
  it('pins every file the engine reads to one exact revision and a SHA-256', () => {
    expect(SAM2_MODEL_PINS.map((p) => p.file).sort()).toEqual(
      ['constants.json', 'mask_decoder.onnx', 'memory_attention.onnx', 'memory_encoder.onnx', 'pointer_tpos.onnx', 'vision_encoder.onnx'],
    );
    for (const p of SAM2_MODEL_PINS) {
      expect(p.url).toMatch(/^https:\/\/huggingface\.co\/square-zero-labs\/sam2\.1-tiny-video-onnx\/resolve\/3b2984dd865f6e9d2cc6aed0be6a5a5c2eb352ce\//);
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('installs all into userData/models/sam2-video; removal empties it', async () => {
    const p = pins();
    stubFetch({ [p[0]!.url]: CONSTANTS, [p[1]!.url]: ONNX });
    const dir = sam2ModelUserDir(root);
    expect(dir).toBe(path.join(root, 'models', 'sam2-video'));
    const res = await installSam2Model(dir, new AbortController().signal, () => undefined, p);
    expect(res.ok).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['constants.json', 'model.json', 'vision_encoder.onnx']);
    expect(await readSam2ModelInstall(dir, p)).toMatchObject({ bytes: CONSTANTS.byteLength + ONNX.byteLength });
    await removeSam2Model(dir, p);
    expect(await readSam2ModelInstall(dir, p)).toBeNull();
  });

  it('installs nothing when a later file fails its checksum', async () => {
    const p = pins(true);
    stubFetch({ [p[0]!.url]: CONSTANTS, [p[1]!.url]: ONNX });
    const dir = sam2ModelUserDir(root);
    expect(await installSam2Model(dir, new AbortController().signal, () => undefined, p)).toMatchObject({ ok: false });
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('refuses a constants file without the memory table', async () => {
    const bad = new TextEncoder().encode('{"hello":1}');
    const p: PinnedFile[] = [{ file: 'constants.json', url: 'https://models.example/c.json', sha256: sha256Hex(bad), bytes: bad.byteLength }];
    stubFetch({ [p[0]!.url]: bad });
    expect(await installSam2Model(sam2ModelUserDir(root), new AbortController().signal, () => undefined, p)).toMatchObject({ ok: false });
  });
});
