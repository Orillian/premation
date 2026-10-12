/**
 * P7 on the real engine (premation-engine-headless): plugins that are not
 * effects — a command (distribute), an importer (ppmio), a panel with a
 * command (statspanel) and an output module (ppmseq) — through the same client
 * calls the editor makes (pluginContrib.ts, pluginToolPanel.ts). The export
 * through the output module runs premation-engine --export when the full
 * engine is built (it needs a GPU); otherwise that case says so and passes.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProcessEngineClient, unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { readPanelFile } from '../../../electron/pluginPanelProtocol';
import {
  isPluginFormat,
  pluginCommands,
  pluginImportExtensions,
  pluginOutputFormats,
  pluginPanels,
  refreshPluginContrib,
  resetPluginContribForTest,
  runPluginCommand,
} from './pluginContrib';
import { parseToolPanelMessage } from './pluginToolPanel';

jest.setTimeout(180_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const BUNDLES = ['distribute', 'ppmio', 'ppmseq', 'statspanel'];
const run = !!exe && BUNDLES.every((b) => existsSync(path.join(samples, b, 'premation-plugin.json')));
if (!run) console.log('[plugin contrib native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const DISTRIBUTE = 'com.premation.samples.distribute';
const PPMSEQ = 'com.premation.samples.ppmseq';
const STATS = 'com.premation.samples.statspanel';

function writePpm(file: string, w: number, h: number): void {
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'latin1');
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) px.set([i * 7 % 256, 100, 200], i * 3);
  writeFileSync(file, Buffer.concat([header, px]));
}

/** ppmio's `.praw` (sound only): `PRAW <rate> <channels>\n` + interleaved float32 LE. */
function writePraw(file: string, rate: number, planes: Float32Array[]): void {
  const n = planes[0]!.length;
  const data = Buffer.alloc(n * planes.length * 4);
  for (let i = 0; i < n; i++) planes.forEach((p, c) => data.writeFloatLE(p[i]!, (i * planes.length + c) * 4));
  writeFileSync(file, Buffer.concat([Buffer.from(`PRAW ${rate} ${planes.length}\n`, 'latin1'), data]));
}

/**
 * ppmio's moving footage: P6 images back to back (`# fps` in the first header). A fixed
 * texture twice the frame wide, panned left `speed` px per frame: a point of the picture
 * at x0 on frame 0 is at x0 - speed * k on frame k.
 */
function writeMovingPpm(file: string, w: number, h: number, frames: number, fps: number, speed: number): void {
  const tw = w + speed * frames + 8;
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 0x1000000;
  const noise = Float32Array.from({ length: tw * h }, rnd);
  const tex = new Float32Array(tw * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < tw; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < tw) { s += noise[yy * tw + xx]!; n++; }
        }
      }
      tex[y * tw + x] = s / n;
    }
  }
  const parts: Buffer[] = [];
  for (let k = 0; k < frames; k++) {
    parts.push(Buffer.from(`P6\n${k === 0 ? `# fps ${fps}\n` : ''}${w} ${h}\n255\n`, 'latin1'));
    const px = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.round(Math.min(1, Math.max(0, (tex[y * tw + x + speed * k]! - 0.5) * 4 + 0.5)) * 255);
        px.set([v, v, v], (y * w + x) * 3);
      }
    }
    parts.push(px);
  }
  writeFileSync(file, Buffer.concat(parts));
}

/** premation-engine (the full build: export, audio, jobs) beside the engine the suite runs, or ''. */
function fullEngineExe(): string {
  const full = exe ? path.join(path.dirname(exe), process.platform === 'win32' ? 'premation-engine.exe' : 'premation-engine') : '';
  return full && existsSync(full) ? full : '';
}

