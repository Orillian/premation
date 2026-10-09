/**
 * The AI tools the 2026-10 program added or repaired (docs/PROGRAM_PLAYBACK_TEXT_INK.md,
 * phase M / T5 / I1), on the app's engine.
 */

import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { setupAppEngine, settleEdits, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { runToolTurn } from './aiTurn';
import { fontFamiliesOf } from './toolHandlers';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeAll(async () => {
  h = await setupAppEngine({ gpu: process.env.PREMATION_GPU_TESTS === '1' });
  await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { duration: sec(5) } } as Command);
  await settleEdits();
}, 60_000);
afterAll(async () => { await h.dispose(); });

const idNamed = (name: string): string => {
  const m = documentMirror();
  return m.layerIds().find((c) => m.layer(c)?.name === name) ?? '';
};

async function value(layer: string, path: string): Promise<unknown> {
  const r = (await h.query({ type: 'getPropertyValues', props: [{ layer, path }], time: 0, evaluated: false } as never)) as {
    values: { value: { value: unknown } }[];
  };
  return r.values[0]?.value.value;
}

describe('stroke-only shapes (I1)', () => {
  it('fill "none" / CSS colours are accepted, and the stroke stays', async () => {
    const r = await runToolTurn('AI: ring', [
      { name: 'create_layer', args: { id: 'ring', kind: 'shape', shape: 'ellipse', name: 'Ring', width: 300, height: 300, fill: 'none' } },
      { name: 'update_layer', args: { nodeId: 'ring', stroke: '#c0201a', strokeWidth: 14 } },
      { name: 'create_layer', args: { id: 'veil', kind: 'shape', name: 'Veil', fill: 'rgba(255, 0, 0, 0.5)' } },
      { name: 'update_layer', args: { nodeId: 'veil', fill: 'transparent' } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    expect(await value(idNamed('Ring'), 'layer/fill')).toMatchObject({ a: 0 });
    expect(await value(idNamed('Veil'), 'layer/fill')).toMatchObject({ a: 0 });
    const strokes = await value(idNamed('Ring'), 'layer/strokes');
    expect(JSON.stringify(strokes)).toContain('c0201a');
  });

  (process.env.PREMATION_GPU_TESTS === '1' ? it : it.skip)('renders the ring and not the interior (GPU)', async () => {
    const comp = activeCompRootId() as string;
    const r = await runToolTurn('AI: ring render', [
      { name: 'create_layer', args: { id: 'bg', kind: 'shape', name: 'RingBG', x: 960, y: 540, width: 1920, height: 1080, fill: '#ffffff' } },
      { name: 'create_layer', args: { id: 'r2', kind: 'shape', shape: 'ellipse', name: 'Ring2', x: 960, y: 540, width: 400, height: 400, fill: 'none' } },
      { name: 'update_layer', args: { nodeId: 'r2', stroke: '#ff0000', strokeWidth: 20 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: comp, time: 0, maxSize: 1920 } as never)) as { data: Uint8Array };
    const { PNG } = await import('pngjs');
    const png = PNG.sync.read(Buffer.from(th.data));
    const px = (x: number, y: number): number[] => {
      const sx = Math.round(x * png.width / 1920);
      const sy = Math.round(y * png.height / 1080);
      const i = (sy * png.width + sx) * 4;
      return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
    };
    expect(px(960, 540)).toEqual([255, 255, 255]);   // the interior shows the white backdrop
    const ring = px(960 + 200, 540);                  // on the stroke (centred on the path)
    expect(ring[0]).toBeGreaterThan(200);
    expect(ring[1]).toBeLessThan(60);
  }, 120_000);
});

describe('reorder_layer (M1)', () => {
  it('moves layers to the bottom, top, above and below another', async () => {
    const r = await runToolTurn('AI: stack', [
      { name: 'create_layer', args: { id: 'a', kind: 'null', name: 'StackA' } },
      { name: 'create_layer', args: { id: 'b', kind: 'null', name: 'StackB' } },
      { name: 'create_layer', args: { id: 'c', kind: 'null', name: 'StackC' } },
    ]);
    expect(r.results.every((x) => x.ok)).toBe(true);
    await settleEdits();
    const [A, B, C] = ['StackA', 'StackB', 'StackC'].map(idNamed) as [string, string, string];
    const order = (): string[] => {
      const m = documentMirror();
      const comp = m.layer(A)!.comp;
      return [...m.comp(comp)!.layers].filter((id) => [A, B, C].includes(id));
    };
    expect(order()).toEqual([C, B, A]);  // newest on top
    const run = async (args: Record<string, unknown>): Promise<void> => {
      const t = await runToolTurn('AI: reorder', [{ name: 'reorder_layer', args }]);
      expect(t.results.map((x) => (x.ok ? 'ok' : x.content))).toEqual(['ok']);
      await settleEdits();
    };
    await run({ nodeIds: [C], position: 'bottom' });
    expect(order()).toEqual([B, A, C]);
    await run({ nodeIds: [C], position: 'top' });
    expect(order()).toEqual([C, B, A]);
    await run({ nodeIds: [C], position: 'below', relativeTo: A });
    expect(order()).toEqual([B, A, C]);
    await run({ nodeIds: [C], position: 'above', relativeTo: B });
    expect(order()).toEqual([C, B, A]);
    await run({ nodeIds: [A], position: 'above', relativeTo: C });
    expect(order()).toEqual([A, C, B]);
    const bad = await runToolTurn('AI: reorder bad', [{ name: 'reorder_layer', args: { nodeIds: [A], position: 'above' } }]);
    expect(bad.results[0]!.ok).toBe(false);
  });
});

describe('masks (M2)', () => {
  it('creates an offset mask, restyles it, animates its path, deletes it', async () => {
    const r = await runToolTurn('AI: mask', [
      { name: 'create_layer', args: { id: 'm', kind: 'shape', name: 'Masked', width: 400, height: 400, fill: '#ffffff' } },
      { name: 'create_mask', args: { nodeId: 'm', shape: 'ellipse', width: 100, height: 100, x: 50, y: -20 } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const maskId = (r.results[1]!.data as { maskId: string }).maskId;
    await settleEdits();
    const layer = idNamed('Masked');
    const path = (await value(layer, `masks/${maskId}/path`)) as { vertices: number[] };
    const xs = path.vertices.filter((_, i) => i % 2 === 0);
    const ys = path.vertices.filter((_, i) => i % 2 === 1);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(50, 3);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(-20, 3);

    const u = await runToolTurn('AI: mask edit', [
      { name: 'update_mask', args: { nodeId: layer, maskId, feather: 12, inverted: true, mode: 'subtract' } },
      { name: 'update_mask', args: { nodeId: layer, maskId, shape: 'rectangle', keys: [{ t: 0, width: 10, height: 10 }, { t: 2, width: 300, height: 300, x: 20 }] } },
    ]);
    expect(u.results.map((x) => (x.ok ? 'ok' : x.content))).toEqual(['ok', 'ok']);
    await settleEdits();
    expect(await value(layer, `masks/${maskId}/feather`)).toBe(12);
    expect(await value(layer, `masks/${maskId}/inverted`)).toBe(true);
    expect(await value(layer, `masks/${maskId}/mode`)).toBe('subtract');
    const keys = (await h.query({ type: 'getKeyframes', props: [{ layer, path: `masks/${maskId}/path` }] } as never)) as { sets: { keyframes: unknown[] }[] };
    expect(keys.sets[0]!.keyframes).toHaveLength(2);

    const d = await runToolTurn('AI: mask rm', [{ name: 'update_mask', args: { nodeId: layer, maskId, remove: true } }]);
    expect(d.results[0]!.ok).toBe(true);
    const gone = await runToolTurn('AI: mask rm2', [{ name: 'update_mask', args: { nodeId: layer, maskId, feather: 1 } }]);
    expect(gone.results[0]!.ok).toBe(false);
  });
});

describe('text layout fields (T5)', () => {
  it('sets vertical orientation, a paragraph box and its alignment', async () => {
    const r = await runToolTurn('AI: tategaki', [
      { name: 'create_layer', args: { id: 'v', kind: 'text', name: 'Tate', text: '最後の一太刀' } },
      { name: 'update_layer', args: { nodeId: 'v', orientation: 'vertical' } },
      { name: 'create_layer', args: { id: 'p', kind: 'text', name: 'Para', text: 'Left aligned paragraph' } },
      { name: 'update_layer', args: { nodeId: 'p', boxWidth: 800, align: 'left' } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    expect(await value(idNamed('Tate'), 'text/orientation')).toBe('vertical');
    expect(await value(idNamed('Para'), 'text/boxWidth')).toBe(800);
    expect(await value(idNamed('Para'), 'text/align')).toBe('left');
  });

  (process.env.PREMATION_GPU_TESTS === '1' ? it : it.skip)('a left-aligned paragraph starts at the box edge; list_fonts sees installed fonts (GPU)', async () => {
    const comp = activeCompRootId() as string;
    const r = await runToolTurn('AI: para render', [
      { name: 'create_layer', args: { id: 'bg', kind: 'shape', name: 'ParaBG', x: 960, y: 540, width: 1920, height: 1080, fill: '#ffffff' } },
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'ParaR', text: 'Left', x: 960, y: 540 } },
      { name: 'update_layer', args: { nodeId: 't', fontSize: 80, fill: '#000000', boxWidth: 1000, align: 'left' } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: comp, time: 0, maxSize: 1920 } as never)) as { data: Uint8Array };
    const { PNG } = await import('pngjs');
    const png = PNG.sync.read(Buffer.from(th.data));
    let minX = png.width;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) if (png.data[(y * png.width + x) * 4]! < 128) { minX = Math.min(minX, x); break; }
    }
    // The box spans 460..1460 in comp px: the ink starts near its left edge, not centred around 960.
    expect(Math.abs(minX * 1920 / png.width - 460)).toBeLessThan(40);
  }, 120_000);

  it('list_fonts groups faces by family and filters by script alias', () => {
    const rows = fontFamiliesOf([
      { family: 'Yu Gothic', style: 'Regular', scripts: ['Latn', 'Hira', 'Kana', 'Hani'] },
      { family: 'Yu Gothic', style: 'Bold', scripts: ['Latn', 'Hira', 'Kana', 'Hani'] },
      { family: 'Malgun Gothic', style: 'Regular', scripts: ['Latn', 'Hang'] },
      { family: 'Arial', style: 'Regular', scripts: ['Latn', 'Cyrl', 'Grek'] },
    ], 'ja');
    expect(rows.map(([f]) => f)).toEqual(['Yu Gothic']);
    expect([...rows[0]![1].styles]).toEqual(['Regular', 'Bold']);
    expect(fontFamiliesOf([{ family: 'Malgun Gothic', style: 'R', scripts: ['Hang'] }], 'Hang').map(([f]) => f)).toEqual(['Malgun Gothic']);
    expect(fontFamiliesOf([{ family: 'Arial', style: 'R', scripts: ['Latn'] }], 'ko')).toEqual([]);
  });
});

describe('get_export_status (M4)', () => {
  it('reports a job, its progress and its output file, and a missing output folder', async () => {
    const { useRenderQueueStore } = await import('@stores/renderQueueStore');
    const q = useRenderQueueStore.getState();
    const jobId = q.addJob({
      compositionName: 'Samurai', compositionId: activeCompRootId() as string, background: '#000000',
      outputPath: 'Samurai_take1.mp4', format: 'mp4', width: 1920, height: 1080, compWidth: 1920, compHeight: 1080,
      fps: 30, durationSec: 2, transparent: false, quality: 'high',
    } as never);
    useRenderQueueStore.setState({ outputDir: null });
    const a = await runToolTurn('AI: status', [{ name: 'get_export_status', args: { jobId } }]);
    expect(String(a.results[0]!.content)).toContain('waiting for an output folder');
    useRenderQueueStore.setState((s) => ({
      outputDir: 'C:\\Renders',
      jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, status: 'rendering' as const, progress: 0.42 } : j)),
    }));
    const b = await runToolTurn('AI: status 2', [{ name: 'get_export_status', args: { jobId } }]);
    expect(String(b.results[0]!.content)).toContain('rendering 42%');
    expect(String(b.results[0]!.content)).toContain('C:\\Renders\\Samurai_take1.mp4');
    const missing = await runToolTurn('AI: status 3', [{ name: 'get_export_status', args: { jobId: 'nope' } }]);
    expect(missing.results[0]!.ok).toBe(false);
  });
});

describe('inspect_layers (M5)', () => {
  it('reports built bounds, fill and an off-screen layer', async () => {
    const r = await runToolTurn('AI: inspect', [
      { name: 'create_layer', args: { id: 'q', kind: 'shape', name: 'Quarter', x: 480, y: 270, width: 960, height: 540, fill: '#123456' } },
      { name: 'create_layer', args: { id: 'o', kind: 'shape', name: 'Gone', x: -800, y: 540, width: 200, height: 200, fill: '#ff0000' } },
    ]);
    expect(r.results.every((x) => x.ok)).toBe(true);
    await settleEdits();
    const q = idNamed('Quarter');
    const o = idNamed('Gone');
    const t = await runToolTurn('AI: inspect run', [{ name: 'inspect_layers', args: { nodeIds: [q, o], t: 0 } }]);
    expect(t.results[0]!.ok).toBe(true);
    const text = String(t.results[0]!.content);
    expect(text).toContain('x 0..960, y 0..540');
    expect(text).toContain('#123456');
    expect(text).toMatch(/Gone.*OFF-SCREEN/);
  });
});

describe('add_effect params (M3)', () => {
  it('applies initial values and reports unknown keys', async () => {
    const r = await runToolTurn('AI: fx params', [
      { name: 'create_layer', args: { id: 'b', kind: 'shape', name: 'FxBox' } },
      { name: 'add_effect', args: { nodeId: 'b', type: 'gaussian-blur', id: 'soft', params: { blurriness: 42, nonsense: 3 } } },
    ]);
    expect(r.results[1]!.ok).toBe(true);
    expect(String(r.results[1]!.content)).toContain('blurriness=42');
    expect(String(r.results[1]!.content)).toContain('NOT set');
    expect(String(r.results[1]!.content)).toContain('nonsense');
    await settleEdits();
    expect(await value(idNamed('FxBox'), 'effects/soft/blurriness')).toBe(42);
  });
});
