/**
 * Effect and text bugs found authoring the Pro library (premation-library),
 * rendered on the app's engine with the full renderer: each case is an A/B
 * against the same scene without the effect (or with the setting that is
 * meant to be neutral).
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1).
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 480;
const H = 270;

suite('effect bugs from the Pro library', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(4) } } as Command);
    await h.run({ type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  async function clear(): Promise<void> {
    const m = documentMirror();
    const ids = m.layerIds().filter((id) => m.layer(id)?.comp === activeCompRootId());
    if (ids.length) await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: ids } }]);
    await settleEdits();
  }
  async function frame(t = 1): Promise<PNG> {
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const px = (p: PNG, x: number, y: number): [number, number, number] => {
    const i = (Math.round(y) * p.width + Math.round(x)) * 4;
    return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
  };
  /** Mean absolute channel difference (0..255) over a region (default the whole frame). */
  const meanDiff = (a: PNG, b: PNG, r = { x0: 0, y0: 0, x1: W, y1: H }): number => {
    let s = 0;
    let n = 0;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = (y * a.width + x) * 4;
        s += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
        n += 3;
      }
    }
    return s / n;
  };
  /** Pixels in a region whose summed channel difference exceeds `tol`. */
  const changedPx = (a: PNG, b: PNG, r: { x0: number; y0: number; x1: number; y1: number }, tol: number): number => {
    let n = 0;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = (y * a.width + x) * 4;
        if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) > tol) n++;
      }
    }
    return n;
  };
  /** PREMATION_DUMP_DIR: every checked frame is written there as <name>.png (to look at them). */
  const dump = (name: string, p: PNG): void => {
    const dir = process.env.PREMATION_DUMP_DIR;
    if (dir) require('fs').writeFileSync(require('path').join(dir, `${name}.png`), PNG.sync.write(p));
  };
  const named = (name: string): string => {
    const m = documentMirror();
    return m.layerIds().find((id) => m.layer(id)?.name === name && m.layer(id)?.comp === activeCompRootId())!;
  };
  async function build(layers: Array<Record<string, unknown>>): Promise<void> {
    await clear();
    const r = await runToolTurn('AI: scene', layers.map((args) => ({ name: 'create_layer', args })));
    for (const x of r.results) expect(x.ok ? 'ok' : JSON.stringify(x)).toBe('ok');
    await settleEdits();
  }
  async function addFx(host: string, type: string, params: Record<string, unknown>): Promise<void> {
    const r = await runToolTurn(`AI: ${type}`, [{ name: 'add_effect', args: { nodeId: named(host), type, id: 'fx', params } }]);
    expect(r.results[0]!.ok).toBe(true);
  }
  async function removeFx(host: string): Promise<void> {
    await runToolTurn('AI: remove', [{ name: 'update_effect', args: { nodeId: named(host), effectId: 'fx', remove: true } }]);
  }

  const bg = { id: 'bg', kind: 'solid', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#101318' };
  const card = { id: 'card', kind: 'shape', shape: 'rect', name: 'Card', x: W / 2, y: H / 2, width: 320, height: 180, fill: '#3a7bd5' };
  const title = { id: 'title', kind: 'text', name: 'Title', text: 'Premation', fill: '#ffffff', x: W / 2, y: H / 2 };

  it('brightness-contrast at 0 / 0 is neutral (new and legacy)', async () => {
    await build([bg, card, title]);
    const ref = await frame();
    dump('bc-ref', ref);
    for (const useLegacy of [false, true]) {
      await addFx('Title', 'brightness-contrast', { brightness: 0, contrast: 0, useLegacy });
      await addFx('Card', 'brightness-contrast', { brightness: 0, contrast: 0, useLegacy });
      const f = await frame();
      dump(`bc-legacy-${useLegacy}`, f);
      await removeFx('Title');
      await removeFx('Card');
      expect(meanDiff(ref, f)).toBeLessThan(0.5);
    }
  });

  it('basic-3d at rest is the layer, and Specular is a highlight, not a wash', async () => {
    await build([bg, card, title]);
    const ref = await frame();
    await addFx('Card', 'basic-3d', { swivel: 0, tilt: 0, distance: 0 });
    const rest = await frame();
    dump('b3d-ref', ref);
    dump('b3d-rest', rest);
    await removeFx('Card');
    expect(meanDiff(ref, rest)).toBeLessThan(0.5);
    // The top edge row of the card, where the speckles were.
    expect(meanDiff(ref, rest, { x0: 80, y0: 44, x1: 400, y1: 50 })).toBeLessThan(1);
    await addFx('Card', 'basic-3d', { swivel: 0, tilt: 0, distance: 0, specular: true });
    const spec = await frame();
    dump('b3d-spec', spec);
    await removeFx('Card');
    // Most of the card keeps its colour; the highlight is local.
    let changed = 0;
    let total = 0;
    for (let y = 50; y < 220; y += 2) {
      for (let x = 85; x < 395; x += 2) {
        const a = px(ref, x, y);
        const b = px(spec, x, y);
        total++;
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 12) changed++;
      }
    }
    expect(changed / total).toBeLessThan(0.02);
    // Turned toward the light, the glint crosses the card (pixels it lifts by > 30).
    let glint = 0;
    // (At rest the reflection of the light lands ~26° left of and ~31° above the
    // card's centre; a turn moves it by twice the angle.)
    for (const [swivel, tilt] of [[-14, 14], [14, -14], [-14, -14], [14, 14]] as const) {
      await addFx('Card', 'basic-3d', { swivel, tilt, distance: 0 });
      const plain = await frame();
      await removeFx('Card');
      await addFx('Card', 'basic-3d', { swivel, tilt, distance: 0, specular: true });
      const lit = await frame();
      dump(`b3d-spec-${swivel}-${tilt}`, lit);
      await removeFx('Card');
      let area = 0;
      for (let i = 0; i < lit.data.length; i += 4) if (lit.data[i + 1]! - plain.data[i + 1]! > 30) area++;
      glint = Math.max(glint, area);
    }
    expect(glint).toBeGreaterThan(2000);
  });

  it('burn-film cuts a transparent hole', async () => {
    await build([bg, card]);
    const ref = await frame();
    await addFx('Card', 'burn-film', { burn: 30 });
    const f = await frame();
    dump('burn', f);
    await removeFx('Card');
    // The centre of the burn shows the background, not a cream disc.
    const c = px(f, W / 2, H / 2);
    expect(Math.max(...c)).toBeLessThan(30);
    // Away from the burn, the card keeps its colour.
    expect(changedPx(ref, f, { x0: 85, y0: 50, x1: 110, y1: 70 }, 6)).toBe(0);
  });

  it('roughen-edges with a small border leaves the interior whole', async () => {
    await build([bg, card]);
    const ref = await frame();
    for (const border of [2, 4, 8]) {
      for (const complexity of [1, 2]) {
        await addFx('Card', 'roughen-edges', { border, complexity, edgeSharpness: 1 });
        const f = await frame();
        dump(`roughen-${border}-${complexity}`, f);
        await removeFx('Card');
        // 20 px inside the card's edge, no pixel moves.
        expect(changedPx(ref, f, { x0: 100, y0: 65, x1: 380, y1: 205 }, 6)).toBe(0);
      }
    }
  });

  // Any effect pass on a layer whose origin sits on a fractional pixel (a
  // centred title with an odd height) used to soften it: P8b ran the chain at
  // a whole pixel and shifted the result back by the fraction. Light Wipe at
  // ~0 % made it visible.
  it('light-wipe near 0 % leaves the layer sharp', async () => {
    await build([bg, card, title]);
    const ref = await frame();
    await addFx('Title', 'light-wipe', { completion: 1 });
    const f = await frame();
    dump('lw-ref', ref);
    dump('lw-1', f);
    await removeFx('Title');
    // White type under a white light band: no pixel of the title may move
    // (the wipe front is ~1 px in; the band tints white toward white).
    expect(changedPx(ref, f, { x0: 100, y0: 100, x1: 380, y1: 170 }, 24)).toBe(0);
  });

  it('text with a transparent fill and a Character stroke draws a hollow outline', async () => {
    await build([bg, { ...title, text: 'O', fill: 'rgba(0,0,0,0)', stroke: '#ffcc00', strokeWidth: 3 }]);
    await runToolTurn('AI: size', [{ name: 'update_layer', args: { nodeId: named('Title'), fontSize: 200 } }]);
    const f = await frame();
    dump('outline-text', f);
    let lit = 0;
    for (let i = 0; i < f.data.length; i += 4) if (f.data[i]! > 150 && f.data[i + 1]! > 120 && f.data[i + 2]! < 80) lit++;
    expect(lit).toBeGreaterThan(200);
    // The counter of the O and the inside of its stroke show the background.
    const bgc = px(f, 10, 10);
    let hollow = 0;
    for (let x = 160; x < 320; x++) {
      const c = px(f, x, H / 2);
      if (Math.abs(c[0] - bgc[0]) + Math.abs(c[1] - bgc[1]) + Math.abs(c[2] - bgc[2]) < 6) hollow++;
    }
    expect(hollow).toBeGreaterThan(100);
  });
});
