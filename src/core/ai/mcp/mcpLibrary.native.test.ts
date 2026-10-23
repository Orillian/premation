/**
 * search_library / preview_library / insert_library_item through the
 * McpCallHost a connected client reaches, on the app's engine.
 */

import { flicksToSeconds, type Command } from '@motion/engine-api';
import { setupAppEngine, sec, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { activeCompRootId } from '@core/scene/activeComp';
import { LOTTIE_ITEMS } from '@core/library/lottieLibrary';
import { UI_COMPONENTS } from '@core/library/uiKitLibrary';
import { CURSOR_ITEMS } from '@core/library/cursorLibrary';
import { MOGRAPH_ITEMS } from '@core/library/mographLibrary';
import { TRANSITION_ITEMS } from '@core/library/transitionLibrary';
import { TEMPLATES } from '@core/template/registry';
import { documentMirror } from '@stores/documentMirror';
import { McpCallHost, type McpResult } from './mcpHost';
import { editorMcpDeps } from './mcpDefaults';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

let h: Harness;
let host: McpCallHost;
beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { frameRate: { num: 30, den: 1 }, duration: sec(6) } } as Command);
  await settleEdits();
  host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }) });
});
afterEach(async () => {
  await host.stop();
  await h.dispose();
});

const call = (name: string, args: unknown = {}): Promise<McpResult> => host.handle({ clientId: 1, name, args });
const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
const layerCount = (): number => documentMirror().comp(activeCompRootId() as string)?.layers.length ?? 0;

describe('search_library', () => {
  it('finds items across shelves by words, and filters by kind', async () => {
    const all = textOf(await call('search_library', { includePremium: false }));
    expect(all).toMatch(/library: template \d+, transition \d+, sfx \d+, lottie \d+, ui \d+, cursor \d+, mograph \d+, component \d+/);

    const cursors = textOf(await call('search_library', { query: 'cursor click', includePremium: false }));
    expect(cursors).toMatch(/^- cursor:/m);

    const ui = textOf(await call('search_library', { kind: 'ui', includePremium: false, limit: 80 }));
    const lines = ui.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.length).toBe(UI_COMPONENTS.length);
    expect(lines.every((l) => l.startsWith('- ui:'))).toBe(true);
  });

  it('says what the library has when nothing matches', async () => {
    expect(textOf(await call('search_library', { query: 'zzqqxx', includePremium: false }))).toMatch(/Nothing in the library matches/);
  });
});

describe('insert_library_item', () => {
  const cases: [string, string][] = [
    ['lottie', `lottie:${LOTTIE_ITEMS[0]!.id}`],
    ['ui', `ui:${UI_COMPONENTS[0]!.id}`],
    ['cursor', `cursor:${CURSOR_ITEMS[0]!.id}`],
    ['mograph', `mograph:${MOGRAPH_ITEMS.find((m) => !m.loop)!.id}`],
    ['transition', `transition:${TRANSITION_ITEMS[0]!.id}`],
  ];
  it.each(cases)('builds a %s item as real layers and reports their ids', async (_kind, id) => {
    const before = layerCount();
    const r = await call('insert_library_item', { id, x: 600, y: 400, atSec: 1 });
    expect([r.isError, textOf(r)]).toEqual([undefined, expect.stringMatching(/^Inserted .*layer\(s\); top level '/)]);
    await settleEdits();
    expect(layerCount()).toBeGreaterThan(before);
  });

  it('starts a Lottie\'s motion at atSec: its bars (and keys) move there', async () => {
    const before = new Set(documentMirror().comp(activeCompRootId() as string)?.layers ?? []);
    expect((await call('insert_library_item', { id: `lottie:${LOTTIE_ITEMS[0]!.id}`, atSec: 1.5 })).isError).toBeUndefined();
    await settleEdits();
    const m = documentMirror();
    const made = (m.comp(activeCompRootId() as string)?.layers ?? []).filter((id) => !before.has(id));
    expect(made.length).toBeGreaterThan(0);
    for (const id of made) expect(flicksToSeconds(m.layer(id)!.timing.inPoint)).toBeCloseTo(1.5, 2);
  });

  it('joins a begin_edit group: one undo step with the rest of the group', async () => {
    await call('begin_edit', { label: 'library' });
    const r = await call('insert_library_item', { id: `ui:${UI_COMPONENTS[0]!.id}`, as: 'btn' });
    expect(r.isError).toBeUndefined();
    const moved = await call('update_layer', { nodeId: 'btn', x: 300 });
    expect(moved.isError).toBeUndefined();
    expect(textOf(await call('end_edit'))).toMatch(/saved as one undo step/);
  });

  it('refuses a template without replaceComposition, and an unknown id', async () => {
    const t = await call('insert_library_item', { id: `template:${TEMPLATES[0]!.id}` });
    expect([t.isError, textOf(t)]).toEqual([true, expect.stringMatching(/REPLACES every layer/)]);
    const u = await call('insert_library_item', { id: 'lottie:nope' });
    expect([u.isError, textOf(u)]).toEqual([true, expect.stringMatching(/No library item 'lottie:nope'/)]);
  });
});

describe('preview_library', () => {
  it('builds, renders and removes: nothing stays in the composition', async () => {
    const before = layerCount();
    const r = await call('preview_library', { ids: [`mograph:${MOGRAPH_ITEMS[0]!.id}`, `ui:${UI_COMPONENTS[0]!.id}`, 'sfx:sfx-click'] });
    const t = textOf(r);
    expect(r.isError).toBeUndefined();
    expect(t).toMatch(/Previewed 3 item\(s\)/);
    expect(t).toMatch(/sfx:sfx-click .*described only/);
    await settleEdits();
    expect(layerCount()).toBe(before);
  });

  it('refuses inside a begin_edit group', async () => {
    await call('begin_edit', { label: 'x' });
    const r = await call('preview_library', { ids: [`ui:${UI_COMPONENTS[0]!.id}`] });
    expect([r.isError, textOf(r)]).toEqual([true, expect.stringMatching(/end_edit first/)]);
    await call('end_edit');
  });
});
