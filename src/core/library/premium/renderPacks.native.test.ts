/**
 * Library pack review renders — a DEVELOPMENT TOOL, not a test of the app.
 *
 * Runs only when `PREMATION_RENDER_PACKS` names a folder of built packs
 * (`<id>/meta.json` + `payload.json`): each template pack is laid into a fresh
 * composition of the REAL engine through the same preparation the Library's
 * insert uses (`preparedLayers`, asset placeholders imported first), and
 * rendered. Into each pack folder it writes:
 *   review/sheet.png  — a contact sheet of 12 frames, for judging the motion
 *   poster.webp       — the rest frame, the card's still
 *   preview.mp4       — the loop the card plays (needs ffmpeg on PATH or FFMPEG_PATH)
 * so what a buyer sees on the card is rendered from exactly what they insert.
 *
 *   PREMATION_RENDER_PACKS=../premation-library/dist/packs npx jest renderPacks.native
 *   PREMATION_RENDER_ONLY=pro.template.line-grid-gallery  (optional filter)
 *
 * A pack that fails to paste, or renders with layer errors, fails here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap, type Command, type EngineClient } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { encodeFragmentLayers } from '@/engine-client/fragmentBuilder';
import { hexToColor } from '@core/engine/model';
import { compTime } from '@core/engine/propRefs';
import { parsePayload, type PremiumMeta, type TemplatePayload } from './packFormat';
import { preparedLayers, type ImportedRef } from './templatePayload';
import { planLottieImport } from '@core/lottie/lottieImport';
import { buildLottieFragment } from '@/engine-client/lottieFragment';
import type { LottiePayload } from './packFormat';

/** The card backdrop a Lottie item is previewed on (the Library's thumb ground). */
const LOTTIE_GROUND = '#15161a';

jest.setTimeout(30 * 60_000);

const ROOT = process.env.PREMATION_RENDER_PACKS ? path.resolve(process.env.PREMATION_RENDER_PACKS) : '';
const ONLY = process.env.PREMATION_RENDER_ONLY ?? '';
const exe = nativeEngineExe();
const run = !!ROOT && existsSync(ROOT) && !!exe && !/headless/i.test(exe);
const maybe = run ? describe : describe.skip;

type Png = { width: number; height: number; data: Buffer };
// Test-only codec (devDependency).
const { PNG } = require('pngjs') as { PNG: { new (o: { width: number; height: number }): Png; sync: { read(b: Buffer): Png; write(p: Png): Buffer } } };

function packs(): Array<{ dir: string; meta: PremiumMeta }> {
  return readdirSync(ROOT)
    .filter((n) => existsSync(path.join(ROOT, n, 'meta.json')))
    .filter((n) => !ONLY || n === ONLY)
    .map((n) => ({ dir: path.join(ROOT, n), meta: JSON.parse(readFileSync(path.join(ROOT, n, 'meta.json'), 'utf8')) as PremiumMeta }))
    .filter((p) => p.meta.kind === 'template' || p.meta.kind === 'lottie');
}

function sheet(frames: Png[], cols: number): Png {
  const w = frames[0]!.width, h = frames[0]!.height, gap = 6;
  const rows = Math.ceil(frames.length / cols);
  const out = new PNG({ width: cols * w + (cols + 1) * gap, height: rows * h + (rows + 1) * gap });
  out.data.fill(40);
  frames.forEach((f, i) => {
    const ox = gap + (i % cols) * (w + gap), oy = gap + Math.floor(i / cols) * (h + gap);
    for (let y = 0; y < Math.min(h, f.height); y++) {
      f.data.copy(out.data, ((oy + y) * out.width + ox) * 4, y * f.width * 4, y * f.width * 4 + Math.min(w, f.width) * 4);
    }
  });
  return out;
}

function ffmpeg(): string | null {
  const cand = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    execFileSync(cand, ['-version'], { stdio: 'ignore' });
    return cand;
  } catch {
    return null;
  }
}

