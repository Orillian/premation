/**
 * Plugin SDK 1.2 on premation-engine-headless:
 *
 *   - presets (S7): a bundle's presets (manifest `presets` and `presets/*.json`)
 *     are listed on `listPlugins`, their values checked against the effect's
 *     params; applying one is ONE addEffect — one undo entry;
 *   - layer time (S3): a plugin's `current_time` is the LAYER's time. The
 *     `particles` sample's Reseed From Playhead button writes the playhead's
 *     frame in the layer's own time into Random Seed, so sliding or stretching
 *     the layer changes what it writes.
 *
 * Needs the SDK sample bundles the engine build lays out next to it; skipped
 * when they are absent.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { applyPluginPresetCommand, pluginPresetsFor, refreshPluginPresets } from './pluginPresets';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'particles', 'presets'));
if (!run) console.log('[plugin presets native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const PARTICLES = 'com.premation.samples.particles';
const SEC = 705_600_000;

maybe('plugin SDK 1.2, engine side', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-sdk12-'));
    cpSync(path.join(samples, 'particles'), path.join(dir, 'plugins', 'particles'), { recursive: true });
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', path.join(dir, 'plugins')] });
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    resetProcessEngine();
    resetEngineOwnership();
    bootEngine({ ownsDocument: true });
    client = engine();
    await engineIdle();
  });

  afterAll(async () => {
    shutdownEngine();
    await native?.stop();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    rmSync(dir, { recursive: true, force: true });
  });

  const solid = async (name: string): Promise<string> =>
    (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] } as never)) as unknown as { layer: string }).layer;
  const value = async (layer: string, p: string) => {
    const r = await client.query({ type: 'getPropertyValues', props: [{ layer, path: p }], time: 0, evaluated: false });
    return r.ok ? r.value.values[0]!.value : null;
  };

  it('lists the presets a plugin ships, with values checked against its params', async () => {
    const list = unwrap(await client.query({ type: 'listPlugins' })).plugins;
    const particles = list.find((p) => p.id === PARTICLES);
    expect(particles?.status).toBe('loaded');
    expect(particles!.presets.map((p) => [p.name, p.category])).toEqual([
      ['Warm Fountain', 'Fountains'],
      ['Slow Snow', 'Ambient'],
      ['Comet Trails', 'Trails'], // presets/comet-trails.json
    ]);
    const warm = particles!.presets[0]!;
    expect(warm.effect).toBe(PARTICLES);
    expect(warm.values.find((v) => v.path === 'p2')?.value).toEqual({ kind: 'scalar', value: 600 });
    expect(warm.values.find((v) => v.path === 'p8')?.value.kind).toBe('color');

    await refreshPluginPresets(client);
    expect(pluginPresetsFor(PARTICLES).map((p) => p.name)).toEqual(['Warm Fountain', 'Slow Snow', 'Comet Trails']);
  });

  it('applying a preset is one addEffect with its values: one undo entry', async () => {
    const layer = await solid('Fountain');
    await refreshPluginPresets(client);
    const warm = pluginPresetsFor(PARTICLES).find((p) => p.name === 'Warm Fountain')!;
    const fx = (unwrap(await client.execute(applyPluginPresetCommand(warm, [layer]))) as unknown as { groups: string[] }).groups[0]!;
    expect(fx).toMatch(/^effects\//);
    expect(await value(layer, `${fx}/p2`)).toEqual({ kind: 'scalar', value: 600 });
    expect(await value(layer, `${fx}/p3`)).toEqual({ kind: 'scalar', value: 320 });
    const color = await value(layer, `${fx}/p8`);
    expect(color?.kind).toBe('color');
    // A param the preset leaves alone keeps its default.
    expect(await value(layer, `${fx}/p6`)).toEqual({ kind: 'scalar', value: 6 });

    unwrap(await client.execute({ type: 'undo' }));
    expect(await value(layer, `${fx}/p2`)).toBeNull(); // the effect is gone, values and all, in one step
    unwrap(await client.execute({ type: 'redo' }));
    expect(await value(layer, `${fx}/p2`)).toEqual({ kind: 'scalar', value: 600 });
  });

  it("a plugin sees its layer's own time, not the comp's", async () => {
    const layer = await solid('Clock');
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: PARTICLES, params: [] })).groups[0]!;
    const reseed = async (): Promise<unknown> => {
      unwrap(await client.execute({ type: 'invokeEffectAction', group: { layer, path: fx }, action: 'p12' }));
      return (await value(layer, `${fx}/p9`)) as unknown;
    };
    unwrap(await client.execute({ type: 'seek', time: 2 * SEC, mode: 'exact' }));
    // The layer starts with the comp: layer time 2 s = frame 60 → seed 61.
    expect(await reseed()).toEqual({ kind: 'scalar', value: 61 });
    // Slid to start at 0.5 s: at comp 2 s the layer is 1.5 s (frame 45) into its own time.
    unwrap(await client.execute({ type: 'setLayerTiming', items: [{ layer, startTime: SEC / 2 }] }));
    expect(await reseed()).toEqual({ kind: 'scalar', value: 46 });
  });
});
