/**
 * What the Cache & Memory panel reads from the engine (`getRenderStats`):
 * the cache tiers' budgets, the engine's own memory and the machine's, and
 * idle render-ahead switched through `setCacheBudget`.
 *
 * Runs on whichever engine the suites run. The cache tiers live in the
 * render thread, which the headless engine does not have (its sink takes
 * `setCacheBudget` and drops it), so the budget figures are checked on the
 * full engine only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, unwrap } from '@motion/engine-api';
import { nativeEngineExe, nativeEngineIsHeadless, startNativeEngine } from './__testHelpers__/nativeEngine';

const suite = nativeEngineExe() ? describe : describe.skip;

suite('engine memory stats', () => {
  it('reports budgets, process and machine memory, and the render-ahead switch', async () => {
    const native = await startNativeEngine({ extraArgs: ['--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'premation-memstats-'));
    try {
      await client.execute({ type: 'newProject' });

      const before = unwrap(await client.query({ type: 'getRenderStats' }));
      expect(before.engineMemoryBytes).toBeGreaterThan(1024 * 1024);
      expect(before.physicalMemoryBytes).toBeGreaterThan(before.engineMemoryBytes!);
      expect(before.availableMemoryBytes).toBeGreaterThan(0);
      expect(before.idleRenderAhead).toBe(true);
      // Before any frame the RAM tier reports the budget it is about to take.
      if (!nativeEngineIsHeadless()) expect(before.ramCacheBudget).toBeGreaterThan(0);

      unwrap(await client.execute({ type: 'setCacheBudget', ramMegabytes: 768, diskMegabytes: 2048, diskPath: dir, idleRenderAhead: false }));
      const after = unwrap(await client.query({ type: 'getRenderStats' }));
      expect(after.idleRenderAhead).toBe(false);
      if (!nativeEngineIsHeadless()) {
        expect(after.ramCacheBudget).toBe(768 * 1024 * 1024);
        expect(after.diskCacheBudget).toBe(2048 * 1024 * 1024);
      }

      // Absent = leave it: a budget change alone does not turn render-ahead back on.
      unwrap(await client.execute({ type: 'setCacheBudget', ramMegabytes: 0, diskMegabytes: 0, diskPath: '' }));
      const off = unwrap(await client.query({ type: 'getRenderStats' }));
      expect(off.idleRenderAhead).toBe(false);
      if (!nativeEngineIsHeadless()) expect(off.diskCacheBudget).toBe(0);
    } finally {
      await native.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
