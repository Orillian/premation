/**
 * Text quality on the full renderer (docs/AUDIT_2026-10-18_TEXT.md): the four
 * engine findings of the audit, pinned by rendering through the app's engine
 * the way the AI tools and the Character panel write.
 *
 *   T1  a system family's italic draws its italic face (DirectWrite's simulated
 *       obliques used to shadow it);
 *   T2  Small Caps synthesize on a face without `smcp` (Inter, the default);
 *   T3  `tracking` is 1/1000 em — the same look at 40 px and 120 px;
 *   T5  `textAnchor: alignment` anchors point text at its alignment edge.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1), like the other full-renderer suites.
 */

import path from 'node:path';
import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';
import { fieldCommands } from '@layout/Text/textEdits';
import { paths } from '@core/engine/propRefs';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';
import { docView } from './__testHelpers__/docView';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 1280;
const H = 360;
const manifest = path.join(__dirname, '..', '..', '..', 'resources', 'fonts', 'fonts.json');

suite('text quality (audit 2026-10-18)', () => {
  let h: Harness;
  beforeAll(async () => {
    // The shipped fonts, as the app's engine host passes them (Inter is the default family).
    process.env.PREMATION_FONTS_MANIFEST = manifest;
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(2) } } as Command);
    await settleEdits();
  }, 90_000);
  afterAll(async () => {
    await h.dispose();
    delete process.env.PREMATION_FONTS_MANIFEST;
  });

  afterEach(async () => {
    const m = documentMirror();
    const ids = m.layerIds().filter((id) => m.layer(id)?.comp === activeCompRootId());
    if (ids.length) await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: ids } }]);
    await settleEdits();
  });

  /** The real layer id of a tool alias (the layer is named after it). */
  function real(alias: string): string {
    const m = documentMirror();
    return m.layerIds().find((id) => m.layer(id)?.name === alias) ?? alias;
  }

  async function tools(label: string, calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<void> {
    const r = await runToolTurn(`AI: ${label}`, calls);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
  }

  /** A Text field as the Character panel writes it (`text/<key>`). */
  async function field(alias: string, key: string, value: unknown): Promise<void> {
    const cmds = fieldCommands(real(alias), paths.textProp(key), value);
    expect(cmds.length).toBeGreaterThan(0);
    await h.batch(`field ${key}`, cmds);
  }

  async function frame(): Promise<PNG> {
    await settleEdits();
    await engineIdle();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: 0, maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }

  /** Dark pixels (ink of black text on white) inside a band of rows. */
  function ink(p: PNG, y0: number, y1: number): { count: number; left: number; right: number; top: number; bottom: number } {
    let count = 0;
    let left = p.width;
    let right = -1;
    let top = p.height;
    let bottom = -1;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < p.width; x++) {
        if (p.data[(y * p.width + x) * 4]! < 110) {
          count++;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    return { count, left, right, top, bottom };
  }

  const bg = { name: 'create_layer', args: { id: 'bg', kind: 'shape', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#ffffff' } };
  const text = (id: string, content: string, x: number, y: number, extra: Record<string, unknown>) => [
    { name: 'create_layer', args: { id, kind: 'text', name: id, text: content, x, y } },
    { name: 'update_layer', args: { nodeId: id, fill: '#000000', ...extra } },
  ];

  it('T1: a system family with a real italic face draws it (Arial / Georgia), not the upright', async () => {
    if (process.platform !== 'win32') return;  // the families named are Windows'
    await tools('italics', [
      bg,
      ...text('u', 'Georgia Georgia', 320, 90, { fontFamily: 'Georgia', fontSize: 64, fontWeight: 400 }),
      ...text('i', 'Georgia Georgia', 320, 230, { fontFamily: 'Georgia', fontSize: 64, fontWeight: 400 }),
      ...text('au', 'Arial Arial', 960, 90, { fontFamily: 'Arial', fontSize: 64, fontWeight: 400 }),
      ...text('ai', 'Arial Arial', 960, 230, { fontFamily: 'Arial', fontSize: 64, fontWeight: 400 }),
    ]);
    await field('i', 'fontStyle', 'italic');
    await field('ai', 'fontStyle', 'italic');
    const p = await frame();
    // Row by row, the same string upright vs italic differs in many pixels on
    // each side (an italic face is a different design, not a shear of the upright).
    const diff = (x0: number, x1: number): number => {
      let n = 0;
      for (let y = 0; y < 140; y++) {
        for (let x = x0; x < x1; x++) {
          const a = p.data[(y * p.width + x) * 4]!;
          const b = p.data[((y + 140) * p.width + x) * 4]!;
          if (Math.abs(a - b) > 64) n++;
        }
      }
      return n;
    };
    expect(diff(0, 640)).toBeGreaterThan(1500);    // Georgia
    expect(diff(640, 1280)).toBeGreaterThan(1500); // Arial
  }, 120_000);

  it('T2: Small Caps on Inter (no smcp in the file) draws capitals at 0.7 — taller than lowercase, shorter than capitals', async () => {
    await tools('small caps', [
      bg,
      ...text('l', 'xaxaxaxa', 320, 60, { fontFamily: 'Inter', fontSize: 80, fontWeight: 500 }),
      ...text('s', 'xaxaxaxa', 320, 180, { fontFamily: 'Inter', fontSize: 80, fontWeight: 500 }),
      ...text('c', 'XAXAXAXA', 320, 300, { fontFamily: 'Inter', fontSize: 80, fontWeight: 500 }),
    ]);
    await field('s', 'fontVariant', 'small-caps');
    const p = await frame();
    const lower = ink(p, 0, 120);
    const small = ink(p, 120, 240);
    const caps = ink(p, 240, 360);
    const height = (b: { top: number; bottom: number }) => b.bottom - b.top;
    // Inter: x-height 0.53 em, cap height 0.73 em; small caps at 0.7 of the capitals.
    expect(height(small)).toBeGreaterThan(height(lower) * 0.9);
    expect(height(small)).toBeLessThan(height(caps) * 0.8);
    // Capital shapes: the glyph run is wider than the lowercase one's at the same size scale.
    expect(small.right - small.left).toBeGreaterThan((caps.right - caps.left) * 0.6);
  }, 120_000);

  it('T3: `tracking` is 1/1000 em — 100 widens a line by 0.1 em per gap at 40 px and at 120 px alike', async () => {
    const line = 'HHHHHH';  // six glyphs, five gaps
    await tools('tracking', [
      bg,
      ...text('a0', line, 320, 50, { fontFamily: 'Inter', fontSize: 40, fontWeight: 500 }),
      ...text('a1', line, 320, 130, { fontFamily: 'Inter', fontSize: 40, fontWeight: 500 }),
      ...text('b0', line, 960, 70, { fontFamily: 'Inter', fontSize: 120, fontWeight: 500 }),
      ...text('b1', line, 960, 250, { fontFamily: 'Inter', fontSize: 120, fontWeight: 500 }),
    ]);
    await field('a1', 'tracking', 100);
    await field('b1', 'tracking', 100);
    const p = await frame();
    const w = (y0: number, y1: number, x0: number, x1: number): number => {
      let left = x1;
      let right = x0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (p.data[(y * p.width + x) * 4]! < 110) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
      }
      return right - left;
    };
    const small = w(90, 170, 0, 640) - w(10, 90, 0, 640);
    const large = w(160, 340, 640, 1280) - w(0, 160, 640, 1280);
    // Five gaps × 0.1 em: 20 px at 40 px, 60 px at 120 px (± a pixel each side).
    expect(Math.abs(small - 20)).toBeLessThanOrEqual(3);
    expect(Math.abs(large - 60)).toBeLessThanOrEqual(3);
  }, 120_000);

  it('T5: textAnchor "alignment" puts a left-aligned point text\'s left edge at its position; "center" centres it', async () => {
    await tools('anchor', [
      bg,
      ...text('l', 'Anchored title', 640, 60, { fontFamily: 'Inter', fontSize: 56, fontWeight: 600, align: 'left' }),
      ...text('r', 'Anchored title', 640, 180, { fontFamily: 'Inter', fontSize: 56, fontWeight: 600, align: 'right' }),
      ...text('c', 'Anchored title', 640, 300, { fontFamily: 'Inter', fontSize: 56, fontWeight: 600, align: 'left' }),
    ]);
    await field('l', 'textAnchor', 'alignment');
    await field('r', 'textAnchor', 'alignment');
    const p = await frame();
    const left = ink(p, 0, 120);
    const right = ink(p, 120, 240);
    const centred = ink(p, 240, 360);
    // Ink starts just right of x = 640 (the A's side bearing), ends just left of it, or straddles it.
    expect(left.left).toBeGreaterThanOrEqual(640 - 2);
    expect(left.left).toBeLessThan(640 + 12);
    expect(right.right).toBeLessThanOrEqual(640 + 2);
    expect(right.right).toBeGreaterThan(640 - 12);
    expect(Math.abs((centred.left + centred.right) / 2 - 640)).toBeLessThan(6);
    // Same width in all three: the anchor moved, the text did not change.
    expect(Math.abs((left.right - left.left) - (right.right - right.left))).toBeLessThanOrEqual(2);
  }, 120_000);

  it('T7: update_layer takes AE\'s justification modes, the italic face and tracking', async () => {
    await tools('ai text', [
      bg,
      ...text('p', 'A paragraph that wraps inside its box and is justified on every line but the last one, which stays ragged on the left.', 400, 180, {
        fontFamily: 'Inter', fontSize: 28, lineHeight: 1.7, boxWidth: 600, align: 'justify', tracking: 20, fontStyle: 'italic', textAnchor: 'alignment',
      }),
    ]);
    const props = (await docView()).getNode(real('p'))?.components.find((c) => c.type === 'Text')?.props ?? {};
    expect(props.align).toBe('justify');
    expect(props.fontStyle).toBe('italic');
    expect(props.tracking).toBe(20);
    expect(props.textAnchor).toBe('alignment');
    // And it renders: a justified paragraph fills every line but the last to the same right edge.
    const p = await frame();
    const rows: Array<{ top: number; bottom: number; right: number }> = [];
    for (let y = 0; y < p.height; y++) {
      let right = -1;
      for (let x = 0; x < p.width; x++) if (p.data[(y * p.width + x) * 4]! < 110) right = x;
      if (right < 0) continue;
      const last = rows[rows.length - 1];
      if (last && last.bottom === y - 1) { last.bottom = y; last.right = Math.max(last.right, right); }
      else rows.push({ top: y, bottom: y, right });
    }
    const lines = rows.filter((r) => r.bottom - r.top > 8);  // glyph rows, not a stray descender
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(lines[0]!.right - lines[1]!.right)).toBeLessThanOrEqual(3);
  }, 120_000);
});
