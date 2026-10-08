/**
 * Claude's calls on the real engine (docs/MCP_PLAN.md D4): the undo contract an
 * MCP client gets, through the same registry, transaction and context the
 * in-app assistant uses.
 */

import { AUTHOR_EXEMPLARS } from '@motion/author';
import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { McpCallHost, type McpResult } from './mcpHost';
import { editorMcpDeps } from './mcpDefaults';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
let host: McpCallHost;
beforeEach(async () => {
  h = await setupAppEngine();
  // The plan gate has its own test (mcpAccess.test.ts); here every call is allowed.
  host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }) });
});
afterEach(async () => {
  await host.stop();
  await h.dispose();
});

const call = (name: string, args: unknown = {}): Promise<McpResult> => host.handle({ clientId: 1, name, args });
const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
const layerNames = (): string[] => {
  const m = documentMirror();
  return m.layerIds().map((id) => m.layer(id)?.name ?? '');
};

describe('Claude calls on the engine', () => {
  it('makes a changing call outside a group its own undo step, labelled for Claude', async () => {
    const before = await h.doc();
    const r = await call('create_layer', { id: 'box', kind: 'null', name: 'Box' });
    expect(r.isError).toBeUndefined();
    expect(layerNames()).toContain('Box');
    expect(await historyLabels()).toEqual(['Claude: create layer']);
    await h.run({ type: 'undo' });
    expect(await h.doc()).toBe(before);
  });

  it('groups every call between begin_edit and end_edit into ONE undo step', async () => {
    const before = await h.doc();
    await call('begin_edit', { label: 'logo reveal' });
    await call('create_layer', { id: 'a', kind: 'null', name: 'A', x: 10 });
    await call('create_layer', { id: 'b', kind: 'null', name: 'B' });
    await call('set_keyframes', { keyframes: [{ nodeId: 'a', prop: 'x', t: 0, value: 10 }, { nodeId: 'a', prop: 'x', t: 1, value: 300 }] });
    const end = await call('end_edit', {});
    expect(textOf(end)).toMatch(/one undo step/);
    expect(await historyLabels()).toEqual(['Claude: logo reveal']);
    await h.run({ type: 'undo' });
    expect(await h.doc()).toBe(before);
  });

  it('throws a whole group away on end_edit commit:false', async () => {
    const before = await h.doc();
    await call('begin_edit', { label: 'try something' });
    await call('create_layer', { id: 'x', kind: 'null', name: 'Scratch' });
    expect(layerNames()).toContain('Scratch');
    await call('end_edit', { commit: false });
    expect(await h.doc()).toBe(before);
    expect(await historyLabels()).toEqual([]);
  });

  it('commits an open group when the user starts editing', async () => {
    await call('begin_edit', { label: 'claude part' });
    await call('create_layer', { id: 'c', kind: 'null', name: 'C' });
    await host.userActivity();
    expect(await historyLabels()).toEqual(['Claude: claude part']);
    expect(host.getActivity().group).toBeNull();
  });

  it('rolls a failing changing call back and says why', async () => {
    const before = await h.doc();
    const r = await call('update_layer', { nodeId: 'no_such_layer', x: 5 });
    expect(r.isError).toBe(true);
    expect(textOf(r).length).toBeGreaterThan(0);
    expect(await h.doc()).toBe(before);
    expect(await historyLabels()).toEqual([]);
  });

  it('refuses a tool that is not offered to Claude', async () => {
    const r = await call('export_video', {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/does not offer/);
  });

  it('reads without making history', async () => {
    await call('create_layer', { id: 'r', kind: 'null', name: 'Readable' });
    const r = await call('describe_scene', {});
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toMatch(/Readable/);
    expect(await historyLabels()).toEqual(['Claude: create layer']);
  });

  it('builds a scene script as one undo step', async () => {
    const before = await h.doc();
    const r = await call('author_scene', { script: AUTHOR_EXEMPLARS[0]!.script });
    expect(textOf(r)).toMatch(/^Built /);
    expect(r.isError).toBeUndefined();
    expect(layerNames().length).toBeGreaterThan(1);
    expect(await historyLabels()).toEqual(['Claude: build scene']);
    await h.run({ type: 'undo' });
    expect(await h.doc()).toBe(before);
  });
});
