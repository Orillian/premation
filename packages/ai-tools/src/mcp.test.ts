/** The MCP tool surface: the registry minus the exclusions, plus the MCP-only tools. */

import { ALL_TOOL_DEFS } from './tools';
import { MCP_EXCLUDED_TOOLS, MCP_ONLY_TOOL_DEFS, isMcpTool, mcpToolDefs } from './mcp';

describe('mcpToolDefs', () => {
  const defs = mcpToolDefs(ALL_TOOL_DEFS);
  const names = defs.map((d) => d.name);

  it('offers every registry tool except the excluded ones, and every MCP-only tool', () => {
    for (const d of ALL_TOOL_DEFS) expect(names.includes(d.name)).toBe(!(d.name in MCP_EXCLUDED_TOOLS));
    for (const d of MCP_ONLY_TOOL_DEFS) expect(names).toContain(d.name);
  });

  it('has unique names, none colliding with the registry', () => {
    expect(new Set(names).size).toBe(names.length);
    const registry = new Set(ALL_TOOL_DEFS.map((d) => d.name));
    for (const d of MCP_ONLY_TOOL_DEFS) expect(registry.has(d.name)).toBe(false);
  });

  it('only excludes tools that exist (a renamed tool must not slip back in)', () => {
    const registry = new Set(ALL_TOOL_DEFS.map((d) => d.name));
    for (const name of Object.keys(MCP_EXCLUDED_TOOLS)) expect(registry.has(name)).toBe(true);
  });

  it('describes every tool with an object schema', () => {
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.inputSchema.type).toBe('object');
    }
  });

  it('answers isMcpTool the same way the list does', () => {
    const has = (n: string): boolean => ALL_TOOL_DEFS.some((d) => d.name === n);
    expect(isMcpTool('describe_scene', has)).toBe(true);
    expect(isMcpTool('render_frame', has)).toBe(true);
    expect(isMcpTool('export_video', has)).toBe(false);
    expect(isMcpTool('rm_rf', has)).toBe(false);
  });
});
