/**
 * Claude's front desk: works with no project open, creates/opens projects and
 * waits for the editor, hands project tools to the editor, and keeps the feed.
 */

import { McpFrontDesk, NO_PROJECT, summarise, type FrontDeskDeps } from './frontDesk';
import type { McpCallHost, McpResult } from './mcpHost';

const text = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');

function fakeEditor(answer = 'edited'): McpCallHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    handle: async (c: { name: string }) => { calls.push(c.name); return { content: [{ type: 'text', text: answer }] }; },
    subscribe: (fn: (a: { busy: boolean; tool: null; group: string | null }) => void) => { fn({ busy: false, tool: null, group: null }); return () => undefined; },
    clientsChanged: async () => undefined,
    stop: async () => undefined,
  } as unknown as McpCallHost & { calls: string[] };
}

function setup(over: Partial<FrontDeskDeps> = {}) {
  let loaded: string | null = null;
  const desk: McpFrontDesk = new McpFrontDesk({
    access: async () => ({ ok: true }),
    appState: async () => ({ screen: loaded ? 'editor' : 'home', project: loaded }),
    listProjects: async () => [{ id: 'p1', name: 'Launch' }],
    createProject: async (o) => { setTimeout(() => { loaded = 'new-1'; }, 0); return { name: o.name, expect: 'new-1' }; },
    openProject: async (id) => { setTimeout(() => { loaded = id; }, 0); return { name: 'Launch', expect: id }; },
    projectLoaded: (expect) => loaded !== null && (!expect || loaded === expect),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    ...over,
  });
  return { desk, call: (name: string, args: unknown = {}) => desk.handle({ clientId: 1, name, args }), setLoaded: (v: string | null) => { loaded = v; } };
}

describe('McpFrontDesk', () => {
  it('answers app state and lists projects with no project open', async () => {
    const { call } = setup();
    expect(text(await call('get_app_state'))).toMatch(/"screen": "home"/);
    expect(text(await call('list_projects'))).toMatch(/Launch/);
  });

  it('tells Claude what to call first when an editing tool arrives with no project', async () => {
    const { call } = setup();
    const r = await call('describe_scene');
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(NO_PROJECT);
  });

  it('creates a project, waits for the editor to load THAT one, then edits go to the editor', async () => {
    const { desk, call } = setup();
    const editor = fakeEditor();
    desk.registerEditor(editor);
    const created = await call('create_project', { name: 'Promo', width: 1080, height: 1920 });
    expect(created.isError).toBeUndefined();
    expect(text(created)).toMatch(/Created and opened "Promo": 1080×1920/);
    expect(text(await call('describe_scene'))).toBe('edited');
    expect(editor.calls).toEqual(['describe_scene']);
  });

  it('does not take an older open project for the one being opened', async () => {
    const { desk, call, setLoaded } = setup({
      openProject: async (id) => ({ name: 'Launch', expect: id }),
    });
    desk.registerEditor(fakeEditor());
    setLoaded('older');
    const r = await desk.waitForEditor(20, 'p1');
    expect(r).toBe(false);
    setLoaded('p1');
    expect(await desk.waitForEditor(20, 'p1')).toBe(true);
    void call;
  });

  it('refuses project tools when access is denied', async () => {
    const { call } = setup({ access: async () => ({ ok: false, message: 'Sign in' }) });
    expect(text(await call('create_project'))).toBe('Sign in');
  });

  it('keeps a newest-first feed with one line per call', async () => {
    const { desk, call } = setup();
    await call('get_app_state');
    await call('describe_scene');
    const feed = desk.getState().feed;
    expect(feed.map((e) => [e.tool, e.ok])).toEqual([['describe_scene', false], ['get_app_state', true]]);
    expect(feed[0]!.summary).toMatch(/No project is open/);
  });

  it('summarises renders and long answers for people', () => {
    expect(summarise('render_frame', { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toBe('Rendered a frame');
    expect(summarise('x', { content: [{ type: 'text', text: 'a'.repeat(200) }] }).length).toBe(138);
  });
});
