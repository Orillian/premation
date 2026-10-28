/**
 * Per-frame cost of a real document on the GPU engine: `PREMATION_PROFILE_DOC`
 * names a project file (a save or the autosave recovery copy), the active
 * composition is stepped frame by frame with the frame cache off, and every
 * frame's wall time (seek → frameReady, build + draw), draw time and build
 * time are printed and written as JSON — to find the stretches of a film that
 * cannot play or cache in real time. Skipped without the variable.
 *
 *   PREMATION_PROFILE_DOC=<file> [PREMATION_PROFILE_COMP=<id>]
 *   [PREMATION_PROFILE_STEP=<frames>] [PREMATION_PROFILE_SIZE=WxH]
 *   [PREMATION_PROFILE_OUT=<json>] npm run bench -- docProfile
 */
import fs from 'node:fs';
import { ProcessEngineClient, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('document profile', () => {
  const docPath = process.env.PREMATION_PROFILE_DOC;
  const run = docPath && nativeEngineExe() ? it : it.skip;
  run('steps every frame of the document and reports the cost per frame', async () => {
    const step = Math.max(1, Number(process.env.PREMATION_PROFILE_STEP ?? '1'));
    const [w, h] = (process.env.PREMATION_PROFILE_SIZE ?? '1920x1080').split('x').map(Number);
    const vendor = process.env.PREMATION_PROFILE_GPU_VENDOR;
    const native = await startNativeEngine({
      extraArgs: ['--frame-cache-mb', '0', '--ram-cache-mb', '0', '--log-level', process.env.PREMATION_PROFILE_LOG ?? 'warn', ...(vendor ? ['--gpu-vendor', vendor] : [])],
    });
    const client = new ProcessEngineClient(native.bridge);
    let waiting: { frame: number; resolve: (m: Extract<EngineFrameMessage, { type: 'frameReady' }>) => void } | null = null;
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      if (waiting && m.frame === waiting.frame) {
        const r = waiting.resolve;
        waiting = null;
        r(m);
      }
    });
    const rows: { frame: number; t: number; wallMs: number; drawMs: number; buildMs: number }[] = [];
    try {
      await client.execute({ type: 'openProject', path: docPath! });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const compId = process.env.PREMATION_PROFILE_COMP ?? doc.comps[doc.comps.length - 1]!.id;
      await client.execute({ type: 'setActiveComposition', comp: compId });
      const cs = unwrap(await client.query({ type: 'getComposition', comp: compId })).comp.settings;
      const fps = cs.frameRate.num / cs.frameRate.den;
      const frames = Math.round((Number(cs.duration) / 705600000) * fps);
      console.log(`[profile] ${cs.name} ${cs.width}x${cs.height} ${fps} fps ${frames} frames, viewport ${w}x${h}, step ${step}`);
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: w!, height: h!, devicePixelRatio: 1, zoom: Math.min(w! / cs.width, h! / cs.height),
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setPreviewQuality', resolution: 'full', fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'full' });
      await sleep(500);
      const from = Number(process.env.PREMATION_PROFILE_FROM ?? '0');
      const to = Math.min(frames, Number(process.env.PREMATION_PROFILE_TO ?? String(frames)));
      for (let f = from; f < to; f += step) {
        const t0 = performance.now();
        const got = new Promise<Extract<EngineFrameMessage, { type: 'frameReady' }>>((resolve) => {
          waiting = { frame: f, resolve };
        });
        await client.execute({ type: 'seek', time: Math.round((f / fps) * 705600000), mode: 'exact' });
        const m = await Promise.race([got, sleep(180_000).then(() => null)]);
        const wallMs = performance.now() - t0;
        const stats = unwrap(await client.query({ type: 'getRenderStats' }));
        const row = {
          frame: f,
          t: Number((f / fps).toFixed(3)),
          wallMs: Number(wallMs.toFixed(1)),
          drawMs: m ? Number(((m.renderDoneUs - m.renderStartUs) / 1000).toFixed(1)) : -1,
          buildMs: Number(stats.cpuFrameMs.toFixed(1)),
        };
        rows.push(row);
        if (row.wallMs > 200 || f % (step * 20) === 0) console.log('[profile] ' + JSON.stringify(row));
        // One line per frame as it lands (JSON lines), so a run stopped early still reports.
        if (process.env.PREMATION_PROFILE_OUT) fs.appendFileSync(process.env.PREMATION_PROFILE_OUT, JSON.stringify(row) + '\n');
        if (!m) break;
      }
      const slow = [...rows].sort((a, b) => b.wallMs - a.wallMs).slice(0, 12);
      console.log('[profile] slowest: ' + JSON.stringify(slow));
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await native.stop();
    }
  }, 1_800_000);
});
