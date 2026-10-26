/**
 * analyze_motion / render_motion_sheet / review_design's motion section,
 * through the same McpCallHost a connected client reaches, on the app's engine:
 * the numbers are what the frame shows, not what a layer's own x says.
 */

import type { Command } from '@motion/engine-api';
import { setupAppEngine, sec, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { activeCompRootId } from '@core/scene/activeComp';
import { documentMirror } from '@stores/documentMirror';
import { McpCallHost, type McpResult } from './mcpHost';
import { editorMcpDeps } from './mcpDefaults';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

let h: Harness;
let host: McpCallHost;
beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { frameRate: { num: 30, den: 1 }, duration: sec(4) } } as Command);
  await settleEdits();
  host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }) });
});
afterEach(async () => {
  await host.stop();
  await h.dispose();
});

const call = (name: string, args: unknown = {}): Promise<McpResult> => host.handle({ clientId: 1, name, args });
const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');

async function ok(name: string, args: unknown): Promise<void> {
  const r = await call(name, args);
  expect([name, r.isError, r.isError ? textOf(r).slice(0, 300) : '']).toEqual([name, undefined, '']);
}

async function twoCards(): Promise<void> {
  await ok('create_layer', { id: 'lin', kind: 'shape', shape: 'rect', name: 'Linear card', width: 200, height: 120, x: 400, y: 300, fill: '#ee5a2f' });
  await ok('create_layer', { id: 'eas', kind: 'shape', shape: 'rect', name: 'Eased card', width: 200, height: 120, x: 400, y: 700, fill: '#2ec4ff' });
  await ok('set_keyframes', {
    keyframes: [
      { nodeId: 'lin', prop: 'x', t: 0.5, value: 400, easing: 'linear' },
      { nodeId: 'lin', prop: 'x', t: 1.5, value: 1000 },
      { nodeId: 'eas', prop: 'x', t: 0.5, value: 400, easing: 'bezier', bezier: [0.16, 1, 0.3, 1] },
      { nodeId: 'eas', prop: 'x', t: 1.5, value: 1000 },
    ],
  });
  await settleEdits();
}

describe('analyze_motion', () => {
  it('measures each move frame by frame and tells a linear move from an eased one', async () => {
    await twoCards();
    const r = await call('analyze_motion', { startSec: 0, endSec: 2 });
    const t = textOf(r);
    expect(r.isError).toBeUndefined();
    expect(t).toMatch(/sampled every frame at 30 fps/);
    expect(t).toMatch(/0\.50s–1\.50s 30f 'Linear card' position 600px →, peak \d+px\/s @\d+%, linear/);
    expect(t).toMatch(/'Eased card' position 600px →, peak \d+px\/s @\d+%, ease-out/);
    expect(t).toMatch(/'Linear card' moves 600px at constant speed/);
    expect(t).not.toMatch(/'Eased card' moves 600px at constant speed/);
  });

  it('sees a child move when only its parent is animated', async () => {
    await ok('create_layer', { id: 'rig', kind: 'null', name: 'Rig', x: 960, y: 540 });
    await ok('create_layer', { id: 'kid', kind: 'shape', shape: 'ellipse', name: 'Passenger', width: 120, height: 120, x: 960, y: 540, fill: '#7cff6b', parent: 'rig' });
    await ok('set_keyframes', {
      keyframes: [
        { nodeId: 'rig', prop: 'y', t: 1, value: 540, easing: 'easeOut' },
        { nodeId: 'rig', prop: 'y', t: 2, value: 240 },
      ],
    });
    await settleEdits();
    const t = textOf(await call('analyze_motion', { startSec: 0, endSec: 3 }));
    expect(t).toMatch(/'Passenger' \(in 'Rig'\) position 300px ↑/);
  });

  it('refuses a window outside the composition and a layer it does not have', async () => {
    expect((await call('analyze_motion', { startSec: 3, endSec: 1 })).isError).toBe(true);
    const r = await call('analyze_motion', { nodeIds: ['nope'] });
    expect([r.isError, textOf(r)]).toEqual([true, expect.stringMatching(/No layer 'nope'/)]);
  });
});

describe('precomps', () => {
  const script = (push: boolean): Record<string, unknown> => ({
    title: 'Pre', intent: 'probe', durationSec: 4, background: '#101014',
    palette: { ink: '#f4efe6' }, grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 }, type: {}, globals: [],
    beats: [{
      name: 'Scene', purpose: '', startSec: 0, endSec: 4,
      layers: [{ id: 'card', kind: 'shape', shape: 'rect', name: 'Card', props: { x: 960, y: 540, width: 300, height: 200, fill: '$ink' } }],
      precompose: [{ id: 'rig', name: 'Scene comp', layers: ['card'], ...(push ? { keys: { x: [{ t: 1, v: 960, ease: 'easeInOut' }, { t: 2, v: 360 }] } } : {}) }],
    }],
  });

  it('measures what a precomp shows, on screen: its contents move when the precomp layer does', async () => {
    expect((await call('author_scene', { script: script(true) })).isError).toBeUndefined();
    await settleEdits();
    const t = textOf(await call('analyze_motion', { startSec: 0, endSec: 3 }));
    expect(t).toMatch(/'Card' \(in 'Scene comp'\) position 600px ←/);
  });

  it('a rebuilt beat leaves no orphan of its precomp composition behind', async () => {
    const comps = async (): Promise<number> => documentMirror().compIds.length;
    expect((await call('author_scene', { script: script(false) })).isError).toBeUndefined();
    await settleEdits();
    const once = await comps();
    expect((await call('author_scene', { script: script(false) })).isError).toBeUndefined();
    await settleEdits();
    expect(await comps()).toBe(once);
  });
});

describe('render_motion_sheet and review_design', () => {
  it('render_motion_sheet returns the window\'s measurements (frames are best-effort)', async () => {
    await twoCards();
    const t = textOf(await call('render_motion_sheet', { startSec: 0.4, endSec: 1.6 }));
    expect(t).toMatch(/Linear card/);
    expect(t).toMatch(/linear/);
  });

  it('review_design reports measured motion problems', async () => {
    await twoCards();
    const t = textOf(await call('review_design'));
    expect(t).toMatch(/Motion, measured on screen/);
    expect(t).toMatch(/'Linear card' moves 600px at constant speed/);
  });
});
