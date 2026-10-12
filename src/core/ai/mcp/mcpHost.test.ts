/**
 * McpCallHost with stand-in deps: the plan gate, render results as MCP images,
 * and the ways an open group closes itself (idle, client gone, Stop). The undo
 * behaviour on the real engine is mcpHost.native.test.ts.
 */

import type { ToolContext, ToolResult } from '@motion/ai-tools';
import { GROUP_IDLE_MS, McpCallHost, type McpHostDeps, type McpResult } from './mcpHost';
import type { AiTransaction } from '../aiTransaction';

interface FakeTx {
  label: string;
  state: 'open' | 'committed' | 'rolledBack';
}

function setup(over: Partial<McpHostDeps> = {}) {
  const txs: FakeTx[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const executed: string[] = [];
  const deps: McpHostDeps = {
    registry: () => ({
      has: (n: string) => ['describe_scene', 'create_layer', 'export_video', 'generate_video'].includes(n),
      get: (n: string) => (n === 'describe_scene' ? { name: n, kind: 'read', description: '', inputSchema: {} }
        : n === 'create_layer' ? { name: n, kind: 'write', description: '', inputSchema: {} } : undefined),
      execute: async (n: string): Promise<ToolResult> => {
        executed.push(n);
        return { ok: true, content: `did ${n}` };
      },
    }),
    beginTransaction: async (label: string) => {
      const t: FakeTx = { label, state: 'open' };
      txs.push(t);
      return {
        label,
        session: {} as AiTransaction['session'],
        commit: async () => { t.state = 'committed'; return { kind: 'engine' as const, gaps: [] }; },
        rollback: async () => { t.state = 'rolledBack'; },
      };
    },
    context: () => ({ signal: new AbortController().signal } as unknown as ToolContext),
    freshRun: () => undefined,
    renderStill: async () => ({ mimeType: 'image/png', data: 'PNGDATA' }),
    renderStrip: async () => null,
    access: async () => ({ ok: true }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    ...over,
  };
  const host = new McpCallHost(deps);
  const call = (name: string, args: unknown = {}, clientId = 1): Promise<McpResult> => host.handle({ clientId, name, args });
  const fireIdle = async (): Promise<void> => {
    const live = timers.filter((t) => !t.cleared);
    expect(live.at(-1)?.ms).toBe(GROUP_IDLE_MS);
    live.at(-1)?.fn();
    await call('describe_scene');
  };
  return { host, call, txs, executed, fireIdle };
}

const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : `[${c.mimeType}]`)).join(' ');

