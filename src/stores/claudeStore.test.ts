/** The indicator's state, and approvals that answer the waiting tool call. */

import type { ClaudeSetupStatus, McpAppStatus } from '@app-types/motionEditor';
import { isClaudeEntry } from '@core/ai/mcp/claudeUndo';
import { claudeMode, useClaudeStore } from './claudeStore';

const setup = (o: { enabled?: boolean; clients?: number; configured?: boolean; apps?: McpAppStatus[] } = {}): ClaudeSetupStatus => ({
  bridge: {
    enabled: o.enabled ?? true,
    listening: true,
    error: null,
    pageReady: true,
    clients: Array.from({ length: o.clients ?? 0 }, (_, i) => ({ id: i, name: 'claude-ai', version: '1', since: 0, lastCallAt: null })),
  },
  claude: { installed: true, configs: [], extension: o.configured ? 'ok' : 'absent' },
  method: o.configured ? 'extension' : null,
  configured: o.configured ?? true,
  needsRepair: false,
  extensionFile: null,
  connectorInstalled: true,
  claudeCodeCommand: '',
  manualSnippet: '',
  serverName: 'premation',
  devBuild: false,
  apps: o.apps ?? [],
});
const idle = { busy: false, tool: null, group: null, feed: [] };

describe('claudeMode', () => {
  it('is off until Claude is turned on', () => {
    expect(claudeMode(null, idle, 0)).toBe('off');
    expect(claudeMode(setup({ enabled: false }), idle, 0)).toBe('off');
  });
  it('separates ready, connected and working', () => {
    expect(claudeMode(setup(), idle, 0)).toBe('ready');
    expect(claudeMode(setup({ clients: 1 }), idle, 0)).toBe('connected');
    expect(claudeMode(setup({ clients: 1 }), { ...idle, busy: true, tool: 'create_layer' }, 0)).toBe('working');
    expect(claudeMode(setup({ clients: 1 }), { ...idle, group: 'logo' }, 0)).toBe('working');
  });
  it('is ready when another app is connected and Claude is not', () => {
    expect(claudeMode(setup({
      configured: false,
      apps: [{ id: 'cursor', name: 'Cursor', present: true, state: 'ok', configPath: '', restart: '', blurb: '', command: '', snippet: '' }],
    }), idle, 0)).toBe('ready');
  });
  it('says setup while not installed in Claude, and needs-you over everything', () => {
    expect(claudeMode(setup({ configured: false }), idle, 0)).toBe('setup');
    expect(claudeMode(setup({ clients: 1 }), { ...idle, busy: true }, 1)).toBe('needs-you');
  });
});

describe('approvals', () => {
  it('resolve the waiting request with the user\'s answer and leave the queue', async () => {
    const p = useClaudeStore.getState().requestApproval({ kind: 'import', title: 'Import 1 file', detail: ['C:/a.png'] });
    const [pending] = useClaudeStore.getState().approvals;
    expect(pending?.title).toBe('Import 1 file');
    expect(useClaudeStore.getState().panelOpen).toBe(true);
    useClaudeStore.getState().answerApproval(pending!.id, true);
    await expect(p).resolves.toBe(true);
    expect(useClaudeStore.getState().approvals).toEqual([]);
  });
});

describe('isClaudeEntry', () => {
  it('only matches Claude\'s own history entries', () => {
    expect(isClaudeEntry({ label: 'Claude: logo reveal', origin: 'ai' })).toBe(true);
    expect(isClaudeEntry({ label: 'Move Layer', origin: 'ui' })).toBe(false);
    expect(isClaudeEntry({ label: 'Claude: x', origin: 'ui' })).toBe(false);
    expect(isClaudeEntry(undefined)).toBe(false);
  });
});
