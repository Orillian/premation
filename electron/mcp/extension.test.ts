/**
 * The Claude Desktop extension Connect writes (`.mcpb`): a valid manifest that
 * names Premation with its logo and runs the bundled server with Claude's own
 * Node, pointed at this app's pipe — and detection of the installed copy.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { buildExtension, inspectExtension, readExtensionManifest } from './extension';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'premation-mcpb-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function inputs() {
  const scriptPath = path.join(dir, 'premation-mcp.cjs');
  const toolsPath = path.join(dir, 'tools.json');
  const iconPath = path.join(dir, 'icon.png');
  writeFileSync(scriptPath, 'module.exports = {};');
  writeFileSync(toolsPath, JSON.stringify([{ name: 'describe_scene', description: 'List layers. Second sentence.' }]));
  writeFileSync(iconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { appVersion: '0.9.0', scriptPath, toolsPath, iconPath, mcpDir: path.join(dir, 'mcp') };
}

describe('the Premation extension bundle', () => {
  it('carries a manifest named Premation, its logo and the server', () => {
    const bytes = buildExtension(inputs());
    const files = unzipSync(bytes);
    expect(Object.keys(files).filter((f) => !f.endsWith('/')).sort()).toEqual(['icon.png', 'manifest.json', 'server/premation-mcp.cjs']);
    const m = readExtensionManifest(bytes);
    expect(m).toMatchObject({
      manifest_version: '0.3',
      name: 'premation',
      display_name: 'Premation',
      version: '0.9.0',
      icon: 'icon.png',
      server: {
        type: 'node',
        entry_point: 'server/premation-mcp.cjs',
        mcp_config: { command: 'node', args: ['${__dirname}/server/premation-mcp.cjs'], env: { PREMATION_MCP_DIR: path.join(dir, 'mcp') } },
      },
      tools: [{ name: 'describe_scene', description: 'List layers.' }],
    });
  });

  it('says what is missing rather than writing a broken bundle', () => {
    const i = { ...inputs(), iconPath: path.join(dir, 'nope.png') };
    expect(() => buildExtension(i)).toThrow(/icon is missing/);
  });
});

describe('inspectExtension', () => {
  const install = (claudeDir: string, id: string, mcpDir: string, name = 'premation'): void => {
    const d = path.join(claudeDir, 'Claude Extensions', id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name, server: { mcp_config: { env: { PREMATION_MCP_DIR: mcpDir } } } }));
  };

  it('is absent with no extensions, or only other extensions', () => {
    expect(inspectExtension(dir, '/x/mcp')).toBe('absent');
    install(dir, 'local.other', '/x/mcp', 'other');
    expect(inspectExtension(dir, '/x/mcp')).toBe('absent');
  });

  it('is ok when it points at this app, stale when it points elsewhere', () => {
    install(dir, 'local.premation', '/old/mcp');
    expect(inspectExtension(dir, '/x/mcp')).toBe('stale');
    install(dir, 'local.premation-2', '/x/mcp');
    expect(inspectExtension(dir, '/x/mcp')).toBe('ok');
  });
});
