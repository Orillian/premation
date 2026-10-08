/**
 * Engine stills (getThumbnail) on the real GPU renderer agree with the colours
 * the document authored, and with the viewport's own frame.
 *
 * The regression (2026-10-08): the design system's backdrop — a solid with a
 * `gradient-ramp` (create_gradient) — came out washed, deep navy #02081b as
 * (22, 50, 91): the ramp wrote its sRGB stops raw into the linear chain buffer,
 * and the display encode applied a second time.
 *
 * Needs the full engine and a GPU adapter; skipped (with a note) without them.
 */

import { backgroundLight, gradientStops, resolvePack } from '@motion/design-system';
import { setupAppEngine, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '@core/engine/__testHelpers__/nativeEngine';
import { activeCompRootId } from '@core/scene/activeComp';
import { decodePng } from '@core/ai/author/eval/contactSheet';
import { McpCallHost, type McpResult } from '@core/ai/mcp/mcpHost';
import { editorMcpDeps } from '@core/ai/mcp/mcpDefaults';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

const suite = nativeEngineIsHeadless() ? describe.skip : describe;

/** The main viewport (appEngine's openMainViewport): 1920×1080 at zoom 1, the comp's top-left at its centre. */
const VIEWPORT = 1;
const COMP_ORIGIN_IN_VIEWPORT = { x: 960, y: 540 };

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const encode = (v: number): number => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));

suite('engine stills on the GPU renderer', () => {
  let h: Harness;
  let host: McpCallHost;
  /** False once this machine showed it cannot render (no adapter, or the engine would not start with one). */
  let gpu = true;
  beforeEach(async () => {
    if (!gpu) return;
    try {
      h = await setupAppEngine({ gpu: true });
    } catch (e) {
      gpu = false;
      console.log(`[engineStill] the engine did not start with a GPU: skipped (${String(e)})`);
      return;
    }
    host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }), renderStrip: async () => null });
  });
  afterEach(async () => {
    if (!gpu) return;
    await host.stop();
    await h.dispose();
  });
  const call = (name: string, args: unknown): Promise<McpResult> => host.handle({ clientId: 1, name, args });

  /** The comp's still at 0.5 s, full size; null when this machine's engine has no renderer. */
  async function still(): Promise<((x: number, y: number) => Rgb) | null> {
    const comp = activeCompRootId() as string;
    let th;
    try {
      th = await h.query({ type: 'getThumbnail', item: comp, time: sec(0.5), maxSize: 1920 });
    } catch (e) {
      if (/unsupported|renderer|C2 quads/i.test(String(e))) return null;
      throw e;
    }
    const d = decodePng(th.data);
    return (x, y) => Array.from(d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 3)) as Rgb;
  }

  /** The viewport's frame at comp (x, y): its working-space pixel, display-encoded. */
  async function viewport(x: number, y: number): Promise<Rgb> {
    const p = await h.query({
      type: 'readPixels',
      viewport: VIEWPORT,
      region: { x: COMP_ORIGIN_IN_VIEWPORT.x + x, y: COMP_ORIGIN_IN_VIEWPORT.y + y, width: 1, height: 1 },
    });
    return p.rgba.slice(0, 3).map(encode) as Rgb;
  }

  /** The viewport has drawn the current document (a frame lands a few round trips after the edit). */
  async function viewportMatching(x: number, y: number, want: Rgb): Promise<Rgb> {
    let got: Rgb = [NaN, NaN, NaN];
    for (let i = 0; i < 40; i++) {
      try {
        got = await viewport(x, y);
        if (got.every((v, c) => Math.abs(v - want[c]!) <= 1)) return got;
      } catch {
        // pending: no frame shown yet
      }
      await new Promise((r) => { setTimeout(r, 100); });
    }
    return got;
  }

  const near = (a: Rgb, b: Rgb, tol: number): boolean => a.every((v, c) => Math.abs(v - b[c]!) <= tol);

  it('a flat gradient-ramp still shows its authored colour, as the viewport does', async () => {
    if (!gpu) return;
    const r = await call('create_gradient', { id: 'bg', name: 'Backdrop', stops: ['#02081b', '#02081b'], angle: 115 });
    expect(r.isError).toBeUndefined();
    const px = await still();
    if (!px) {
      console.log('[engineStill] no GPU renderer on this machine: skipped');
      await host.stop();
      await h.dispose();
      gpu = false;
      return;
    }
    for (const [x, y] of [[4, 4], [960, 540], [1915, 1075]] as const) {
      expect(near(px(x, y), hex('#02081b'), 1)).toBe(true);
    }
    expect(near(await viewportMatching(4, 4, px(4, 4)), px(4, 4), 1)).toBe(true);
  });

  it("the design system's backdrop stays inside its stops, in the still and in the viewport", async () => {
    if (!gpu) return;
    const pack = resolvePack('apple_keynote', { accent: '#5b8cff' });
    const light = backgroundLight(pack.palette.bg, pack.palette.accent, { lift: 0.07 });
    const stops = gradientStops(light.stops[0]!, light.stops[1]!, 3);
    const r = await call('create_gradient', { id: 'bg', name: 'Backdrop', stops, kind: light.kind, angle: light.angle });
    expect(r.isError).toBeUndefined();
    const px = await still();
    if (!px) return;
    const lo = [0, 1, 2].map((c) => Math.min(...stops.map((s) => hex(s)[c]!)) - 2);
    const hi = [0, 1, 2].map((c) => Math.max(...stops.map((s) => hex(s)[c]!)) + 2);
    for (const [x, y] of [[4, 4], [960, 540], [1915, 1075]] as const) {
      const p = px(x, y);
      // Washed out (the double encode) put the top-left at about (50, 76, 113).
      p.forEach((v, c) => {
        expect(v).toBeGreaterThanOrEqual(lo[c]!);
        expect(v).toBeLessThanOrEqual(hi[c]!);
      });
    }
    expect(near(await viewportMatching(4, 4, px(4, 4)), px(4, 4), 1)).toBe(true);
  });
});
