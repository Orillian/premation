/**
 * A long-form project on the GPU engine: a 30-minute 30 fps 1080p comp with
 * 200 animated rectangles (position + rotation keys spread over the whole
 * half hour, a few effects) — the shape of a talking-head edit or a lecture
 * with graphics, where the frame count (54 000) rather than the layer count is
 * what the engine has to stay indifferent to. Printed, one `[long] {json}`
 * line each:
 *
 *   build       the commands that make the document (wall ms, layers, keys)
 *   firstFrame  setViewport → the first frameReady (open / build the first frame)
 *   seek        seek → frameReady at 0 s, 10 min and 29 min (build + draw each)
 *   keyIndex    whether the frame-key index (core/frame_keys.hpp, cached
 *               playback without a build) covers the comp: the engine's own
 *               `playback_summary` log line after a short play, with the
 *               edit → frameReady time as the fallback signal when the log
 *               does not say
 *   edit        one keyframe added on one layer at 15 min → the next
 *               frameReady of that frame (edit latency on a long comp)
 *
 * Recorded for the ratchet as `longTimeline/30min-200layers`.
 *
 *   PREMATION_BENCH_LAYERS=<n>     layer count (default 200)
 *   PREMATION_BENCH_MINUTES=<n>    comp length in minutes (default 30)
 *   PREMATION_BENCH_KEYS=<n>       keyframes per animated property per layer (default 31)
 *
 * Run with the bench jest config — the default suite ignores `*.bench.test.ts`.
 */
import { ProcessEngineClient, secondsToFlicks, unwrap, type KeyframeInsert } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { recordBench } from '../../perf/bench/benchRecord';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

type FrameReady = Extract<EngineFrameMessage, { type: 'frameReady' }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LAYERS = Number(process.env.PREMATION_BENCH_LAYERS ?? '200');
const MINUTES = Number(process.env.PREMATION_BENCH_MINUTES ?? '30');
const KEYS = Math.max(2, Number(process.env.PREMATION_BENCH_KEYS ?? '31'));
const FPS = 30;
const SCENARIO = `longTimeline/${MINUTES}min-${LAYERS}layers`;

