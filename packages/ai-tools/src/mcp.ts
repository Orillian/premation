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
  // Reads the in-app prompt's attachments, which an MCP call does not have.
  create_media_from_attachment: 'needs an in-app prompt attachment',
};

/**
 * Registry tools that run only after the user clicks Allow in Premation
 * (owner decision 2026-10-08: files in or out need an in-app approval).
 */
export const MCP_APPROVAL_TOOLS: ReadonlySet<string> = new Set(['export_video', 'import_media']);

/**
 * Tools that work with NO project open — the app's front desk answers them
 * (src/core/ai/mcp/frontDesk.ts). Every other tool needs an open project.
 */
export const MCP_FRONT_DESK_TOOL_DEFS: readonly AiToolDef[] = [
  {
    name: 'get_app_state',
    kind: 'read',
    description:
      'Where the user is in Premation right now: whether a project is open (its name and compositions, the active one) ' +
      'or they are on the home screen, and whether they are signed in. Call this FIRST in a conversation, before any ' +
      'other tool. If no project is open, use create_project or open_project.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'list_projects',
    kind: 'read',
    description:
      'The user\'s Premation projects, most recent first, with the id open_project takes. Works with no project open.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Filter by name.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
  },
  {
    name: 'create_project',
    kind: 'write',
    description:
      'Create a NEW Premation project and open it in the editor, with one composition of the given size, frame rate and ' +
      'length — then build in it with the editing tools. Works with no project open. If a project with unsaved changes is ' +
      'open, Premation asks the user first. Pick the frame from the request: 1920×1080 for video, 1080×1920 for ' +
      'Reels/Shorts/TikTok, 1080×1080 for square posts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Project name (default "Untitled project").' },
        width: { type: 'integer', minimum: 16, maximum: 8192, default: 1920 },
        height: { type: 'integer', minimum: 16, maximum: 8192, default: 1080 },
        fps: { type: 'number', minimum: 1, maximum: 120, default: 30 },
        durationSeconds: { type: 'number', minimum: 0.5, maximum: 3600, default: 10 },
        background: { type: 'string', description: 'Composition background, hex (default #101014).' },
      },
    },
  },
  {
    name: 'open_project',
    kind: 'read',
    description: 'Open an existing project in the editor by the id list_projects gave. Works with no project open.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
];

/** The names of the front-desk tools. */
export const MCP_FRONT_DESK_TOOL_NAMES: ReadonlySet<string> = new Set(MCP_FRONT_DESK_TOOL_DEFS.map((t) => t.name));

/** Tools that exist only on the MCP surface; the page handles them itself. */
export const MCP_ONLY_TOOL_DEFS: readonly AiToolDef[] = [
  ...MCP_FRONT_DESK_TOOL_DEFS,
  {
    name: 'list_compositions',
    kind: 'read',
    description:
      'Every composition in the open project — id, name, size, fps, length, layer count — and which one is active. ' +
      'Editing tools work on the ACTIVE composition; switch with set_active_composition.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'create_composition',
    kind: 'write',
    description:
      'Add a composition to the open project and make it the active one (later tools build in it). Use one per ' +
      'deliverable (e.g. a 16:9 and a 9:16 cut) or per scene you will nest with create_precomp.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string' },
        width: { type: 'integer', minimum: 16, maximum: 8192, default: 1920 },
        height: { type: 'integer', minimum: 16, maximum: 8192, default: 1080 },
        fps: { type: 'number', minimum: 1, maximum: 120, default: 30 },
        durationSeconds: { type: 'number', minimum: 0.1, maximum: 3600, default: 10 },
        background: { type: 'string', description: 'Hex colour (default #101014).' },
      },
    },
  },
  {
    name: 'set_active_composition',
    kind: 'read',
    description: 'Make a composition the active one (it opens as the editor\'s tab), by the id list_compositions gave.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['compId'],
      properties: { compId: { type: 'string' } },
    },
  },
  {
    name: 'save_project',
    kind: 'read',
    description: 'Save the open project (File ▸ Save). Cloud projects also save themselves; call this at the end of a big change.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'import_media',
    kind: 'write',
    description:
      'Import image, video or audio FILES from the user\'s computer into the project by absolute path, and optionally ' +
      'place each on the active composition. The user must click Allow in Premation first; a refusal is final for that ' +
      'request. Then animate the placed layers like any other.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['paths'],
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
        placeOnTimeline: { type: 'boolean', default: true, description: 'Also add each as a layer at the playhead.' },
      },
    },
  },
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
  'Premation is a desktop motion-design editor (an After Effects-class timeline with 2D/3D layers, keyframes, effects, cameras and lights). These tools drive the running Premation app; the user watches every change happen live and can undo it.',
  'Work like this:',
  '1. Start with get_app_state. If no project is open, create_project (pick the frame from the request: 1920x1080 video, 1080x1920 vertical, 1080x1080 square) or open_project from list_projects.',
  '2. Look before editing: describe_scene (layers, what is already animated), get_selection for "this"/"the selected layer", list_compositions for the project, list_capabilities when unsure a property or effect exists.',
  '3. Plan bigger pieces as scenes: one composition per deliverable or scene (create_composition / set_active_composition), nest them with create_precomp, move the camera with add_camera_move, and time entrances to music with analyse_audio.',
  '4. For a whole designed piece, read get_author_guide once and build it with author_scene, then refine with the individual tools (create_layer, update_layer, set_keyframes, set_easing, add_effect, text_animator, ...).',
  '5. Wrap each request that takes several changing calls in begin_edit / end_edit, so the user can undo it in one step.',
  '6. Check your work with render_frame (a still) or render_filmstrip (motion), fix what looks wrong, then save_project.',
  'import_media and export_video need the user to click Allow in Premation; say what you are about to do before calling them.',
  'Times are composition seconds. Ids come from describe_scene, list_compositions or the tool that created the thing. A failed call says why and what to do differently: read it and change the call rather than repeating it.',
].join('\n');
