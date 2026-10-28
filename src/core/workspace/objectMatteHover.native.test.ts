/**
 * How fast the Object Matte tool's hover preview answers, through the real UI
 * path (previewObjectMatte → the engine's objectMatte job → its model
 * process): the first hover (the worker starts and loads the model), a new
 * point on the same frame (warm: the frame's encoder output is held), and a
 * new frame with the worker up (cold frame). It also checks latest-wins:
 * a burst of hovers on one layer answers the newest, and the outlines agree.
 * Prints the numbers; skips when the SlimSAM pair is not staged.
 * PREMATION_SAM_GPU_DIR (a folder with a float vision_encoder.onnx) makes the
 * encoder try a GPU provider; nothing ships one (see kind_object_matte.cpp).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { secondsToFlicks } from '@motion/engine-api';
import { engineIdle } from '@core/engine/engineInstance';
import { startEngineJob } from '@core/engine/engineJobs';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { previewObjectMatte } from './rotoBrushTool';

const MODEL_DIR = process.env.PREMATION_SAM_DIR ?? path.resolve(__dirname, '../../../public/models/object-matte');
const GPU_DIR = process.env.PREMATION_SAM_GPU_DIR ?? '';
const staged = existsSync(path.join(MODEL_DIR, 'vision_encoder_quantized.onnx'));
const maybe = staged ? it : it.skip;

let h: Harness;
let dir: string;

beforeAll(() => {
  process.env.PREMATION_SAM_DIR = MODEL_DIR;
  if (!GPU_DIR || !existsSync(path.join(GPU_DIR, 'vision_encoder.onnx'))) delete process.env.PREMATION_SAM_GPU_DIR;
  dir = mkdtempSync(path.join(tmpdir(), 'omh-'));
  // A cache of our own, so "cold" is cold: no encoder output from an earlier run on disk.
  process.env.PREMATION_SAM_CACHE_DIR = path.join(dir, 'cache');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => { h = await setupAppEngine(); sizes.clear(); });
afterEach(async () => { await h.dispose(); });

const W = 1920;
const H = 1080;

/** A 1080p textured field with discs (centre, radius, colour). */
function frame(name: string, discs: Array<[number, number, number, [number, number, number]]>): string {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const ripple = 10 * Math.sin(x * 0.05) * Math.cos(y * 0.07);
      let c: [number, number, number] = [70 + (60 * x) / W + ripple, 90 + (50 * y) / H + ripple, 80 + ripple];
      for (const [cx, cy, r, col] of discs) if (Math.hypot(x - cx, y - cy) < r) c = col;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  const file = path.join(dir, name);
  writeFileSync(file, PNG.sync.write(png));
  return file;
}

async function layerOf(file: string): Promise<string> {
  const { items: [item] } = await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] });
  const { item: comp } = await h.run({ type: 'createComposition', settings: { name: path.basename(file), width: W, height: H }, fromItems: [] });
  const { layer } = await h.run({ type: 'createLayer', comp, kind: 'video', source: item!, name: path.basename(file), init: [] });
  await engineIdle();
  return layer;
}

/** The layer's display size (the tool's px; the engine maps them onto the decoded frame). */
const sizes = new Map<string, { width: number; height: number }>();

/**
 * A hover at frame px (x, y): the tool's stroke is in layer-centred display px. The outline
 * comes back in those px too; it is returned in frame px (times W / display width).
 */
async function hover(layer: string, x: number, y: number): Promise<{ ms: number; outline: number[] | null }> {
  let size = sizes.get(layer);
  if (!size) {
    size = (await h.query({ type: 'getSourceSize', layers: [layer] })).sizes[0]!;
    sizes.set(layer, size);
  }
  const k = size.width / W;
  const t0 = performance.now();
  const p = await previewObjectMatte(layer, [{ id: 'p', kind: 'fg', points: [{ x: (x - W / 2) * k, y: (y - H / 2) * k }], time: 0 }], 0);
  const ms = performance.now() - t0;
  p?.discard();
  return { ms, outline: p ? p.outline.map((v) => v / k) : null };
}

