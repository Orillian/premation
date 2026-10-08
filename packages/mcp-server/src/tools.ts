/** The tools premation-mcp announces: the in-app vocabulary, filtered for MCP. */

import { ALL_TOOL_DEFS, mcpToolDefs } from '@motion/ai-tools';

export function listTools(): { tools: Array<{ name: string; description: string; inputSchema: unknown }> } {
  return {
    tools: mcpToolDefs(ALL_TOOL_DEFS).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}
