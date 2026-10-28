/**
 * Plugin SDK 1.3 custom UI boxes on premation-engine-headless: the `rings` sample
 * declares a Palette box (PR_PARAM_CUSTOM_UI); `listEffects` lists it with its
 * place and height, `drawEffectParamUi` answers what the plugin draws
 * (PR_CMD_DRAW_PARAM_UI: the palette as fills, a label, a track and a handle),
 * and dragging the handle through `dragEffectParamUi` inside one gesture moves
 * Spacing as ONE undo entry.
 *
 * Needs the SDK sample bundles the engine build lays out next to it; skipped
 * when they are absent.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient, type ParamUiItem } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { DRAG_BEGIN, DRAG_END, DRAG_MOVE, paramUiDragCommand } from './pluginParamUi';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'rings', 'premation-plugin.json'));
if (!run) console.log('[plugin custom UI native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const RINGS = 'com.premation.samples.rings';
const WIDTH = 300;
// rings.cpp: the track runs from kPad to width − kPad at y 50, Spacing 2..200.
const PAD = 10;
const trackX = (spacing: number): number => PAD + ((spacing - 2) / 198) * (WIDTH - 2 * PAD);

maybe('plugin custom UI boxes (SDK 1.3), engine side', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-param-ui-'));
    cpSync(path.join(samples, 'rings'), path.join(dir, 'rings'), { recursive: true });
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', dir] });
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

  const draw = async (layer: string, fx: string, key = 'p11'): Promise<ParamUiItem[]> =>
    unwrap(await client.query({ type: 'drawEffectParamUi', layer, effect: fx, key, width: WIDTH })).items;
  const handleX = (items: ParamUiItem[]): number => items.find((i) => i.kind === 'handle')!.points[0]!;
  const label = (items: ParamUiItem[]): string => items.find((i) => i.kind === 'text')!.text;

  it('lists the box where the plugin declared it', async () => {
    const info = unwrap(await client.query({ type: 'listEffects', category: '' })).effects.find((e) => e.matchName === RINGS)!;
    expect(info.customUis).toEqual([expect.objectContaining({ key: 'p11', label: 'Palette', group: '', height: 64 })]);
    // Declared after Opacity: Center X/Y, Spacing, Rotation, Mix, Color A, Color B, Opacity come before it.
    expect(info.customUis[0]!.at).toBe(info.params.findIndex((p) => p.matchName === 'p7') + 1);
  });

  it('draws the palette, the label, the track and the Spacing handle; drags as one undo entry', async () => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'R', init: [] } as never)) as unknown as { layer: string }).layer;
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: RINGS, params: [] })).groups[0]!;

    const items = await draw(layer, fx);
    expect(items.filter((i) => i.kind === 'fill')).toHaveLength(6); // the default palette's six colours
    expect(items.filter((i) => i.kind === 'fill').every((i) => i.color.length === 4)).toBe(true);
    expect(label(items)).toBe('Spacing 24 px');
    const track = items.find((i) => i.kind === 'line')!;
    expect(track.color).toEqual([]); // no colour: the editor's theme draws it
    expect(track.points).toEqual([PAD, 50, WIDTH - PAD, 50]);
    expect(handleX(items)).toBeCloseTo(trackX(24), 6);

    const effectId = fx.replace(/^effects\//, '');
    const start = { x: trackX(24), y: 50 };
    const to = { x: trackX(101), y: 50 };
    const g = unwrap(await client.execute({ type: 'beginGesture', label: 'Rings: Palette' })).gesture;
    unwrap(await client.execute(paramUiDragCommand(layer, effectId, 'p11', 1, start, start, DRAG_BEGIN, WIDTH)));
    unwrap(await client.execute(paramUiDragCommand(layer, effectId, 'p11', 1, { x: start.x + 20, y: 50 }, start, DRAG_MOVE, WIDTH)));
    unwrap(await client.execute(paramUiDragCommand(layer, effectId, 'p11', 1, to, start, DRAG_END, WIDTH)));
    unwrap(await client.execute({ type: 'endGesture', gesture: g, commit: true }));
    const moved = await draw(layer, fx);
    expect(label(moved)).toBe('Spacing 101 px');
    expect(handleX(moved)).toBeCloseTo(trackX(101), 6);

    unwrap(await client.execute({ type: 'undo' }));
    expect(label(await draw(layer, fx))).toBe('Spacing 24 px');
  });

  it('answers notFound for a box the effect does not have', async () => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as never)) as unknown as { layer: string }).layer;
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: RINGS, params: [] })).groups[0]!;
    const res = await client.query({ type: 'drawEffectParamUi', layer, effect: fx, key: 'p2', width: WIDTH });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('notFound');
  });
});
