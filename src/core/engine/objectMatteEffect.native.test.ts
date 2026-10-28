/**
 * The Object Matte effect card (`object-matte`, After Effects' Object Matte):
 * footage given an Object Matte (setLayerMatte) gets the card in the same
 * history entry, and the stored cut-out frame cuts the layer THROUGH it — so
 * its Invert and Fine-tune controls (Feather, Shift Edge, Contrast) are live,
 * disabling or removing it shows the layer uncut, and undo takes the matte and
 * the card back together.
 *
 * The footage is a flat orange clip over a navy solid; its matte is the left
 * half of the frame (x < 160). Needs a GPU adapter (PREMATION_GPU_TESTS=1) and
 * ffmpeg on PATH (the clip is made once in the OS temp folder).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { Command, PropertyTree } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const W = 320;
const H = 180;
const DIR = path.join(os.tmpdir(), 'premation-test-clips');

function clip(): string | null {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, 'object_matte_flat_320x180.mp4');
  if (fs.existsSync(file)) return file;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xd0502a:s=${W}x${H}:r=30:d=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '4', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore', timeout: 120_000 });
    return file;
  } catch {
    return null;
  }
}

const file = process.env.PREMATION_GPU_TESTS === '1' ? clip() : null;
const suite = file ? describe : describe.skip;

suite('the Object Matte effect cuts footage live from its stored matte', () => {
  let h: Harness;
  let video = '';
  let matteDir = '';
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: W, height: H, frameRate: { num: 30, den: 1 }, duration: sec(2) } } as Command);
    await h.run({ type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await runToolTurn('AI: ground', [{ name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#20243a' } }]);
    const items = (await h.run({ type: 'importFiles', files: [{ path: file!, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
    video = ((await h.run({ type: 'createLayer', comp, kind: 'video', source: items.items[0], init: [] } as Command)) as unknown as { layer: string }).layer;
    // The cut-out frame: the footage's colour, opaque on the left half.
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        png.data[i] = 208; png.data[i + 1] = 80; png.data[i + 2] = 42;
        png.data[i + 3] = x < W / 2 ? 255 : 0;
      }
    }
    matteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-omatte-'));
    const frame = path.join(matteDir, 'matte_000000.png');
    fs.writeFileSync(frame, PNG.sync.write(png));
    await settleEdits();
    await h.run({ type: 'clearHistory' } as Command);
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(0), src: frame }] } as Command);
    await settleEdits();
  }, 180_000);
  afterAll(async () => {
    await h.dispose();
    if (matteDir) fs.rmSync(matteDir, { recursive: true, force: true });
  });

  async function frame(): Promise<PNG> {
    await settleEdits();
    await engineIdle();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(0.5), maxSize: W } as never)) as { data: Uint8Array };
    const p = PNG.sync.read(Buffer.from(th.data));
    const dir = process.env.PREMATION_DUMP_DIR;
    if (dir) fs.writeFileSync(path.join(dir, `omatte-${Date.now()}.png`), PNG.sync.write(p));
    return p;
  }
  /** The red channel at (x, y) — orange footage ≈ 208, the navy ground ≈ 32. */
  const red = (p: PNG, x: number, y = 90): number => p.data[(Math.round(y * p.height / H) * p.width + Math.round(x * p.width / W)) * 4]!;
  async function cardId(): Promise<string> {
    const tree = (await h.query({ type: 'getPropertyTree', layer: video, path: 'effects', depth: 2 } as never)) as PropertyTree;
    const card = tree.nodes.find((n) => n.matchName === 'object-matte');
    expect(card).toBeDefined();
    return card!.path.slice('effects/'.length);
  }
  async function set(key: string, value: unknown): Promise<void> {
    const r = await runToolTurn('AI: param', [{ name: 'update_effect_param', args: { nodeId: video, effectId: await cardId(), key, value } }]);
    expect(r.results[0]!.ok).toBe(true);
  }
  async function errors(): Promise<string[]> {
    await engineIdle();
    return documentMirror().layerErrors(activeCompRootId() as string).filter((e) => e.stage !== 'font').map((e) => `${e.stage} ${e.message}`);
  }

  it('setLayerMatte on footage adds the card in the same history entry; the cut is the card\'s', async () => {
    const hist = await h.query({ type: 'getHistory' } as never) as { entries: Array<{ label: string }> };
    expect(hist.entries.map((e) => e.label)).toEqual(['Object Matte']);
    await cardId();
    const f = await frame();
    expect(red(f, 60)).toBeGreaterThan(170);   // the subject
    expect(red(f, 260)).toBeLessThan(70);      // cut away: the navy ground
    expect(await errors()).toEqual([]);
  }, 120_000);

  it('Invert keeps the background instead', async () => {
    await set('invert', true);
    const f = await frame();
    expect(red(f, 60)).toBeLessThan(70);
    expect(red(f, 260)).toBeGreaterThan(170);
    await set('invert', false);
  }, 120_000);

  it('Fine-tune: Feather softens the edge, Shift Edge moves it, Contrast steepens it — all live', async () => {
    const hard = await frame();
    // Fine-tune off: Feather does nothing.
    await set('feather', 24);
    expect(Math.abs(red(await frame(), 166) - red(hard, 166))).toBeLessThan(6);
    await set('fineTune', true);
    const soft = await frame();
    // Past the edge the feathered matte lets some footage through; inside, some ground.
    expect(red(soft, 166)).toBeGreaterThan(red(hard, 166) + 20);
    expect(red(soft, 154)).toBeLessThan(red(hard, 154) - 20);
    await set('contrast', 100);
    const steep = await frame();
    expect(red(steep, 166)).toBeLessThan(red(soft, 166) - 10);
    await set('contrast', 0);
    await set('feather', 0);
    // Shift Edge +100 % (of max(Feather, 10 px)) grows the matte 10 px; -100 % shrinks it.
    await set('shiftEdge', 100);
    const grown = await frame();
    expect(red(grown, 165)).toBeGreaterThan(170);
    await set('shiftEdge', -100);
    const shrunk = await frame();
    expect(red(shrunk, 155)).toBeLessThan(70);
    await set('shiftEdge', 0);
    await set('fineTune', false);
    expect(await errors()).toEqual([]);
  }, 300_000);

  it('disabled, the layer shows uncut; removed, too; undo brings the card and the cut back', async () => {
    const id = await cardId();
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: video, path: `effects/${id}` }], enabled: false } as Command);
    const off = await frame();
    expect(red(off, 60)).toBeGreaterThan(170);
    expect(red(off, 260)).toBeGreaterThan(170);
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: video, path: `effects/${id}` }], enabled: true } as Command);
    expect(red(await frame(), 260)).toBeLessThan(70);
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: video, path: `effects/${id}` }] } as Command);
    expect(red(await frame(), 260)).toBeGreaterThan(170);
    await h.run({ type: 'undo' } as Command);
    expect(red(await frame(), 260)).toBeLessThan(70);
  }, 180_000);
});
