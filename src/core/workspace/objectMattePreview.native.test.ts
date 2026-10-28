/**
 * The Object Matte tool's hover preview through the real engine and the
 * bundled SAM pair (public/models/object-matte, `npm run fetch:models`): the
 * job runs with apply: false, its summary carries the outline, nothing is
 * written until the held result is applied. Skips when the model is not staged.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { previewObjectMatte, ROTO_PATH_NAME } from './rotoBrushTool';

const MODEL_DIR = path.resolve(__dirname, '../../../public/models/object-matte');
const staged = existsSync(path.join(MODEL_DIR, 'vision_encoder_quantized.onnx'));
const maybe = staged ? it : it.skip;

let h: Harness;
let dir: string;

beforeAll(() => {
  process.env.PREMATION_SAM_DIR = MODEL_DIR;
  dir = mkdtempSync(path.join(tmpdir(), 'om-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

/** A 320×240 grey field with a red disc of radius 60 at (160, 120). */
function disc(): string {
  const png = new PNG({ width: 320, height: 240 });
  for (let y = 0; y < 240; y++) {
    for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      const inside = Math.hypot(x - 160, y - 120) < 60;
      png.data[i] = inside ? 220 : 90;
      png.data[i + 1] = inside ? 40 : 90;
      png.data[i + 2] = inside ? 40 : 90;
      png.data[i + 3] = 255;
    }
  }
  const file = path.join(dir, 'disc.png');
  writeFileSync(file, PNG.sync.write(png));
  return file;
}

maybe('previews the outline without writing, then applies it as one entry', async () => {
  const { items: [item] } = await h.run({ type: 'importFiles', files: [{ path: disc(), asSequence: false, createComposition: false }] });
  const { item: comp } = await h.run({ type: 'createComposition', settings: { name: 'C', width: 320, height: 240 }, fromItems: [] });
  const { layer } = await h.run({ type: 'createLayer', comp, kind: 'video', source: item!, name: 'disc', init: [] });
  await engineIdle();
  const entries = (await historyLabels()).length;
  const preview = await previewObjectMatte(layer, [{ id: 'p', kind: 'fg', points: [{ x: 0, y: 0 }], time: 0 }], 0);
  expect(preview).not.toBeNull();
  const xs = preview!.outline.filter((_, i) => i % 2 === 0);
  const ys = preview!.outline.filter((_, i) => i % 2 === 1);
  // The disc (radius 60 of 320 × 240) about the layer centre, in the layer's display px.
  const size = (await h.query({ type: 'getSourceSize', layers: [layer] })).sizes[0]!;
  const rx = (60 / 320) * size.width;
  const ry = (60 / 240) * size.height;
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1.8 * rx);
  expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(2.2 * rx);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1.8 * ry);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2.2 * ry);
  expect(Math.abs(Math.max(...xs) + Math.min(...xs))).toBeLessThan(0.1 * rx);
  expect((await historyLabels()).length).toBe(entries);

  const mask = await preview!.apply();
  await engineIdle();
  expect(mask).not.toBeNull();
  await documentMirror().loadTrees([layer]);
  expect(mirrorMaskHeaders(documentMirror().tree(layer)).map((m) => m.name)).toContain(ROTO_PATH_NAME);
  expect((await historyLabels()).length).toBe(entries + 1);
}, 60000);
