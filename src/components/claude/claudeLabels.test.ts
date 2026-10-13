import { assistantName, mcpClientLabel } from './claudeLabels';

describe('mcpClientLabel', () => {
  it('names the client that is actually connected', () => {
    expect(mcpClientLabel('cursor-vscode')).toBe('Cursor');
    expect(mcpClientLabel('antigravity')).toBe('Antigravity');
    expect(mcpClientLabel('gemini')).toBe('Antigravity');
    expect(mcpClientLabel('codex')).toBe('ChatGPT');
    expect(mcpClientLabel('claude-ai')).toBe('Claude');
    expect(mcpClientLabel('claude-code')).toBe('Claude Code');
    expect(mcpClientLabel('')).toBe('');
  });
});

describe('assistantName', () => {
  const setup = {
    configured: true,
    bridge: { clients: [] as Array<{ name: string }> },
    apps: [] as Array<{ name: string; state: string }>,
  };

  it('uses the live client, not Claude, when someone else is on the pipe', () => {
    expect(assistantName({
      ...setup,
      bridge: { clients: [{ name: 'cursor-vscode' }] },
    })).toBe('Cursor');
  });

  it('names a connected app while nobody is live, even if Claude is installed', () => {
    expect(assistantName({
      ...setup,
      apps: [{ name: 'Antigravity', state: 'ok' }],
    })).toBe('Claude · Antigravity');
  });

  it('says Claude only when Claude is the one that is set up', () => {
    expect(assistantName(setup)).toBe('Claude');
    expect(assistantName({ ...setup, configured: false })).toBe('Assistant');
  });
});
