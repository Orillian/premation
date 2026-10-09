/**
 * An enormous layer never blanks the frame (CLAUDE.md reliability), on the
 * app's engine with the full renderer. Found 2026-10-08 through the AI tools:
 * "PREMATION" at 180 px with scale keyed 80 → 100 (the tool's multiplier:
 * 8000 % → 10000 %) and a glow rasterised 16384 px wide; the render device
 * had the WebGPU default 8192 limit, and getThumbnail came back fully
 * transparent — the backdrop and the comp background with it.
 *
 * Needs a GPU adapter, so it runs only with PREMATION_GPU_TESTS=1 (CI runs the
 * engine with `--no-gpu`). The engine-side regressions run everywhere:
 * native/engine/tests/test_oversize_texture.cpp and test_render_graph_gpu.cpp.
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;

suite('an enormous layer on the full renderer', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(10) } } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  /** The frame at `t` as the mean RGBA of its pixels. */
  async function meanAt(t: number): Promise<number[]> {
    const th = await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: 320 });
    expect(th.format).toBe('png');
    const png = PNG.sync.read(Buffer.from(th.data));
    const sum = [0, 0, 0, 0];
    for (let i = 0; i < png.data.length; i += 4) for (let c = 0; c < 4; c++) sum[c] = sum[c]! + png.data[i + c]!;
    const n = png.data.length / 4;
    return sum.map((s) => s / n);
  }

  it('a 10000 % text layer with a glow keeps the backdrop and the comp background', async () => {
    const r = await runToolTurn('AI: oversize repro', [
      { name: 'create_layer', args: { id: 'bg', kind: 'shape', shape: 'rect', name: 'Backdrop', width: 1920, height: 1080, fill: '#101828' } },
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'Title', text: 'PREMATION' } },
      { name: 'update_layer', args: { nodeId: 't', fontSize: 180, fill: '#ffffff' } },
      { name: 'set_keyframes', args: { keyframes: [
        { nodeId: 't', prop: 'scale', t: 0, value: 80 }, { nodeId: 't', prop: 'scale', t: 1.2, value: 100 },
        { nodeId: 't', prop: 'opacity', t: 0, value: 0 }, { nodeId: 't', prop: 'opacity', t: 1, value: 100 },
      ] } },
      { name: 'add_effect', args: { nodeId: 't', type: 'glow' } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    for (const t of [0, 0.6, 1.5]) {
      const [, , , a] = await meanAt(t);
      // Opaque: the backdrop covers the frame whatever the text does.
      expect({ t, alpha: a }).toEqual({ t, alpha: 255 });
    }
  }, 120_000);
});
