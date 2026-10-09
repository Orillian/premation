/**
 * A 3D motion-design comp on the GPU engine — what the owner's "very strong 3D
 * video with too many effects" was: a moving camera, a key and a fill light
 * with shadows, 16 extruded 3D titles at depth, glows and a grain pass. Plays
 * two seconds UNCACHED (frame cache off), then a looping pass with the cache
 * on, and prints per frame: the core-thread build (cpuFrameMs), the render
 * thread's time per frame, fps and drops. The numbers the program's P-phase
 * work is measured against (docs/PROGRAM_PLAYBACK_TEXT_INK.md).
 *
 * Run with the bench jest config (`npm run bench`) — the default suite ignores
 * `*.bench.test.ts`. Needs the full engine (GPU).
 */

import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { onSharedEngineFrames, openMainViewport, sec, settleEdits, setupAppEngine, type Harness } from '../__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '../__testHelpers__/nativeEngine';

// hrtime / performance / Date real: the bench measures wall time (fake timers would freeze them at 0).
jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate', 'hrtime', 'performance', 'Date'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], q: number): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]! : 0);

describe('heavy 3D comp', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('plays two seconds and reports the engine cost per frame', async () => {
    if (nativeEngineIsHeadless()) return;
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, duration: sec(4) } } as Command);
    const calls: { name: string; args: Record<string, unknown> }[] = [
      { name: 'create_gradient', args: { id: 'bg', name: 'BG', stops: ['#0b0d14', '#1b1530'], kind: 'radial' } },
      { name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Cam' } },
      { name: 'create_layer', args: { id: 'key', kind: 'light', name: 'Key' } },
      { name: 'create_layer', args: { id: 'fill', kind: 'light', name: 'Fill' } },
    ];
    for (let i = 0; i < 16; i++) {
      const id = `t${i}`;
      calls.push({ name: 'create_layer', args: { id, kind: 'text', name: `Title ${i}`, text: `PREMATION ${i}`, x: 300 + (i % 4) * 440, y: 220 + Math.floor(i / 4) * 220 } });
      calls.push({ name: 'update_layer', args: { nodeId: id, fontSize: 96, fill: '#e8e2ff', threeD: true, z: -200 * (i % 5), rotationY: (i % 7) * 9 } });
      calls.push({ name: 'add_effect', args: { nodeId: id, type: 'glow', params: { radius: 30 } } });
      calls.push({ name: 'set_keyframes', args: { keyframes: [
        { nodeId: id, prop: 'rotationY', t: 0, value: (i % 7) * 9 }, { nodeId: id, prop: 'rotationY', t: 4, value: (i % 7) * 9 + 90 },
      ] } });
    }
    calls.push({ name: 'set_keyframes', args: { keyframes: [{ nodeId: 'cam', prop: 'z', t: 0, value: -1800 }, { nodeId: 'cam', prop: 'z', t: 4, value: -900 }] } });
    calls.push({ name: 'add_surface_treatment', args: { grain: 4, vignette: 6 } });
    const r = await runToolTurn('bench: heavy 3d', calls);
    const failed = r.results.filter((x) => !x.ok).map((x) => x.content);
    if (failed.length) console.log('[heavy3d] tool failures', failed.slice(0, 5));
    // Extrusion: the text layers' depth (catalog path found on the layer, if the engine has one).
    const m = documentMirror();
    for (const id of m.layerIds()) {
      if (!(m.layer(id)?.name ?? '').startsWith('Title')) continue;
      await m.loadTree(id);
      const path = [...(m.tree(id)?.nodes.keys() ?? [])].find((p) => /extrusionDepth$/i.test(p));
      if (path) await h.run({ type: 'setProperty', prop: { layer: id, path }, value: { kind: 'scalar', value: 40 } } as Command);
    }
    await settleEdits();
    await openMainViewport(h.client);

    const frames: { ms: number; dropped: number; at: number }[] = [];
    let phase = 'idle';
    const off = onSharedEngineFrames((f) => {
      if (f.type === 'frameReady' && phase === 'playing') frames.push({ ms: (f.renderDoneUs - f.renderStartUs) / 1000, dropped: f.dropped, at: Number(process.hrtime.bigint() / 1000000n) });
    });
    let cpu = 0;
    const unsub = h.client.subscribe((b) => {
      for (const e of b.events) {
        if (e.type === 'renderStatsUpdated') cpu = e.stats.cpuFrameMs;
        if (e.type === 'transportChanged') phase = e.state;
      }
    });
    const pass = async (label: string): Promise<void> => {
      frames.length = 0;
      await h.run({ type: 'setLoop', mode: 'once' } as Command);
      await h.run({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: sec(2) }, audio: false, cacheFirst: false, cacheOnly: false } as Command);
      const until = Date.now() + 30_000;
      // P4's measure: a cheap query's round trip while frames build — how long
      // the core thread keeps a UI request waiting during heavy playback.
      const ui: number[] = [];
      await sleep(200);
      while (phase !== 'stopped' && Date.now() < until) {
        const q0 = process.hrtime.bigint();
        await h.query({ type: 'getHistory' });
        ui.push(Number(process.hrtime.bigint() - q0) / 1e6);
        await sleep(20);
      }
      const ms = frames.map((f) => f.ms);
      const dropped = frames.reduce((n, f) => n + f.dropped, 0);
      const span = frames.length > 1 ? (frames[frames.length - 1]!.at - frames[0]!.at) / 1000 : 1;
      console.log(`[heavy3d] ${JSON.stringify({ pass: label, frames: frames.length, dropped, renderP50Ms: Number(pct(ms, 0.5).toFixed(2)), renderP95Ms: Number(pct(ms, 0.95).toFixed(2)), worstMs: Number(Math.max(0, ...ms).toFixed(1)), cpuFrameMs: Number(cpu.toFixed(2)), fps: Number((frames.length / span).toFixed(1)), uiP50Ms: Number(pct(ui, 0.5).toFixed(2)), uiP95Ms: Number(pct(ui, 0.95).toFixed(2)), uiWorstMs: Number(Math.max(0, ...ui).toFixed(1)) })}`);
    };
    await pass('first');
    await pass('second');
    off();
    unsub();
    expect(frames.length).toBeGreaterThan(0);
  }, 180_000);
});
