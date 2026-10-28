/**
 * A native plugin effect's Effect Controls card, as AE draws a plugin, on
 * premation-engine-headless with the SDK samples:
 *
 *   - `listEffects` says where each button sits (its group and the param it
 *     was declared before), each group's GROUP_START key and whether it is
 *     START_COLLAPSED, and that a CANNOT_ANIMATE param is not animatable —
 *     the engine refuses its stopwatch too;
 *   - the card's layout (pluginCardLayout) from that and `getEffectUi`: the
 *     button inline where `rings` declared it, its hidden buttons not drawn,
 *     the shared Debug group twirled up;
 *   - Apply Preset onto an effect already in the stack: the preset's values,
 *     every other param back to its default, ONE undo entry.
 *
 * Needs the SDK sample bundles the engine build lays out next to it; skipped
 * when they are absent.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { effectInfoToDef, refreshPluginEffectDefs } from '@core/inspector/pluginEffectDefs';
import { pluginCardSections } from '@core/inspector/pluginCardLayout';
import { pluginPresetsFor } from '@core/nativePlugins/pluginPresets';
import { documentMirror } from '@stores/documentMirror';
import { applyPresetToEffectEdit } from './effectEdits';
import { EffectStack } from './EffectStack';
import { TooltipProvider } from '@components/Tooltip';
import { resetPluginContribForTest, setPluginContrib } from '@core/nativePlugins/pluginContrib';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'rings')) && existsSync(path.join(samples, 'particles', 'presets'));
if (!run) console.log('[plugin card native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const RINGS = 'com.premation.samples.rings';
const PARTICLES = 'com.premation.samples.particles';

maybe('a plugin effect card, engine side', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-card-'));
    for (const b of ['rings', 'particles']) cpSync(path.join(samples, b), path.join(dir, 'plugins', b), { recursive: true });
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', path.join(dir, 'plugins')] });
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    resetProcessEngine();
    resetEngineOwnership();
    bootEngine({ ownsDocument: true });
    client = engine();
    await engineIdle();
    await refreshPluginEffectDefs(client);
  });

  afterAll(async () => {
    shutdownEngine();
    await native?.stop();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    rmSync(dir, { recursive: true, force: true });
  });

  const solid = async (name: string): Promise<string> =>
    (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] } as never)) as unknown as { layer: string }).layer;
  const ringsInfo = async () => unwrap(await client.query({ type: 'listEffects', category: '' })).effects.find((e) => e.matchName === RINGS)!;

  it('lists where each button sits, the groups, and what cannot animate', async () => {
    const info = await ringsInfo();
    expect(info.params.map((p) => p.matchName)).toEqual(['p1X', 'p1Y', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p901']);
    // Declared after Opacity (p7), before the Debug group: top level, at 8.
    expect(info.actions).toEqual([
      { key: 'p8', label: 'Shuffle Palette', group: '', at: 8 },
      { key: 'p9', label: 'Set Palette', group: '', at: 8 },
      { key: 'p10', label: 'Swap Colors', group: '', at: 8 },
    ]);
    expect(info.groups).toMatchObject([{ name: 'Debug', key: 'p900', collapsed: true }]);
    expect(info.params.find((p) => p.matchName === 'p901')?.animatable).toBe(false); // the samples' Fault: CANNOT_ANIMATE
    expect(info.params.find((p) => p.matchName === 'p2')?.animatable).toBe(true);
  });

  it('lists the descriptions, the About text, the icon and the panel title', async () => {
    const info = await ringsInfo();
    expect(info.params.find((p) => p.matchName === 'p901')?.description).toMatch(/^Makes this effect fail/);
    expect(info.params.find((p) => p.matchName === 'p2')?.description).toBeUndefined();
    expect(info.groups[0]?.description).toMatch(/^Host crash-isolation tests/);
    expect(info.about).toMatch(/^Rings 1\.1/);
    const rings = unwrap(await client.query({ type: 'listPlugins' })).plugins.find((p) => p.id === RINGS)!;
    expect(rings.icon).toBe('ui/icon.svg');
    expect(rings.panelTitle).toBe('Palette');
    expect(unwrap(await client.query({ type: 'listPlugins' })).plugins.find((p) => p.id === PARTICLES)?.icon).toBeUndefined();
  });

  it('refuses a stopwatch on a CANNOT_ANIMATE param', async () => {
    const layer = await solid('R');
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: RINGS, params: [] })).groups[0]!;
    const fault = await client.execute({ type: 'setAnimated', prop: { layer, path: `${fx}/p901` }, animated: true, time: 0 });
    expect(fault.ok).toBe(false);
    if (!fault.ok) expect(fault.error.code).toBe('notAnimatable');
    const spacing = await client.execute({ type: 'setAnimated', prop: { layer, path: `${fx}/p2` }, animated: true, time: 0 });
    expect(spacing.ok).toBe(true);
  });

  it('lays the card out in the plugin order: the button inline, hidden buttons gone, Debug twirled up', async () => {
    const layer = await solid('Card');
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: RINGS, params: [] })).groups[0]!;
    const ui = unwrap(await client.query({ type: 'getEffectUi', layer, effect: fx, time: 0 }));
    const sections = pluginCardSections(effectInfoToDef(await ringsInfo()), new Map(ui.params.map((p) => [p.key, p])));
    const keys = (s: (typeof sections)[number]) => s.items.map((it) => (it.kind === 'param' ? it.param.key : `[${it.label}]`));
    expect(sections.map((s) => [s.group ?? '', s.collapsed])).toEqual([['', false], ['Debug', true]]);
    // SDK 1.3: the Palette box, declared after Opacity and before Shuffle Palette.
    expect(keys(sections[0]!)).toEqual(['p1X', 'p1Y', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', '[Palette]', '[Shuffle Palette]']);
    expect(keys(sections[1]!)).toEqual(['p901']);
  });

  it('draws it so in Effect Controls', async () => {
    const layer = await solid('Drawn');
    unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: RINGS, params: [] }));
    const m = documentMirror().start();
    await m.loadTree(layer);
    const release = m.retainTree(layer);
    await m.whenIdle();
    setPluginContrib(unwrap(await client.query({ type: 'listPlugins' })).plugins);
    try {
      await act(async () => {
        render(<TooltipProvider><EffectStack nodeId={layer} /></TooltipProvider>);
        await engineIdle();
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); // getEffectUi's answer
      const shuffle = screen.getByRole('button', { name: 'Shuffle Palette' });
      const debug = screen.getByRole('button', { name: 'Debug' });
      // The button on its own row where rings declared it: after Opacity, before the Debug group.
      expect(debug.compareDocumentPosition(shuffle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      expect(screen.getByText('Opacity').compareDocumentPosition(shuffle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Set Palette' })).toBeNull(); // HIDDEN: only the panel presses it
      expect(debug.getAttribute('aria-expanded')).toBe('false'); // START_COLLAPSED
      expect(debug.hasAttribute('data-state')).toBe(true); // the group's description: a tooltip trigger
      // The header: the bundle's icon, its panel button under the manifest's title, About.
      const icon = document.querySelector('img[src^="plugin-ui://"]');
      expect(icon?.getAttribute('src')).toBe('plugin-ui://com.premation.samples.rings/icon.svg');
      expect(screen.getByRole('button', { name: 'Palette' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Open Panel…' })).toBeNull(); // the header's button replaces it
      act(() => { screen.getByRole('button', { name: 'About Rings' }).click(); });
      expect(screen.getByRole('note').textContent).toMatch(/Rings 1\.1/);
      // Debug open: the Fault popup's label is a focusable tooltip trigger.
      act(() => { debug.click(); });
      const faultLabel = screen.getByText('Fault');
      expect(faultLabel.getAttribute('tabindex')).toBe('0');
    } finally {
      cleanup();
      release();
      resetPluginContribForTest();
    }
  });

  it('applies a preset onto an effect already in the stack as ONE undo entry', async () => {
    const layer = await solid('P');
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: PARTICLES, params: [] })).groups[0]!;
    const effectId = fx.split('/')[1]!;
    const read = async (key: string) => unwrap(await client.query({
      type: 'getPropertyValues', props: [{ layer, path: `${fx}/${key}` }], time: 0, evaluated: false,
    })).values[0]!.value;
    const p5Default = await read('p5');
    unwrap(await client.execute({ type: 'setProperty', prop: { layer, path: `${fx}/p2` }, value: { kind: 'scalar', value: 50 } }));
    unwrap(await client.execute({ type: 'setProperty', prop: { layer, path: `${fx}/p5` }, value: { kind: 'scalar', value: 77 } }));
    const m = documentMirror().start();
    await m.loadTree(layer);
    const release = m.retainTree(layer);
    await engineIdle();

    const warm = pluginPresetsFor(PARTICLES).find((p) => p.name === 'Warm Fountain')!;
    const before = unwrap(await client.query({ type: 'getHistory' }));
    await applyPresetToEffectEdit(layer, effectId, warm, 'Particles');
    const after = unwrap(await client.query({ type: 'getHistory' }));
    release();

    expect(await read('p2')).toEqual({ kind: 'scalar', value: 600 }); // the preset's
    expect(await read('p5')).toEqual(p5Default); // not in the preset: back to its default
    expect(after.position - before.position).toBe(1);
    expect(after.entries[after.position - 1]?.label).toBe('Particles: Warm Fountain');
  });
});