function width(outline: number[]): number {
  const xs = outline.filter((_, i) => i % 2 === 0);
  return Math.max(...xs) - Math.min(...xs);
}

maybe('hover-to-outline: first, warm (same frame) and cold (new frame)', async () => {
  // Each layer is hovered while its composition is the newest (the tool works on the active one).
  const a = await layerOf(frame('a.png', [[600, 540, 180, [220, 40, 40]], [1400, 500, 140, [40, 60, 210]]]));
  const first = await hover(a, 600, 540);
  const warm1 = await hover(a, 1400, 500);
  const warm2 = await hover(a, 610, 530);
  const b = await layerOf(frame('b.png', [[900, 400, 200, [40, 200, 60]]]));
  const cold = await hover(b, 900, 400);
  const warm3 = await hover(b, 880, 420);
  console.log(
    `[object matte hover] first ${first.ms.toFixed(0)} ms, warm ${warm1.ms.toFixed(0)} / ${warm2.ms.toFixed(0)} ms, ` +
      `cold frame ${cold.ms.toFixed(0)} ms, warm ${warm3.ms.toFixed(0)} ms (1920x1080, GPU encoder ${process.env.PREMATION_SAM_GPU_DIR ? 'set' : 'none'})`,
  );
  // Where a warm call's time goes inside the model process (the job summary's timings).
  const size = sizes.get(b)!;
  const k = size.width / W;
  const job = await startEngineJob<{ timings?: Record<string, number> }>(
    {
      kind: 'objectMatte',
      value: {
        strokes: [],
        layer: b,
        range: { start: 0, duration: secondsToFlicks(1 / 30) },
        prompts: [{ x: (900 - W / 2) * k, y: (400 - H / 2) * k }],
        backgroundPrompts: [],
        encoderModel: '',
        decoderModel: '',
        replaceMasks: [],
      },
    },
    { apply: false },
  );
  const t = (await job!.done).result?.timings;
  job!.cancel();
  console.log(`[object matte hover] warm call in the model process: ${JSON.stringify(t)}`);
  for (const r of [first, warm1, warm2, cold, warm3]) expect(r.outline).not.toBeNull();
  // The right subjects: the red disc (r 180), the blue one (r 140), the green one (r 200).
  expect(width(first.outline!)).toBeGreaterThan(1.8 * 180);
  expect(width(first.outline!)).toBeLessThan(2.2 * 180);
  expect(width(warm1.outline!)).toBeGreaterThan(1.8 * 140);
  expect(width(warm1.outline!)).toBeLessThan(2.2 * 140);
  expect(width(cold.outline!)).toBeGreaterThan(1.8 * 200);
  expect(width(cold.outline!)).toBeLessThan(2.2 * 200);
  // Warm is the decoder alone in a process that is already up.
  expect(warm1.ms).toBeLessThan(first.ms);
  expect(warm3.ms).toBeLessThan(cold.ms);
}, 180000);

maybe('a burst of hovers on one layer: the newest answers, the stale ones drop', async () => {
  const a = await layerOf(frame('c.png', [[600, 540, 180, [220, 40, 40]], [1400, 500, 140, [40, 60, 210]]]));
  await hover(a, 600, 540); // the worker up and the frame warm
  const burst = await Promise.all([
    hover(a, 600, 540),
    hover(a, 610, 545),
    hover(a, 620, 550),
    hover(a, 1400, 500),
  ]);
  const last = burst[burst.length - 1]!;
  expect(last.outline).not.toBeNull();
  expect(width(last.outline!)).toBeGreaterThan(1.8 * 140);
  expect(width(last.outline!)).toBeLessThan(2.2 * 140);
  // At least one of the middle ones was superseded before it reached the model.
  expect(burst.slice(1, -1).some((r) => r.outline === null)).toBe(true);
}, 120000);