describe('long timeline: a 30-minute comp with 200 animated layers', () => {
  it('builds the first frame, seeks across the half hour, and times one edit at 15 min', async () => {
    if (!nativeEngineExe()) {
      console.log('[long] premation-engine is not built');
      return;
    }
    // info: the engine's `playback_summary` line (frames / keyed / indexed) is what the keyIndex row reads.
    const native = await startNativeEngine({ extraArgs: ['--log-level', 'info'] });
    const client = new ProcessEngineClient(native.bridge);
    const summaries: Record<string, unknown>[] = [];
    native.supervisor.on('log', (line: string) => {
      if (!line.includes('"playback_summary"')) return;
      try {
        summaries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* not JSON: a plain stderr line */
      }
    });
    // Every frameReady is handed to whoever is waiting for one; the slot goes straight back.
    const waiters = new Set<(m: FrameReady) => void>();
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      for (const w of [...waiters]) w(m);
    });
    const nextFrame = (pred: (m: FrameReady) => boolean, timeoutMs = 120_000): Promise<FrameReady | null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(on);
          resolve(null);
        }, timeoutMs);
        const on = (m: FrameReady): void => {
          if (!pred(m)) return;
          clearTimeout(timer);
          waiters.delete(on);
          resolve(m);
        };
        waiters.add(on);
      });
    let phase = 'idle';
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    const metrics: Parameters<typeof recordBench>[0] = [];
    const metric = (name: string, unit: 'ms' | 'fps' | 'count', value: number, samples = 1): void => {
      metrics.push({ name: SCENARIO, metric: name, unit, value, samples });
    };
    const drawMs = (m: FrameReady | null): number => (m ? Number(((m.renderDoneUs - m.renderStartUs) / 1000).toFixed(2)) : -1);
    const frameAt = (seconds: number): number => Math.round(seconds * FPS);
    const flicksAt = (seconds: number): number => Math.round((frameAt(seconds) / FPS) * 705_600_000);
    try {
      // ── the document ────────────────────────────────────────────────────
      const duration = MINUTES * 60;
      const t0 = performance.now();
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({
        type: 'setCompositionSettings',
        comp,
        patch: { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(duration), width: 1920, height: 1080 },
      });
      await client.execute({ type: 'setActiveComposition', comp });
      const layers: string[] = [];
      let keys = 0;
      let createMs = 0;
      let keysMs = 0;
      let effectsMs = 0;
      for (let i = 0; i < LAYERS; i++) {
        const tc = performance.now();
        const x = 120 + (i % 10) * 180;
        const y = 160 + Math.floor(i / 10) * 40;
        const layer = unwrap(await client.execute({
          type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`,
          init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x, y } } }],
        })).layer;
        layers.push(layer);
        const tk = performance.now();
        createMs += tk - tc;
        // Keys spread over the whole duration: every layer animates from its first to its last minute.
        const inserts: KeyframeInsert[] = [];
        for (let k = 0; k < KEYS; k++) {
          const time = Math.round((k / (KEYS - 1)) * duration * 705_600_000);
          const swing = (k % 2 === 0 ? 1 : -1) * 90;
          inserts.push({ prop: { layer, path: 'transform/position' }, time, value: { kind: 'vec2', value: { x: x + swing, y: y + swing / 3 } }, spatialIn: [], spatialOut: [], easing: 'linear' });
          inserts.push({ prop: { layer, path: 'transform/rotation' }, time, value: { kind: 'scalar', value: k * 15 }, spatialIn: [], spatialOut: [], easing: 'linear' });
        }
        await client.execute({ type: 'addKeyframes', keys: inserts });
        keys += inserts.length;
        const tf = performance.now();
        keysMs += tf - tk;
        if (i % 20 === 0) await client.execute({ type: 'addEffect', layers: [layer], effect: 'drop-shadow', params: [] });
        else if (i % 20 === 10) await client.execute({ type: 'addEffect', layers: [layer], effect: 'gaussian-blur', params: [] });
        effectsMs += performance.now() - tf;
      }
      const buildMs = performance.now() - t0;
      console.log('[long] ' + JSON.stringify({
        step: 'build', wallMs: Number(buildMs.toFixed(0)), layers: LAYERS, keys, minutes: MINUTES,
        createLayersMs: Number(createMs.toFixed(0)), addKeyframesMs: Number(keysMs.toFixed(0)), addEffectsMs: Number(effectsMs.toFixed(0)),
      }));
      metric('build.wall', 'ms', Number(buildMs.toFixed(1)));

      // ── (a) the first frame ──────────────────────────────────────────────
      const firstGot = nextFrame(() => true);
      const t1 = performance.now();
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setPreviewQuality', resolution: 'full', fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'full' });
      const first = await firstGot;
      const firstMs = performance.now() - t1;
      const stats0 = unwrap(await client.query({ type: 'getRenderStats' }));
      console.log('[long] ' + JSON.stringify({ step: 'firstFrame', wallMs: Number(firstMs.toFixed(1)), drawMs: drawMs(first), buildMs: Number(stats0.cpuFrameMs.toFixed(1)), frame: first?.frame ?? -1 }));
      expect(first).not.toBeNull();
      metric('firstFrame.wall', 'ms', Number(firstMs.toFixed(1)));

      // ── (b) seeks across the timeline ─────────────────────────────────────
      // The first frame just drew at 0 s, so "0 s" seeks to the second frame
      // of the comp: a seek that has to build, like the other two.
      const points: { label: string; seconds: number }[] = [
        { label: '0s', seconds: 1 / FPS },
        { label: '10min', seconds: Math.min(duration - 1, 600) },
        { label: '29min', seconds: Math.max(0, duration - 60) },
      ];
      for (const p of points) {
        const frame = frameAt(p.seconds);
        const got = nextFrame((m) => m.frame === frame);
        const ts = performance.now();
        await client.execute({ type: 'seek', time: flicksAt(p.seconds), mode: 'exact' });
        const m = await got;
        const wallMs = performance.now() - ts;
        const stats = unwrap(await client.query({ type: 'getRenderStats' }));
        console.log('[long] ' + JSON.stringify({ step: 'seek', at: p.label, frame, wallMs: Number(wallMs.toFixed(1)), drawMs: drawMs(m), buildMs: Number(stats.cpuFrameMs.toFixed(1)) }));
        expect(m).not.toBeNull();
        metric(`seek.${p.label}.wall`, 'ms', Number(wallMs.toFixed(1)));
      }

      // ── (c) the frame-key index ──────────────────────────────────────────
      // A one-second play at 15 min; when it stops the engine logs
      // `playback_summary` with `indexed` (the comp's per-frame keys exist:
      // the layers' spans + the dense total within frame_keys.hpp's byte
      // budget, 1% of RAM in [32 MB, 512 MB]; `indexBytes` is their size) and
      // `keyed` (frames of this play that carried a pre-build key).
      const mid = Math.min(duration - 2, 900);
      summaries.length = 0;
      phase = 'starting';
      await client.execute({ type: 'setLoop', mode: 'once' });
      await client.execute({
        type: 'play', rate: 1, range: 'custom', custom: { start: flicksAt(mid), duration: secondsToFlicks(1) },
        audio: false, cacheFirst: false, cacheOnly: false,
      });
      const tp = performance.now();
      const until = Date.now() + 60_000;
      while (phase !== 'stopped' && Date.now() < until) await sleep(50);
      const playMs = performance.now() - tp;
      if (phase !== 'stopped') await client.execute({ type: 'pause', returnToStart: false });
      await sleep(300);
      const summary = summaries[summaries.length - 1];
      const indexed = summary ? summary.indexed === true || summary.indexed === 'true' : null;
      console.log('[long] ' + JSON.stringify({
        step: 'keyIndex',
        playMs: Number(playMs.toFixed(0)),
        playEnded: phase,
        indexed,
        frames: summary?.frames ?? null,
        keyed: summary?.keyed ?? null,
        servedWithoutBuild: summary?.servedWithoutBuild ?? null,
        volatile: summary?.volatile ?? null,
        cells: LAYERS * Math.round(duration * FPS),
        maxCells: 4 << 20,
        source: summary ? 'playback_summary' : 'none (see the edit row)',
      }));
      metric('keyIndex.active', 'count', indexed === null ? -1 : indexed ? 1 : 0, 0);

      // ── (d) edit latency at 15 min ────────────────────────────────────────
      // Playhead parked at 15 min (its frame drawn), then one keyframe added
      // on one layer there: the time until that frame is drawn again.
      const editFrame = frameAt(mid);
      const parked = nextFrame((m) => m.frame === editFrame);
      await client.execute({ type: 'seek', time: flicksAt(mid), mode: 'exact' });
      expect(await parked).not.toBeNull();
      await sleep(200);
      const layer = layers[Math.floor(LAYERS / 2)]!;
      const redrawn = nextFrame((m) => m.frame === editFrame);
      const te = performance.now();
      const res = await client.execute({
        type: 'addKeyframes',
        keys: [{ prop: { layer, path: 'transform/opacity' }, time: flicksAt(mid), value: { kind: 'scalar', value: 40 }, spatialIn: [], spatialOut: [], easing: 'linear' }],
      });
      unwrap(res);
      const commandMs = performance.now() - te;
      const m = await redrawn;
      const editMs = performance.now() - te;
      const stats = unwrap(await client.query({ type: 'getRenderStats' }));
      console.log('[long] ' + JSON.stringify({
        step: 'edit', at: '15min', frame: editFrame,
        commandMs: Number(commandMs.toFixed(1)), wallMs: Number(editMs.toFixed(1)), drawMs: drawMs(m), buildMs: Number(stats.cpuFrameMs.toFixed(1)),
        revisionShown: m?.revision ?? null, revisionWritten: res.revision,
      }));
      expect(m).not.toBeNull();
      metric('edit.command', 'ms', Number(commandMs.toFixed(1)));
      metric('edit.toFrame', 'ms', Number(editMs.toFixed(1)));
    } finally {
      await native.stop();
      if (metrics.length > 0) recordBench(metrics);
    }
  }, 300_000);
});