maybe('library pack review renders', () => {
  let native: NativeEngine;
  let client: EngineClient;

  beforeAll(async () => {
    // The fonts the app ships, as electron/engineHost.ts hands them to the engine.
    const manifest = path.join(__dirname, '..', '..', '..', '..', 'resources', 'fonts', 'fonts.json');
    if (existsSync(manifest)) process.env.PREMATION_FONTS_MANIFEST = manifest;
    native = await startNativeEngine({ extraArgs: [] });
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
  });

  it.each(run ? packs().map((p) => [p.meta.id, p] as const) : [['none', null] as const])('%s', async (_id, pack) => {
    if (!pack) return;
    let s: { width: number; height: number; fps: number; durationSeconds: number; background: string };
    let comp: string;
    if (pack.meta.kind === 'lottie') {
      // A Lottie item: its document through the Library's own import plan, on the card ground.
      const doc = (parsePayload('lottie', readFileSync(path.join(pack.dir, 'payload.json'))).payload as LottiePayload).doc;
      const plan = planLottieImport(doc);
      expect(plan.warnings).toEqual([]);
      s = { width: plan.comp.width, height: plan.comp.height, fps: plan.comp.fps, durationSeconds: plan.comp.durationSeconds, background: LOTTIE_GROUND };
      comp = (unwrap(await client.execute({
        type: 'createComposition',
        settings: { name: pack.meta.name, width: s.width, height: s.height, frameRate: { num: Math.round(s.fps), den: 1 }, duration: compTime(s.durationSeconds), background: hexToColor(s.background) },
        fromItems: [],
      } as Command)) as unknown as { item: string }).item;
      const { built } = buildLottieFragment(plan, { offset: { x: 0, y: 0 }, compFps: s.fps, compDurationSeconds: s.durationSeconds });
      expect(built).toBeTruthy();
      unwrap(await client.execute({ type: 'pasteLayers', comp, fragment: built!.fragment, index: 0 } as Command));
    } else {
    const payload = parsePayload('template', readFileSync(path.join(pack.dir, 'payload.json'))).payload as TemplatePayload;
    s = payload.settings;
    const created = unwrap(await client.execute({
      type: 'createComposition',
      settings: {
        name: pack.meta.name, width: s.width, height: s.height,
        frameRate: { num: s.fps, den: 1 }, duration: compTime(s.durationSeconds), background: hexToColor(s.background),
      },
      fromItems: [],
    } as Command)) as unknown as { item: string };
    comp = created.item;

    const imported: ImportedRef[] = [];
    for (const a of payload.assets) {
      const res = unwrap(await client.execute({ type: 'importBytes', files: [{ name: a.name, data: new Uint8Array(Buffer.from(a.data, 'base64')), mimeType: a.mime }] } as Command)) as { items?: string[] };
      const id = res.items?.[0];
      expect(id).toBeTruthy();
      const info = unwrap(await client.query({ type: 'getItems', items: [id!] })).items[0]!;
      imported.push({ ref: a.ref, id: info.id, src: info.mediaUrl ?? '' });
    }
    const target = payload.mode === 'element' ? { width: s.width, height: s.height, fps: s.fps, t0: 0 } : null;
    const layers = preparedLayers(payload, imported, target);
    unwrap(await client.execute({ type: 'pasteLayers', comp, fragment: encodeFragmentLayers(layers), index: 0 } as Command));
    }

    const maxSize = 640;
    const grab = async (sec: number): Promise<Png> => {
      const t = unwrap(await client.query({ type: 'getThumbnail', item: comp, time: secondsToFlicks(sec), maxSize })) as { format: string; data: Uint8Array };
      return PNG.sync.read(Buffer.from(t.data));
    };

    // Contact sheet: 12 frames across the template.
    const n = 12;
    const frames: Png[] = [];
    for (let i = 0; i < n; i++) frames.push(await grab((s.durationSeconds * (i + 0.5)) / n));
    mkdirSync(path.join(pack.dir, 'review'), { recursive: true });
    writeFileSync(path.join(pack.dir, 'review', 'sheet.png'), PNG.sync.write(sheet(frames, 4)));

    // PREMATION_RENDER_FRAME=<sec>: one full-resolution frame, for detail review.
    if (process.env.PREMATION_RENDER_FRAME) {
      const sec = Number(process.env.PREMATION_RENDER_FRAME);
      const t1 = unwrap(await client.query({ type: 'getThumbnail', item: comp, time: secondsToFlicks(sec), maxSize: Math.max(s.width, s.height) })) as { data: Uint8Array };
      writeFileSync(path.join(pack.dir, 'review', `frame-${sec}.png`), Buffer.from(t1.data));
    }

    const ff = ffmpeg();
    if (!ff || process.env.PREMATION_RENDER_SHEET_ONLY) return;
    // Preview loop at 30 fps and the poster at the rest frame (meta.posterTime, else 70 %).
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'packrender-'));
    try {
      const fps = 30;
      const count = Math.round(s.durationSeconds * fps);
      for (let f = 0; f < count; f++) {
        writeFileSync(path.join(tmp, `f${String(f).padStart(5, '0')}.png`), PNG.sync.write(await grab(f / fps)));
      }
      execFileSync(ff, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(tmp, 'f%05d.png'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', '-movflags', '+faststart',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', path.join(pack.dir, 'preview.mp4')]);
      const posterSec = (pack.meta as PremiumMeta & { posterTime?: number }).posterTime ?? s.durationSeconds * 0.7;
      writeFileSync(path.join(tmp, 'poster.png'), PNG.sync.write(await grab(posterSec)));
      execFileSync(ff, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'poster.png'), '-quality', '86', path.join(pack.dir, 'poster.webp')]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
