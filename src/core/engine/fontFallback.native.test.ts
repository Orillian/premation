/**
 * T1 / T4 (docs/PROGRAM_PLAYBACK_TEXT_INK.md): per-character font fallback and
 * the missing-font report, on the app's engine with the full renderer.
 *
 * Found 2026-10-09: kanji set in a family that is not installed ("Yu Mincho")
 * came out as boxes — the engine looked only in the families the layer named
 * and then drew the first face's missing glyph — and every uninstalled family
 * (Cormorant, Playfair, Inter) fell back to one sans without a word.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1), like the other full-renderer suites.
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;

suite('per-character font fallback', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: 1280, height: 360, duration: sec(2) } } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  /** Dark pixels of the frame (ink of black text on white). */
  async function ink(): Promise<number> {
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: 0, maxSize: 1280 } as never)) as { data: Uint8Array };
    const png = PNG.sync.read(Buffer.from(th.data));
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i]! < 100) n++;
    return n;
  }

  async function textIn(family: string, text = '最後の一太刀 静'): Promise<number> {
    const r = await runToolTurn(`AI: kanji in ${family}`, [
      { name: 'create_layer', args: { id: 'bg', kind: 'shape', name: `BG ${family}`, x: 640, y: 180, width: 1280, height: 360, fill: '#ffffff' } },
      { name: 'create_layer', args: { id: 't', kind: 'text', name: `Kanji ${family}`, text, x: 640, y: 180 } },
      { name: 'update_layer', args: { nodeId: 't', fontSize: 120, fill: '#000000', fontFamily: family } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const n = await ink();
    const m = documentMirror();
    await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: m.layerIds().filter((id) => (m.layer(id)?.name ?? '').endsWith(family)) } }]);
    await settleEdits();
    return n;
  }

  it('kanji in an uninstalled family draw as glyphs, like the same text in an installed CJK family', async () => {
    const real = await textIn('Yu Gothic');
    const missing = await textIn('Definitely Not A Font');
    expect(real).toBeGreaterThan(2000);
    // Boxes are hollow outlines: far less ink than the glyphs. Glyphs from the
    // OS fallback face land within a third of the named CJK face's ink.
    expect(Math.abs(missing - real) / real).toBeLessThan(0.35);
  }, 120_000);

  it('Hangul in an uninstalled family draws as glyphs too (the Korean face the OS picks)', async () => {
    const real = await textIn('Malgun Gothic', '마지막 사무라이');
    const missing = await textIn('Not A Korean Font', '마지막 사무라이');
    expect(real).toBeGreaterThan(1500);
    expect(Math.abs(missing - real) / real).toBeLessThan(0.35);
  }, 120_000);

  /** The frame's RGBA after drawing `text` in `family` with `language` (the layer's T3 field). */
  async function drawn(family: string, language: string | undefined, text = '骨直角次化'): Promise<Buffer> {
    const r = await runToolTurn(`AI: han ${family} ${language}`, [
      { name: 'create_layer', args: { id: 'bg', kind: 'shape', name: `BG ${family}`, x: 640, y: 180, width: 1280, height: 360, fill: '#ffffff' } },
      { name: 'create_layer', args: { id: 't', kind: 'text', name: `Han ${family}`, text, x: 640, y: 180 } },
      { name: 'update_layer', args: { nodeId: 't', fontSize: 140, fill: '#000000', fontFamily: family, ...(language ? { language } : {}) } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: 0, maxSize: 1280 } as never)) as { data: Uint8Array };
    const px = PNG.sync.read(Buffer.from(th.data)).data;
    const m = documentMirror();
    await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: m.layerIds().filter((id) => (m.layer(id)?.name ?? '').endsWith(family)) } }]);
    await settleEdits();
    return px;
  }
  const differing = (a: Buffer, b: Buffer): number => {
    let n = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 4) if (Math.abs(a[i]! - b[i]!) > 64) n++;
    return n;
  };

  it('T3: the layer language picks the Han face — ja draws the Japanese face, zh-Hant the Chinese one', async () => {
    // Arial has no Han: every glyph comes from the fallback the language picks,
    // on Arial's line metrics in all four draws.
    const japanese = await drawn('Arial', 'ja');
    const chinese = await drawn('Arial', 'zh-Hant');
    const namedJa = await drawn('Arial, Yu Gothic', 'ja');
    const namedZh = await drawn('Arial, Microsoft JhengHei', 'zh-Hant');
    // Two faces: the glyphs land differently (stroke forms, weight).
    expect(differing(japanese, chinese)).toBeGreaterThan(1500);
    // Each is the OS's face for its language: close to the same text named in it.
    expect(differing(japanese, namedJa)).toBeLessThan(differing(japanese, chinese) / 3);
    expect(differing(chinese, namedZh)).toBeLessThan(differing(japanese, chinese) / 3);
  }, 120_000);

  it('records a font layer error naming the family that is missing', async () => {
    const r = await runToolTurn('AI: missing font', [
      { name: 'create_layer', args: { id: 't', kind: 'text', name: 'Serif title', text: 'The Last Cut' } },
      { name: 'update_layer', args: { nodeId: 't', fontFamily: 'Cormorant Garamond Not Installed' } },
      { name: 'create_layer', args: { id: 'ok', kind: 'text', name: 'Generic title', text: 'Fine' } },
      { name: 'update_layer', args: { nodeId: 'ok', fontFamily: 'Not Installed Either, sans-serif' } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    // Layer errors are announced with viewport frames.
    await h.run({ type: 'setViewport', viewport: 1, width: 640, height: 360, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
    await engineIdle();
    const m = documentMirror();
    const serif = m.layerIds().find((id) => m.layer(id)?.name === 'Serif title')!;
    const generic = m.layerIds().find((id) => m.layer(id)?.name === 'Generic title')!;
    const errs = m.layerErrors(activeCompRootId() as string);
    expect(errs.filter((e) => e.layer === serif && e.stage === 'font').map((e) => e.message).join()).toContain("'Cormorant Garamond Not Installed'");
    // The author's own fallback (a CSS generic) is honoured: not reported.
    expect(errs.filter((e) => e.layer === generic && e.stage === 'font')).toEqual([]);
    // The model reads it in describe_scene.
    const d = await runToolTurn('AI: look', [{ name: 'describe_scene', args: {} }]);
    expect(d.results[0]!.content).toContain("font 'Cormorant Garamond Not Installed' is not installed");
  }, 120_000);
});
