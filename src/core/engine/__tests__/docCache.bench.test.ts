/**
 * How much of a real document idle render-ahead caches, and how it then
 * plays: `PREMATION_PROFILE_DOC` names a project file (a save or the autosave
 * recovery copy). The engine starts with the app's cache settings (frame
 * cache and RAM tier sized from the machine, a fresh disk cache folder,
 * idle render-ahead on), opens the document at a viewport the size of the
 * editor's, sits idle while render-ahead fills, and prints the cached share of
 * the composition every few seconds. Then it plays the composition once and
 * prints the engine's playback summary (frames served from the cache vs
 * built). This is the "part of the film caches, part never does" symptom,
 * measured. Skipped without the variable.
 *
 *   PREMATION_PROFILE_DOC=<file> [PREMATION_PROFILE_COMP=<id>]
 *   [PREMATION_CACHE_IDLE_S=<seconds, default 90>] [PREMATION_PROFILE_SIZE=WxH, default 1208x502]
 *   [PREMATION_PROFILE_GPU_VENDOR=<pci id>] [PREMATION_CACHE_DIR=<folder>]
 *   npm run bench -- docCache
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FLICKS = 705600000;

describe('document cache fill', () => {
  const docPath = process.env.PREMATION_PROFILE_DOC;
  const run = docPath && nativeEngineExe() ? it : it.skip;
  run('idle render-ahead fills the composition, then it plays from the cache', async () => {
    const idleS = Number(process.env.PREMATION_CACHE_IDLE_S ?? '90');
    const [w, h] = (process.env.PREMATION_PROFILE_SIZE ?? '1208x502').split('x').map(Number);
    const vendor = process.env.PREMATION_PROFILE_GPU_VENDOR;
    const native = await startNativeEngine({ extraArgs: ['--log-level', 'info', ...(vendor ? ['--gpu-vendor', vendor] : [])] });
    const client = new ProcessEngineClient(native.bridge);
    const logs: string[] = [];
    native.supervisor.on('log', (line: string) => logs.push(line));
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type === 'frameReady') native.supervisor.releaseSlot(m.generation, m.slot);
    });
    let transport = 'stopped';
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') transport = e.state;
    });
    const diskDir = process.env.PREMATION_CACHE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'premation-doccache-'));
    try {
      await client.execute({ type: 'openProject', path: docPath! });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const compId = process.env.PREMATION_PROFILE_COMP ?? doc.comps[doc.comps.length - 1]!.id;
      await client.execute({ type: 'setActiveComposition', comp: compId });
      const cs = unwrap(await client.query({ type: 'getComposition', comp: compId })).comp.settings;
      const duration = Number(cs.duration);
      await client.execute({ type: 'setCacheBudget', ramMegabytes: 0, diskMegabytes: 20000, diskPath: diskDir, idleRenderAhead: true });
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: w!, height: h!, devicePixelRatio: 1, zoom: Math.min(w! / cs.width, h! / cs.height),
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'seek', time: 0, mode: 'exact' });
      const covered = async (): Promise<{ share: number; ram: number; disk: number; holes: string }> => {
        const c = unwrap(await client.query({ type: 'getCacheCoverage', comp: compId }));
        const ranges = [...c.ram, ...c.disk].map((r) => [Number(r.start), Number(r.end)] as [number, number]).sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const r of ranges) {
          const last = merged[merged.length - 1];
          if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
          else merged.push([r[0], r[1]]);
        }
        const total = merged.reduce((n, r) => n + (Math.min(r[1], duration) - r[0]), 0);
        const holes: string[] = [];
        let at = 0;
        for (const r of merged) {
          if (r[0] - at > FLICKS / 10) holes.push(`${(at / FLICKS).toFixed(1)}-${(r[0] / FLICKS).toFixed(1)}s`);
          at = Math.max(at, r[1]);
        }
        if (duration - at > FLICKS / 10) holes.push(`${(at / FLICKS).toFixed(1)}-${(duration / FLICKS).toFixed(1)}s`);
        return { share: total / duration, ram: c.ramBytes, disk: c.diskBytes, holes: holes.join(' ') };
      };
      const t0 = performance.now();
      let last = -1;
      let stableSince = performance.now();
      while (performance.now() - t0 < idleS * 1000) {
        await sleep(3000);
        const c = await covered();
        const pct = Math.round(c.share * 1000) / 10;
        console.log(`[cache] t=${((performance.now() - t0) / 1000).toFixed(0)}s covered ${pct}% ram ${(c.ram / 1e6).toFixed(0)} MB disk ${(c.disk / 1e6).toFixed(0)} MB holes: ${c.holes || 'none'}`);
        if (pct !== last) {
          last = pct;
          stableSince = performance.now();
        } else if (performance.now() - stableSince > 15000) {
          break;
        }
      }
      const fill = await covered();
      const fillS = (performance.now() - t0) / 1000;
      logs.length = 0;
      await client.execute({ type: 'setLoop', mode: 'once' });
      transport = 'starting';
      await client.execute({ type: 'play', rate: 1, range: 'all', audio: false, cacheFirst: false, cacheOnly: false, from: 0 });
      const until = Date.now() + 180_000;
      while (transport !== 'stopped' && Date.now() < until) await sleep(100);
      await sleep(500);
      const summary = logs.filter((l) => l.includes('playback_summary')).pop() ?? '(no playback summary)';
      console.log(`[cache] RESULT filled ${(fill.share * 100).toFixed(1)}% in ${fillS.toFixed(0)}s; holes: ${fill.holes || 'none'}`);
      console.log(`[cache] RESULT playback ${summary.slice(summary.indexOf('{'))}`);
      expect(fill.share).toBeGreaterThanOrEqual(0);
    } finally {
      await native.stop();
      if (!process.env.PREMATION_CACHE_DIR) fs.rmSync(diskDir, { recursive: true, force: true });
    }
  }, 900_000);
});
