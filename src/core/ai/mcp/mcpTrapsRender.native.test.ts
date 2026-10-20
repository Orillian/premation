/**
 * The MCP film traps that only pixels show (2026-10-12 … 10-20), on the full
 * renderer (PREMATION_GPU_TESTS=1): what the model wrote must be what draws.
 * The document-level half is mcpTraps.native.test.ts.
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { McpCallHost, type McpResult } from './mcpHost';
import { editorMcpDeps } from './mcpDefaults';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(60_000);

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 480;
const H = 270;
const BG = '#202020';

suite('MCP film traps on the full renderer', () => {
  let h: Harness;
  let host: McpCallHost;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(4), background: { r: 0x20 / 255, g: 0x20 / 255, b: 0x20 / 255, a: 1 } } } as Command);
    await h.run({ type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });
  beforeEach(async () => {
    host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }) });
    const m = documentMirror();
    const ids = m.layerIds().filter((id) => m.layer(id)?.comp === activeCompRootId());
    if (ids.length) await call('delete_layer', { nodeIds: ids });
    await settleEdits();
  });
  afterEach(async () => { await host.stop(); });

  const call = (name: string, args: unknown = {}): Promise<McpResult> => host.handle({ clientId: 1, name, args });
  const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
  async function run(steps: ReadonlyArray<readonly [string, Record<string, unknown>]>): Promise<void> {
    for (const [name, args] of steps) {
      const r = await call(name, args);
      expect([name, r.isError ? textOf(r).slice(0, 300) : '']).toEqual([name, '']);
    }
  }
  async function frame(t = 1): Promise<PNG> {
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const px = (p: PNG, x: number, y: number): [number, number, number] => {
    const i = (Math.round(y * p.height / H) * p.width + Math.round(x * p.width / W)) * 4;
    return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
  };
  /** Pixels in a box that differ from the background by more than `tol` per channel. */
  const inked = (p: PNG, x0: number, y0: number, x1: number, y1: number, tol = 24): number => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const [r, g, b] = px(p, x, y);
      if (Math.abs(r - 0x20) > tol || Math.abs(g - 0x20) > tol || Math.abs(b - 0x20) > tol) n++;
    }
    return n;
  };

  it('a shape line with a stroke and a trim draws (samurai title)', async () => {
    await run([
      ['create_layer', { id: 'u', kind: 'shape', shape: 'line', name: 'Underline', x: 240, y: 135, width: 300, height: 0, fill: 'none', stroke: '#ffffff', strokeWidth: 8 }],
      ['set_trim_path', { nodeId: 'u', id: 'tr', start: 0, end: 100 }],
    ]);
    expect(inked(await frame(), 100, 125, 380, 145)).toBeGreaterThan(300);
  });

  it('paint strokes on a shape with no fill show (samurai title)', async () => {
    await run([
      ['create_layer', { id: 's', kind: 'shape', shape: 'rect', name: 'Ink', x: 240, y: 135, width: 400, height: 200, fill: 'none' }],
      ['paint_strokes', { nodeId: 's', strokes: [{ points: [[40, 100, 1], [360, 100, 1]], color: '#ffffff', size: 16, hardness: 100, opacity: 100 }] }],
    ]);
    expect(inked(await frame(), 60, 120, 420, 150)).toBeGreaterThan(300);
  });

  // OPEN (engine): the draw-only Canvas2D effects (Numbers, Timecode — even
  // their box) draw nothing on the GPU renderer and record no layer error
  // (native/engine/src/scene/effects_port.cpp gpu_overlay_effect →
  // effects/canvas_effects_generate.cpp apply_numbers). The CPU bake path is
  // what is_canvas2d_only routes them to; the overlay never lands.
  it.failing('the Numbers effect draws its number (Operand)', async () => {
    await run([
      ['create_layer', { id: 'n', kind: 'solid', name: 'Counter', x: 240, y: 135, width: 400, height: 200, fill: BG }],
      ['add_effect', { nodeId: 'n', type: 'numbers', id: 'num', params: { value: 8888, size: 96, color: '#ffffff' } }],
    ]);
    expect(inked(await frame(), 40, 35, 440, 235)).toBeGreaterThan(200);
  });

  it('Linear Wipe removes completion% of the layer, linearly, so its edge can follow a moving layer (In Motion)', async () => {
    await run([
      ['create_layer', { id: 'w', kind: 'solid', name: 'Panel', x: 240, y: 135, width: 480, height: 270, fill: '#ffffff' }],
      ['add_effect', { nodeId: 'w', type: 'linear-wipe', id: 'lw', params: { wipeAngle: 0, completion: 0 } }],
    ]);
    for (const angle of [0, 90]) {
      await call('update_effect_param', { nodeId: 'w', effectId: 'lw', key: 'wipeAngle', value: angle });
      for (const c of [25, 50, 75]) {
        await call('update_effect_param', { nodeId: 'w', effectId: 'lw', key: 'completion', value: c });
        const p = await frame();
        let white = 0;
        for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (px(p, x, y)[0] > 128) white++;
        const kept = white / (Math.ceil(H / 3) * Math.ceil(W / 3));
        expect([angle, c, Math.abs(kept - (1 - c / 100)) < 0.02]).toEqual([angle, c, true]);
      }
    }
  });

  it('a trimmed, tapered stroke-only ellipse draws a ring, not a filled wedge (The Last Blade)', async () => {
    await run([
      ['create_layer', { id: 'e', kind: 'shape', shape: 'ellipse', name: 'Enso', x: 240, y: 135, width: 200, height: 200, fill: 'none', stroke: '#ffffff', strokeWidth: 12 }],
      ['update_layer', { nodeId: 'e', strokeTaper: { startLength: 30, endLength: 30 } }],
      ['set_trim_path', { nodeId: 'e', id: 'tr', start: 0, end: 80 }],
    ]);
    const p = await frame();
    // The ring is inked; its middle is the background.
    expect(inked(p, 130, 25, 350, 245)).toBeGreaterThan(300);
    expect(inked(p, 200, 95, 280, 175, 12)).toBe(0);
  });
});
