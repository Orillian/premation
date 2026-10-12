/**
 * Plugin viewer overlays on premation-engine-headless (plugin SDK 1.1, plan P5):
 * the `rings` sample's overlay (three ring outlines and a centre handle)
 * arrives with the frame under the `plugin` overlay kind; dragging the handle
 * through `dragEffectOverlay` inside one gesture moves Center and is ONE undo
 * entry; undo puts it back. SDK 1.2: the `model3d` sample draws its handle in
 * COMPOSITION px, projected through the comp camera at the viewer's time, and a
 * comp-space drag moves the model in the camera's view plane — under the default
 * view and under a camera layer.
 *
 * Needs the SDK sample bundles the engine build lays out next to it; skipped
 * when they are absent.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient, type OverlayPluginItem } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { forwardFrames, openMainViewport, waitForFrame } from '@core/engine/__testHelpers__/appEngine';
import { MAIN_VIEWPORT, overlayLayer, requestOverlayLayers } from '@stores/overlayGeometry';
import { dragCommand, DRAG_BEGIN, DRAG_END, DRAG_MOVE, OVERLAY_SPACE_COMP } from './pluginOverlay';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'rings', 'premation-plugin.json'));
if (!run) console.log('[plugin overlay native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const RINGS = 'com.premation.samples.rings';
const MODEL3D = 'com.premation.samples.model3d';

maybe('plugin viewer overlays, engine side', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-overlay-'));
    cpSync(path.join(samples, 'rings'), path.join(dir, 'rings'), { recursive: true });
    cpSync(path.join(samples, 'model3d'), path.join(dir, 'model3d'), { recursive: true });
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', dir] });
    forwardFrames(native);
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    resetProcessEngine();
    resetEngineOwnership();
    bootEngine({ ownsDocument: true });
    client = engine();
    await engineIdle();
    await openMainViewport(client);
  });

  afterAll(async () => {
    requestOverlayLayers(MAIN_VIEWPORT, 'test', [], []);
    shutdownEngine();
    await native?.stop();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    rmSync(dir, { recursive: true, force: true });
  });

  const handleOf = (layer: string): OverlayPluginItem | undefined =>
    overlayLayer(MAIN_VIEWPORT, layer, 0)?.plugin.find((i) => i.kind === 'handle');

  it('draws, drags as one undo entry, and undoes', async () => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'R', init: [] } as never)) as unknown as { layer: string }).layer;
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: RINGS, params: [] })).groups[0]!;
    requestOverlayLayers(MAIN_VIEWPORT, 'test', [layer], ['plugin', 'transform']);
    await waitForFrame(5000);

    const items = overlayLayer(MAIN_VIEWPORT, layer, 0)?.plugin ?? [];
    expect(items.filter((i) => i.kind === 'path')).toHaveLength(3);
    const before = handleOf(layer);
    expect(before).toMatchObject({ kind: 'handle', effect: fx, handle: 1, shape: 2 });
    for (const i of items) expect(i.effect).toBe(fx);

    const start = { x: before!.points[0]!, y: before!.points[1]! };
    const target = { x: start.x + 30, y: start.y + 20 };
    const g = unwrap(await client.execute({ type: 'beginGesture', label: 'Drag Effect Handle' })).gesture;
    unwrap(await client.execute(dragCommand(layer, fx, 1, start, start, DRAG_BEGIN)));
    unwrap(await client.execute(dragCommand(layer, fx, 1, { x: start.x + 10, y: start.y + 5 }, start, DRAG_MOVE)));
    unwrap(await client.execute(dragCommand(layer, fx, 1, target, start, DRAG_END)));
    unwrap(await client.execute({ type: 'endGesture', gesture: g, commit: true }));
    await waitForFrame(5000);
    const moved = handleOf(layer)!;
    expect(moved.points[0]).toBeCloseTo(target.x, 6);
    expect(moved.points[1]).toBeCloseTo(target.y, 6);

    unwrap(await client.execute({ type: 'undo' }));
    await waitForFrame(5000);
    const back = handleOf(layer)!;
    expect(back.points[0]).toBeCloseTo(start.x, 6);
    expect(back.points[1]).toBeCloseTo(start.y, 6);
  });

  it('SDK 1.2: model3d draws its handle in comp px through the camera; a comp-space drag lands the model under the pointer', async () => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'M', init: [] } as never)) as unknown as { layer: string }).layer;
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: MODEL3D, params: [] })).groups[0]!;
    requestOverlayLayers(MAIN_VIEWPORT, 'test', [layer], ['plugin', 'transform']);
    await waitForFrame(5000);
    const handle = (): OverlayPluginItem => {
      const h = overlayLayer(MAIN_VIEWPORT, layer, 0)?.plugin.find((i) => i.kind === 'handle' && i.effect === fx);
      expect(h).toBeDefined();
      return h!;
    };
    const zOf = async (): Promise<number> => {
      const v = unwrap(await client.query({ type: 'getPropertyValues', props: [{ layer, path: `${fx}/p2Z` }], time: 0, evaluated: false } as never)) as unknown as {
        values: Array<{ value: { value: number } }>;
      };
      return v.values[0]!.value.value;
    };
    const drag = async (target: { x: number; y: number }): Promise<void> => {
      const start = { x: handle().points[0]!, y: handle().points[1]! };
      const g = unwrap(await client.execute({ type: 'beginGesture', label: 'Drag Effect Handle' })).gesture;
      unwrap(await client.execute(dragCommand(layer, fx, 1, start, start, DRAG_BEGIN, OVERLAY_SPACE_COMP)));
      unwrap(await client.execute(dragCommand(layer, fx, 1, target, start, DRAG_MOVE, OVERLAY_SPACE_COMP)));
      unwrap(await client.execute(dragCommand(layer, fx, 1, target, start, DRAG_END, OVERLAY_SPACE_COMP)));
      unwrap(await client.execute({ type: 'endGesture', gesture: g, commit: true }));
      await waitForFrame(5000);
    };

    // The default view: the model at Position (the layer's centre, z 0) projects onto itself.
    const first = handle();
    expect(first.space).toBe(OVERLAY_SPACE_COMP);
    for (const i of overlayLayer(MAIN_VIEWPORT, layer, 0)!.plugin.filter((p) => p.effect === fx)) expect(i.space).toBe(OVERLAY_SPACE_COMP);
    const z0 = await zOf();
    await drag({ x: first.points[0]! + 40, y: first.points[1]! - 25 });
    expect(handle().points[0]).toBeCloseTo(first.points[0]! + 40, 3);
    expect(handle().points[1]).toBeCloseTo(first.points[1]! - 25, 3);
    expect(await zOf()).toBeCloseTo(z0, 6);  // the default camera's view plane is z = const

    // A camera layer looking from elsewhere: the handle follows the camera, and a drag still lands under the pointer.
    const before = handle();
    const cam = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Cam', init: [] } as never)) as unknown as { layer: string }).layer;
    unwrap(await client.execute({ type: 'setProperty', prop: { layer: cam, path: 'transform/position' }, value: { kind: 'vec3', value: { x: 700, y: 300, z: -900 } } } as never));
    await waitForFrame(5000);
    const seen = handle();
    expect(Math.hypot(seen.points[0]! - before.points[0]!, seen.points[1]! - before.points[1]!)).toBeGreaterThan(5);
    const target = { x: seen.points[0]! - 30, y: seen.points[1]! + 15 };
    await drag(target);
    expect(handle().points[0]).toBeCloseTo(target.x, 3);
    expect(handle().points[1]).toBeCloseTo(target.y, 3);

    // Undo puts the model back where the camera saw it.
    unwrap(await client.execute({ type: 'undo' }));
    await waitForFrame(5000);
    expect(handle().points[0]).toBeCloseTo(seen.points[0]!, 3);
    expect(handle().points[1]).toBeCloseTo(seen.points[1]!, 3);
  });

  it('refuses a drag on an effect that draws no overlay', async () => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'B', init: [] } as never)) as unknown as { layer: string }).layer;
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: 'gaussian-blur', params: [] })).groups[0]!;
    const r = await client.execute(dragCommand(layer, fx, 1, { x: 0, y: 0 }, { x: 0, y: 0 }, DRAG_MOVE));
    expect(r.ok).toBe(false);
  });
});
