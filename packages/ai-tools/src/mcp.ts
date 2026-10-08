/**
 * The tool surface Premation offers an MCP client (Claude Desktop, Claude Code).
 *
 * docs/MCP_PLAN.md §5. It is the SAME vocabulary the in-app assistant uses
 * (`ALL_TOOL_DEFS`), filtered by an explicit exclusion list, plus a handful of
 * tools only an outside client needs: eyes (`render_frame`,
 * `render_filmstrip`), undo grouping (`begin_edit` / `end_edit`) and the
 * author-mode entry point (`get_author_guide`, `author_scene`).
 *
 * Two readers, one list: the bundled MCP server announces it (`tools/list`)
 * and the editor page refuses anything outside it, so a client that calls a
 * tool it was never offered gets the same answer as one that was told no.
 */

import type { AiToolDef } from './types';

/**
 * Registry tools an MCP client may NOT call, and why. Everything else in the
 * registry is offered.
 */
export const MCP_EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  // Each spends hosted generation credit through the backend; the in-app
  // assistant shows the cost before it runs, an outside client cannot.
  generate_image: 'spends generation credit',
  generate_video: 'spends generation credit',
  generate_speech: 'spends generation credit',
  generate_3d_model: 'spends generation credit',
  // Writes a file to disk / queues a render the user did not start.
  export_video: 'writes files outside the project',
  // Reads the in-app prompt's attachments, which an MCP call does not have.
  create_media_from_attachment: 'needs an in-app prompt attachment',
};

/** Tools that exist only on the MCP surface; the page handles them itself. */
export const MCP_ONLY_TOOL_DEFS: readonly AiToolDef[] = [
  {
    name: 'render_frame',
    kind: 'read',
    description:
      'Render one frame of the active composition with Premation\'s real renderer and return it as an image, ' +
      'so you can SEE what you built. Call it after a change and judge the picture (size, framing, contrast, ' +
      'legibility) before moving on. `time` is composition seconds. Returns an image, long side ≤ maxSize.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['time'],
      properties: {
        time: { type: 'number', minimum: 0, description: 'Composition time in seconds.' },
        maxSize: { type: 'integer', minimum: 128, maximum: 2048, default: 1024, description: 'Long side of the image in pixels (default 1024).' },
      },
    },
  },
  {
    name: 'render_filmstrip',
    kind: 'read',
    description:
      'Render evenly spaced frames of the active composition between two times as ONE contact-sheet image, ' +
      'each cell labelled with its time — the way to judge MOTION (timing, spacing, easing) rather than a ' +
      'single still. Use after animating.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['startSec', 'endSec'],
      properties: {
        startSec: { type: 'number', minimum: 0 },
        endSec: { type: 'number', minimum: 0 },
        cells: { type: 'integer', minimum: 2, maximum: 12, default: 8, description: 'How many frames (default 8).' },
      },
    },
  },
  {
    name: 'begin_edit',
    kind: 'read',
    description:
      'Start a group: every change until end_edit becomes ONE undo step in Premation, labelled with `label`. ' +
      'Use it when one request takes several tool calls ("make the logo larger, centre it and add a glow"), so ' +
      'the user can undo the whole request at once. Without a group, each changing call is its own undo step. ' +
      'A group closes itself after 30 s with no calls, or when the user starts editing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['label'],
      properties: { label: { type: 'string', description: 'What the user asked for, in a few words — shown in the History panel.' } },
    },
  },
  {
    name: 'end_edit',
    kind: 'read',
    description:
      'Close the group opened by begin_edit. commit=true (default) keeps the changes as one undo step; ' +
      'commit=false throws every change of the group away, as if it never happened.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { commit: { type: 'boolean', default: true } },
    },
  },
  {
    name: 'get_author_guide',
    kind: 'read',
    description:
      'The rules, vocabulary and a reference example for writing a SCENE SCRIPT — the fastest way to build a ' +
      'whole designed piece with author_scene. Read it once before your first author_scene call. `brief` is the ' +
      'user\'s request; it picks the closest reference example.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { brief: { type: 'string' } },
    },
  },
  {
    name: 'author_scene',
    kind: 'compose',
    description:
      'Build a complete composition from a scene script (header, palette, type, globals and beats of layers — ' +
      'see get_author_guide for the exact format). Premation repairs what it can, compiles the script into real ' +
      'layers and keyframes in the active composition, and reports repairs, rejected parts and design-advisor ' +
      'findings. It is ONE undo step. Look at the result with render_filmstrip afterwards and refine with the ' +
      'individual tools.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['script'],
      properties: {
        script: { type: 'object', description: 'The scene script, exactly as get_author_guide describes it.' },
      },
    },
  },
];

/** The names of the MCP-only tools. */
export const MCP_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(MCP_ONLY_TOOL_DEFS.map((t) => t.name));

/** May an MCP client call this registry tool? */
export function mcpAllowsRegistryTool(name: string): boolean {
  return !Object.prototype.hasOwnProperty.call(MCP_EXCLUDED_TOOLS, name);
}

/** The whole MCP surface: the allowed registry tools, then the MCP-only ones. */
export function mcpToolDefs(registryDefs: readonly AiToolDef[]): AiToolDef[] {
  return [...registryDefs.filter((d) => mcpAllowsRegistryTool(d.name)), ...MCP_ONLY_TOOL_DEFS];
}

/** Is this a tool an MCP client was offered? */
export function isMcpTool(name: string, registryHas: (name: string) => boolean): boolean {
  return MCP_ONLY_TOOL_NAMES.has(name) || (registryHas(name) && mcpAllowsRegistryTool(name));
}

/**
 * What the server tells the client at `initialize` — how to work with
 * Premation, in the order that produces good results.
 */
export const MCP_SERVER_INSTRUCTIONS = [
  'Premation is a desktop motion-design editor (an After Effects-class timeline with 2D/3D layers, keyframes and effects). These tools edit the project open in the running Premation app; the user watches the changes happen live.',
  'Work like this:',
  '1. Look first: describe_scene (layers, what is already animated), get_selection when the user says "this" or "the selected layer", list_capabilities when unsure a property or effect exists.',
  '2. For a whole new piece, read get_author_guide once and build it with author_scene; for targeted changes use the individual tools (create_layer, update_layer, set_keyframes, set_easing, add_effect, …).',
  '3. When one request takes several changing calls, wrap them in begin_edit / end_edit so the user can undo the request in one step.',
  '4. Check your work with render_frame (a still) or render_filmstrip (motion) and fix what looks wrong before you report back.',
  'Times are composition seconds. Ids come from describe_scene or from the tool that created the layer. A failed call says why and what to do differently — read it and retry rather than repeating the same call.',
].join('\n');
