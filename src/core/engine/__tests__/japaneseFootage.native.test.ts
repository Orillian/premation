/**
 * Footage named outside the ANSI code page, end to end (user report
 * 2026-10-23, Premation 1.0.2 on Japanese Windows): a project whose image
 * layers were `ダウンロード (14).png` / `(15).png` crash-looped the engine on
 * open, and its export failed. The engine read the document's UTF-8 paths in
 * the ANSI code page (932 there), which throws on those names.
 *
 * A project made and saved by the engine, holding Japanese-named stills, is
 * rendered by `premation-engine --export` (one PNG frame): it completes, and
 * no layer reports its footage missing.
 *
 * PREMATION_JA_FOOTAGE_DIR=<folder> renders that folder's .png / .mp4 / .wav files instead
 * (a user's own images). Needs the full engine and a GPU; skipped otherwise.
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
// Test-only reach into the Electron main sources: the launcher is plain Node.
import { startEngineExport, type EngineExportOutcome } from '../../../../electron/engineExport';

const exe = nativeEngineExe();
const headless = !!exe && /headless/i.test(path.basename(exe));
const maybe = exe && !headless ? describe : describe.skip;
if (!exe) console.log('[japaneseFootage] premation-engine is not built — skipped');
else if (headless) console.log('[japaneseFootage] premation-engine-headless has no export — skipped');

jest.setTimeout(120_000);

/** A 1×1 opaque red PNG. */
const RED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC', 'base64');

function unwrap<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as T;
}

maybe('Japanese-named footage (engine)', () => {
  let dir = '';

  afterAll(() => {
    // PREMATION_JA_KEEP=1 keeps the project (and its footage) for running other engines on it.
    if (dir && !process.env.PREMATION_JA_KEEP) rmSync(dir, { recursive: true, force: true });
    else if (dir) console.log(`[japaneseFootage] kept ${dir}`);
  });

  it('a project with ダウンロード (15).png, Korean, Chinese, Cyrillic, Arabic, Thai, Hindi and emoji-named layers renders', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'premation-ja-'));
    const from = process.env.PREMATION_JA_FOOTAGE_DIR;
    const files: string[] = [];
    if (from) {
      for (const f of readdirSync(from).filter((n) => /\.(png|mp4|wav)$/i.test(n))) {
        const to = path.join(dir, f);
        copyFileSync(path.join(from, f), to);
        files.push(to);
      }
    } else {
      // The user's name, and one per script a Windows code page cannot spell everywhere.
      for (const name of ['ダウンロード (15).png', '한국어 이미지.png', '中文图片.png', 'Русский файл.png', 'العربية.png', 'ภาษาไทย.png', 'हिन्दी.png', 'café naïve.png', 'emoji 🎬✨.png']) {
        const file = path.join(dir, name);
        writeFileSync(file, RED_PNG);
        files.push(file);
      }
    }
    expect(files.length).toBeGreaterThan(0);

    const projectPath = path.join(dir, 'プロジェクト.motion');
    const native = await startNativeEngine();
    try {
      const client = new ProcessEngineClient(native.bridge);
      await client.whenReady();
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp, patch: { name: 'Main', frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(1), width: 64, height: 36, background: { r: 0, g: 0, b: 1, a: 1 } } } as never);
      for (const file of files) {
        const item = unwrap(await client.execute({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] })).items[0]!;
        const kind = /\.mp4$/i.test(file) ? 'video' : /\.wav$/i.test(file) ? 'audio' : 'image';
        unwrap(await client.execute({ type: 'createLayer', comp, kind, source: item, init: [] } as never));
      }
      unwrap(await client.execute({ type: 'saveProject', path: projectPath, copy: false }));
    } finally {
      await native.stop();
    }

    const out = path.join(dir, 'frame.png');
    const run = startEngineExport('ja', { projectPath, outPath: out, format: 'png', comp: 'Main', quality: 'high' }, { progress: () => undefined }, {
      enginePath: exe,
      ffmpegPath: () => process.env.FFMPEG_PATH || 'ffmpeg',
      workDirFor: (id) => path.join(dir, id),
      log: () => undefined,
    });
    const outcome: EngineExportOutcome = await run.done;
    if (outcome.kind === 'fallback' && /GPU|adapter/i.test(outcome.reason)) {
      console.log(`[japaneseFootage] no GPU — skipped: ${outcome.reason}`);
      return;
    }
    expect(outcome).toMatchObject({ kind: 'completed' });
    expect(existsSync(out)).toBe(true);
    if (outcome.kind === 'completed') {
      // No layer reported missing footage: the stills were found by their Japanese names.
      expect((outcome.warnings ?? []).filter((w) => /did not decode|did not open|footage failed/i.test(w))).toEqual([]);
    }
  });
});