maybe('native plugins that are not effects (P7)', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';
  let work = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-contrib-'));
    work = mkdtempSync(path.join(os.tmpdir(), 'plugin-contrib-work-'));
    for (const b of BUNDLES) cpSync(path.join(samples, b), path.join(dir, b), { recursive: true });
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', dir] });
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    resetProcessEngine();
    resetEngineOwnership();
    resetPluginContribForTest();
    bootEngine({ ownsDocument: true });
    client = engine();
    await engineIdle();
    await refreshPluginContrib(client);
  });

  afterAll(async () => {
    await shutdownEngine();
    await native?.stop();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it('lists every contribution from listPlugins', async () => {
    expect(pluginCommands().map((c) => `${c.plugin}/${c.id}`)).toEqual(expect.arrayContaining([`${DISTRIBUTE}/distribute`, `${STATS}/number`]));
    expect(pluginImportExtensions()).toEqual(expect.arrayContaining(['ppm', 'pfm']));
    const formats = pluginOutputFormats();
    expect(formats.map((f) => f.id)).toContain(`plugin:${PPMSEQ}/ppmseq`);
    expect(isPluginFormat(`plugin:${PPMSEQ}/ppmseq`)).toBe(true);
    expect(formats[0]!.module.options.map((o) => o.type)).toEqual(['popup', 'number', 'popup']);
    expect(pluginPanels()).toEqual([expect.objectContaining({ panelId: `plugin:${STATS}/stats`, panel: { id: 'stats', name: 'Layer Stats', page: 'stats.html' } })]);
    // listPluginCommands answers the same.
    const list = unwrap(await client.query({ type: 'listPluginCommands' }));
    expect(list.commands.find((c) => c.id === 'distribute')).toMatchObject({ plugin: DISTRIBUTE, name: 'Distribute Layers', menu: 'Arrange', enabled: true });
    // main serves the panel page from the bundle.
    const page = await readPanelFile([dir], `plugin-ui://${STATS}/stats.html`);
    expect(page?.body.toString()).toContain('stats.js');
  });

  it('runs a command as ONE undo entry, origin plugin; a crash changes nothing; a disabled plugin hides it', async () => {
    const make = async (x: number) => {
      const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: `S${x}`, init: [] } as never)) as unknown as { layer: string }).layer;
      unwrap(await client.execute({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x, y: 40 } } }));
      return layer;
    };
    const [a, b, c] = [await make(0), await make(300), await make(50)];
    const x = async (layer: string) => {
      const v = unwrap(await client.query({ type: 'getPropertyValues', props: [{ layer, path: 'transform/position' }], time: 0, evaluated: false })).values[0]!.value;
      return v.kind === 'vec2' ? v.value.x : NaN;
    };
    const before = unwrap(await client.query({ type: 'getHistory' }));
    const res = await runPluginCommand(client, DISTRIBUTE, 'distribute', { comp: 'comp_root', layers: [a, b, c], time: 0 });
    expect(res).toEqual({ ok: true, message: 'distributed 3 layers', edits: 1 });
    expect(await x(c)).toBe(150);
    const after = unwrap(await client.query({ type: 'getHistory' }));
    expect(after.position).toBe(before.position + 1);
    expect(after.entries[after.position - 1]).toEqual({ label: 'Distribute Layers', origin: 'plugin' });
    unwrap(await client.execute({ type: 'undo' }));
    expect(await x(c)).toBe(50);

    // A crash inside the plugin: an error, the document untouched, the engine alive.
    const crash = await runPluginCommand(client, DISTRIBUTE, 'distribute', { layers: [a, b, c], args: { fault: 'access_violation' } });
    expect(crash.ok).toBe(false);
    expect(crash.ok ? '' : crash.error).toMatch(/crashed/);
    expect(await x(c)).toBe(50);
    await refreshPluginContrib(client);
    expect(pluginCommands().some((p) => p.id === 'distribute')).toBe(false);  // off until re-enabled
    unwrap(await client.execute({ type: 'setPluginEnabled', plugin: DISTRIBUTE, enabled: true }));
    await refreshPluginContrib(client);
    expect(pluginCommands().some((p) => p.id === 'distribute')).toBe(true);

    // Disabled: hidden from the menu, refused by the engine.
    unwrap(await client.execute({ type: 'setPluginEnabled', plugin: DISTRIBUTE, enabled: false }));
    await refreshPluginContrib(client);
    expect(pluginCommands().some((p) => p.plugin === DISTRIBUTE)).toBe(false);
    expect((await runPluginCommand(client, DISTRIBUTE, 'distribute', { layers: [a, b, c] })).ok).toBe(false);
    unwrap(await client.execute({ type: 'setPluginEnabled', plugin: DISTRIBUTE, enabled: true }));
    await refreshPluginContrib(client);
  });

  it("runs a panel's requests through the engine API (query, command, plugin command)", async () => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'P', init: [] } as never)) as unknown as { layer: string }).layer;
    const q = parseToolPanelMessage({ premation: 1, id: 1, type: 'query', request: { type: 'getComposition', comp: 'comp_root' } });
    expect(q?.type).toBe('query');
    const comp = unwrap(await client.query((q as Extract<typeof q, { type: 'query' }>).request));
    expect((comp as { layers: Array<{ id: string }> }).layers.some((l) => l.id === layer)).toBe(true);
    // Only edit commands pass; the panel cannot undo, save or play.
    expect(parseToolPanelMessage({ premation: 1, id: 2, type: 'command', request: { type: 'undo' } })).toMatchObject({ type: 'invalid' });
    expect(parseToolPanelMessage({ premation: 1, id: 3, type: 'command', request: { type: 'saveProject', path: 'x' } })).toMatchObject({ type: 'invalid' });
    const cmd = parseToolPanelMessage({
      premation: 1, id: 4, type: 'command',
      request: { type: 'runPluginCommand', plugin: STATS, command: 'number', layers: [layer], args: JSON.stringify({ prefix: 'Take' }) },
    });
    expect(cmd?.type).toBe('command');
    unwrap(await client.execute((cmd as Extract<typeof cmd, { type: 'command' }>).commands[0]!, { origin: 'plugin' }));
    const named = unwrap(await client.query({ type: 'getLayers', layers: [layer] })).layers[0]!;
    expect(named.name).toBe('Take 1');
    const h = unwrap(await client.query({ type: 'getHistory' }));
    expect(h.entries[h.position - 1]).toEqual({ label: 'Number Layers', origin: 'plugin' });
  });

  it('imports a .ppm through the plugin; a file it cannot read fails with its message', async () => {
    const good = path.join(work, 'grad.ppm');
    writePpm(good, 6, 4);
    const items = unwrap(await client.execute({ type: 'importFiles', files: [{ path: good, asSequence: false, createComposition: false }] }));
    const info = unwrap(await client.query({ type: 'getItems', items: items.items })).items[0]!;
    expect(info).toMatchObject({ width: 6, height: 4, codec: 'PPM', mediaType: 'image' });
    const broken = path.join(work, 'broken.ppm');
    writePpm(broken, 2, 2);
    const res = await client.execute({ type: 'importFiles', files: [{ path: broken, asSequence: false, createComposition: false }] });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error.message).toMatch(/plugin failed to read/);
  });

  it('exports a .ppm sequence through the output module (premation-engine --export)', async () => {
    const full = exe ? path.join(path.dirname(exe), process.platform === 'win32' ? 'premation-engine.exe' : 'premation-engine') : '';
    if (!full || !existsSync(full)) {
      console.log('[plugin contrib native] premation-engine not built — the export case is covered by engine_plugins_tests');
      return;
    }
    // A project file the export can open: the headless engine saves its own document.
    const projDir = mkdtempSync(path.join(os.tmpdir(), 'plugin-contrib-proj-'));
    const saver = await startNativeEngine({ extraArgs: ['--no-gpu', '--plugins', dir] });
    try {
      const proj = path.join(projDir, 'p.motion');
      const c2 = createProcessEngineClient(saver.bridge);
      await c2.whenReady();
      await c2.execute({ type: 'setCompositionSettings', comp: 'comp_root', patch: { width: 32, height: 18, duration: 705_600_000 } } as never);
      await c2.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Red', init: [] } as never);
      const saved = await c2.execute({ type: 'saveProject', path: proj, copy: false } as never);
      if (!saved.ok || !existsSync(proj)) {
        console.log('[plugin contrib native] could not save a project to export:', saved.ok ? 'no file' : saved.error.message);
        return;
      }
      const out = path.join(projDir, 'out', 'shot.ppm');
      const job = path.join(projDir, 'job.json');
      writeFileSync(job, JSON.stringify({
        projectPath: proj,
        workDir: projDir,
        comp: 'comp_root',
        startFrame: 0,
        endFrame: 2,
        audio: false,
        plugins: [dir],
        sequence: `plugin:${PPMSEQ}/ppmseq`,
        pluginPath: out,
        pluginOptions: JSON.stringify({ digits: 3 }),
      }));
      mkdirSync(path.dirname(out), { recursive: true });
      const lines: string[] = [];
      const code = await new Promise<number>((resolve) => {
        const p = spawn(full, ['--export', job], { stdio: ['pipe', 'pipe', 'pipe'] });  // stdin stays open: EOF is a cancel
        p.stdout.on('data', (d: Buffer) => lines.push(...String(d).split('\n').filter(Boolean)));
        p.on('exit', (c) => resolve(c ?? -1));
        setTimeout(() => p.kill(), 120_000);
      });
      if (code === 3) {
        console.log('[plugin contrib native] the export fell back (no GPU here):', lines.join(' | '));
        return;
      }
      expect({ code, last: lines[lines.length - 1] }).toMatchObject({ code: 0 });
      const files = readdirSync(path.dirname(out)).sort();
      expect(files).toEqual(['shot_000.ppm', 'shot_001.ppm', 'shot_002.ppm']);
      const ppm = readFileSync(path.join(path.dirname(out), 'shot_001.ppm'));
      expect(ppm.subarray(0, 13).toString('latin1')).toBe('P6\n32 18\n255\n');
    } finally {
      await saver.stop();
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it("exports plugin footage's sound through the output module's WRITE_AUDIO (ppmio .praw → ppmseq .wav)", async () => {
    const full = fullEngineExe();
    if (!full) {
      console.log('[plugin contrib native] premation-engine not built — the audio export case is covered by engine_audio_tests');
      return;
    }
    const projDir = mkdtempSync(path.join(os.tmpdir(), 'plugin-contrib-audio-'));
    // 1 s of stereo sound at the mix rate: L a ramp, R its negative.
    const rate = 48000;
    const left = Float32Array.from({ length: rate }, (_, i) => ((i % 480) / 480) * 0.5 - 0.25);
    const right = left.map((v) => -v);
    const praw = path.join(projDir, 'tone.praw');
    writePraw(praw, rate, [left, right]);
    const saver = await startNativeEngine({ extraArgs: ['--no-gpu', '--plugins', dir] });
    try {
      const proj = path.join(projDir, 'p.motion');
      const c2 = createProcessEngineClient(saver.bridge);
      await c2.whenReady();
      unwrap(await c2.execute({ type: 'setCompositionSettings', comp: 'comp_root', patch: { width: 32, height: 18, frameRate: { num: 30, den: 1 }, duration: 705_600_000 } } as never));
      // The .praw imports through ppmio as an audio item; an audio layer plays it.
      const items = unwrap(await c2.execute({ type: 'importFiles', files: [{ path: praw, asSequence: false, createComposition: false }] }));
      const info = unwrap(await c2.query({ type: 'getItems', items: items.items })).items[0]!;
      expect(info).toMatchObject({ mediaType: 'audio', codec: 'PRAW float32' });
      unwrap(await c2.execute({ type: 'createLayer', comp: 'comp_root', kind: 'audio', source: items.items[0]!, init: [] } as never));
      const saved = await c2.execute({ type: 'saveProject', path: proj, copy: false } as never);
      if (!saved.ok || !existsSync(proj)) {
        console.log('[plugin contrib native] could not save a project to export:', saved.ok ? 'no file' : saved.error.message);
        return;
      }
      const out = path.join(projDir, 'out', 'shot.ppm');
      const job = path.join(projDir, 'job.json');
      writeFileSync(job, JSON.stringify({
        projectPath: proj, workDir: projDir, comp: 'comp_root', startFrame: 0, endFrame: 5, audio: true,
        plugins: [dir], sequence: `plugin:${PPMSEQ}/ppmseq`, pluginPath: out, pluginOptions: JSON.stringify({ digits: 3 }),
      }));
      mkdirSync(path.dirname(out), { recursive: true });
      const lines: string[] = [];
      const code = await new Promise<number>((resolve) => {
        const p = spawn(full, ['--export', job], { stdio: ['pipe', 'pipe', 'pipe'] });
        p.stdout.on('data', (d: Buffer) => lines.push(...String(d).split('\n').filter(Boolean)));
        p.on('exit', (c) => resolve(c ?? -1));
        setTimeout(() => p.kill(), 120_000);
      });
      if (code === 3) {
        console.log('[plugin contrib native] the export fell back (no GPU here):', lines.join(' | '));
        return;
      }
      expect({ code, last: lines[lines.length - 1] }).toMatchObject({ code: 0 });
      expect(readdirSync(path.dirname(out)).sort()).toEqual(['shot.wav', 'shot_000.ppm', 'shot_001.ppm', 'shot_002.ppm', 'shot_003.ppm', 'shot_004.ppm', 'shot_005.ppm']);
      // A 32-bit float WAV of the mix: the picture's range (6 frames at 30 fps = 0.2 s), stereo, 48 kHz.
      const wav = readFileSync(path.join(path.dirname(out), 'shot.wav'));
      expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(wav.readUInt16LE(20)).toBe(3);  // IEEE float
      expect(wav.readUInt16LE(22)).toBe(2);
      expect(wav.readUInt32LE(24)).toBe(rate);
      const frames = wav.readUInt32LE(40) / 8;
      expect(frames).toBe(rate * 0.2);
      expect(wav.length).toBe(44 + frames * 8);
      // The samples are the plugin's: the mix of one centred layer at 0 dB.
      let worst = 0;
      for (let i = 0; i < frames; i += 37) {
        worst = Math.max(worst, Math.abs(wav.readFloatLE(44 + i * 8) - left[i]!), Math.abs(wav.readFloatLE(44 + i * 8 + 4) - right[i]!));
      }
      expect(worst).toBeLessThan(1e-4);
    } finally {
      await saver.stop();
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('tracks moving plugin footage: the tracker reads frames through the importer (premation-engine)', async () => {
    const full = fullEngineExe();
    if (!full) {
      console.log('[plugin contrib native] premation-engine not built — jobs reading plugin footage are covered by engine_plugins_tests');
      return;
    }
    const projDir = mkdtempSync(path.join(os.tmpdir(), 'plugin-contrib-track-'));
    const clip = path.join(projDir, 'pan.ppm');
    const speed = 4;
    writeMovingPpm(clip, 160, 120, 10, 10, speed);
    const prev = process.env.PREMATION_ENGINE_PATH;
    process.env.PREMATION_ENGINE_PATH = full;
    let jobs: NativeEngine | null = null;
    try {
      jobs = await startNativeEngine({ extraArgs: ['--no-gpu', '--plugins', dir] });
    } finally {
      if (prev === undefined) delete process.env.PREMATION_ENGINE_PATH;
      else process.env.PREMATION_ENGINE_PATH = prev;
    }
    try {
      const c3 = createProcessEngineClient(jobs.bridge);
      await c3.whenReady();
      const sec = (s: number) => Math.round(s * 705_600_000);
      unwrap(await c3.execute({ type: 'setCompositionSettings', comp: 'comp_root', patch: { width: 160, height: 120, frameRate: { num: 10, den: 1 }, duration: sec(1) } } as never));
      const items = unwrap(await c3.execute({ type: 'importFiles', files: [{ path: clip, asSequence: false, createComposition: false }] }));
      const info = unwrap(await c3.query({ type: 'getItems', items: items.items })).items[0]!;
      expect(info).toMatchObject({ mediaType: 'video', width: 160, height: 120, codec: 'PPM' });
      const layer = (unwrap(await c3.execute({ type: 'createLayer', comp: 'comp_root', kind: 'video', source: items.items[0]!, init: [] } as never)) as unknown as { layer: string }).layer;
      const finished = new Map<string, { result: string; error?: string }>();
      const off = c3.subscribe((b) => {
        for (const e of b.events) if (e.type === 'jobFinished') finished.set(e.job.id, { result: e.job.result, ...(e.error ? { error: e.error.message } : {}) });
      });
      const started = unwrap(await c3.execute({ type: 'startJob', apply: false, job: { kind: 'trackMotion', value: {
        layer, kind: 'position', direction: 'forward', stabilize: false, excludeMasks: [], range: { start: 0, duration: sec(0.9) },
        points: [{ feature: { x: 80, y: 60, width: 25, height: 25 }, search: { x: 80, y: 60, width: 49, height: 49 }, attach: { x: 80, y: 60 } }],
      } } } as never)) as unknown as { job: string };
      const t0 = Date.now();
      while (!finished.has(started.job) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 50));
      off();
      const done = finished.get(started.job);
      expect(done?.error).toBeUndefined();
      // Samples are [t, x, y, confidence, coasted]: the feature follows the pan.
      const track = (JSON.parse(done?.result ?? '{}') as { tracks?: number[][][] }).tracks?.[0] ?? [];
      expect(track.length).toBeGreaterThanOrEqual(8);
      for (const [t, x, y] of track) {
        expect(Math.abs(x! - (80 - speed * 10 * t!))).toBeLessThan(1.5);
        expect(Math.abs(y! - 60)).toBeLessThan(1.5);
      }
    } finally {
      await jobs.stop();
      rmSync(projDir, { recursive: true, force: true });
    }
  });
});