describe('McpCallHost', () => {
  it('refuses every call, with the reason, when the plan gate says no', async () => {
    const { call, executed } = setup({ access: async () => ({ ok: false, message: 'needs Pro' }) });
    const r = await call('describe_scene');
    expect(r).toEqual({ content: [{ type: 'text', text: 'needs Pro' }], isError: true });
    expect(executed).toEqual([]);
  });

  it('refuses an excluded tool before running anything', async () => {
    const { call, executed } = setup();
    expect((await call('generate_video')).isError).toBe(true);
    expect(executed).toEqual([]);
  });

  it('returns render_frame as an MCP image and clamps its size', async () => {
    let asked = 0;
    const { call } = setup({ renderStill: async (_t, size) => { asked = size; return { mimeType: 'image/png', data: 'PNGDATA' }; } });
    const r = await call('render_frame', { time: 1.5, maxSize: 99999 });
    expect(r.content[0]).toEqual({ type: 'image', data: 'PNGDATA', mimeType: 'image/png' });
    expect(asked).toBe(2048);
  });

  it('says so when the renderer could not draw', async () => {
    const { call } = setup({ renderStill: async () => null });
    expect((await call('render_frame', { time: 0 })).isError).toBe(true);
    const strip = await setup().call('render_filmstrip', { startSec: 2, endSec: 1 });
    expect(textOf(strip)).toMatch(/after startSec/);
  });

  it('wraps a changing call in its own transaction, but not a read', async () => {
    const { call, txs } = setup();
    await call('describe_scene');
    await call('create_layer');
    expect(txs).toEqual([{ label: 'Claude: create layer', state: 'committed' }]);
  });

  it('refuses a second begin_edit while a group is open', async () => {
    const { call } = setup();
    await call('begin_edit', { label: 'one' });
    const r = await call('begin_edit', { label: 'two' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/already open \("one"\)/);
  });

  it('closes an idle group after GROUP_IDLE_MS, committing it', async () => {
    const { call, txs, host, fireIdle } = setup();
    await call('begin_edit', { label: 'idle' });
    await call('create_layer');
    await fireIdle();
    expect(txs).toEqual([{ label: 'Claude: idle', state: 'committed' }]);
    expect(host.getActivity().group).toBeNull();
  });

  it('commits a group whose client disconnected', async () => {
    const { call, txs, host } = setup();
    await call('begin_edit', { label: 'gone' }, 7);
    await host.clientsChanged([3]);
    expect(txs[0]!.state).toBe('committed');
  });

  it('throws the open group away on Stop', async () => {
    const { call, txs, host } = setup();
    await call('begin_edit', { label: 'stop me' });
    await host.stop();
    expect(txs[0]!.state).toBe('rolledBack');
  });

  it('reports what it is doing, for the badge', async () => {
    const { call, host } = setup();
    const seen: Array<string | null> = [];
    host.subscribe((a) => seen.push(a.busy ? a.tool : a.group));
    await call('begin_edit', { label: 'L' });
    expect(seen).toContain('begin_edit');
    expect(host.getActivity()).toEqual({ busy: false, tool: null, group: 'L' });
  });
});

describe('approvals and project operations', () => {
  const editor = () => {
    const calls: string[] = [];
    return {
      calls,
      ops: {
        listCompositions: async () => ({ active: 'c1', compositions: [{ id: 'c1' }] }),
        createComposition: async (o: { name: string }) => { calls.push(`create:${o.name}`); return { id: 'c2' }; },
        setActiveComposition: async (id: string) => (id === 'c1' ? { ok: true as const, name: 'Main' } : { error: 'No composition' }),
        save: async () => ({ ok: true as const, message: 'Saved.' }),
        importMedia: async (paths: readonly string[]) => { calls.push(`import:${paths.join(',')}`); return { ok: true as const, message: 'Imported 1' }; },
        addSfx: async (id: string) => { calls.push(`sfx:${id}`); return { id: 'layer_9' }; },
        setAudioLevels: async () => ({ ok: true as const, message: 'Set.' }),
        duck: async () => ({ ok: true as const, message: 'Ducked.' }),
      },
    };
  };

  it('tells add_sfx when it runs inside an open group, so the insert joins the gesture (B2)', async () => {
    const seen: Array<boolean | undefined> = [];
    const ed = editor();
    const ops = { ...ed.ops, addSfx: async (_id: string, _at: number, _db: number | null, o?: { inGroup?: boolean }) => { seen.push(o?.inGroup); return { id: 'layer_9' }; } };
    const { call } = setup({ editor: ops });
    expect(textOf(await call('add_sfx', { id: 'sfx-click', atSec: 1 }))).toMatch(/audio layer layer_9/);
    await call('begin_edit', { label: 'sound' });
    expect(textOf(await call('add_sfx', { id: 'sfx-click', atSec: 2 }))).toMatch(/audio layer layer_9/);
    await call('end_edit');
    expect(seen).toEqual([false, true]);
  });

  it('imports only after the user allows it', async () => {
    const ed = editor();
    const denied = setup({ editor: ed.ops, approve: async () => false });
    const r = await denied.call('import_media', { paths: ['C:/a.png'] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/did not allow/);
    expect(ed.calls).toEqual([]);
    const allowed = setup({ editor: ed.ops, approve: async () => true });
    expect(textOf(await allowed.call('import_media', { paths: ['C:/a.png'] }))).toBe('Imported 1');
    expect(ed.calls).toEqual(['import:C:/a.png']);
  });

  it('never exports without an approver', async () => {
    const { call, executed } = setup();
    expect((await call('export_video', { format: 'mp4' })).isError).toBe(true);
    expect(executed).toEqual([]);
  });

  it('creates and switches compositions through the editor operations', async () => {
    const ed = editor();
    const { call } = setup({ editor: ed.ops });
    expect(textOf(await call('create_composition', { name: 'Vertical', width: 1080, height: 1920 }))).toMatch(/Created composition "Vertical" \(id c2\)/);
    expect(textOf(await call('set_active_composition', { compId: 'c1' }))).toMatch(/"Main" is now the active/);
    expect((await call('set_active_composition', { compId: 'zz' })).isError).toBe(true);
  });
});
