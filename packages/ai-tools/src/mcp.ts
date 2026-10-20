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
  generate_3d_model: 'spends generation credit',
  // Reads the in-app prompt's attachments, which an MCP call does not have.
  create_media_from_attachment: 'needs an in-app prompt attachment',
};

/**
 * Registry tools that run only after the user clicks Allow in Premation
 * (owner decision 2026-10-08: files in or out need an in-app approval).
 */
export const MCP_APPROVAL_TOOLS: ReadonlySet<string> = new Set(['export_video', 'import_media', 'generate_speech']);

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
    name: 'get_design_guide',
    kind: 'read',
    description:
      'How to make work that looks DESIGNED in Premation, not generic: the process (look → cast or compose → technique → ' +
      'review), the craft rules and the things never to do. Read it once at the start of any design task. topic: "process", ' +
      '"craft", "looks" or "techniques" for one section.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { topic: { type: 'string', enum: ['process', 'craft', 'looks', 'techniques'] } },
    },
  },
  {
    name: 'list_looks',
    kind: 'read',
    description:
      'Premation\'s look packs — complete visual systems (palette, type pairing, shape language, pacing, motion signature, ' +
      'signature techniques): Apple-keynote, Swiss editorial, broadcast sports, cyberpunk kinetic, luxury film, SaaS ' +
      'explainer/product, mobile app. Pick the one that fits the brief and apply_look it.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'apply_look',
    kind: 'read',
    description:
      'Adopt a look pack for this session: cast_piece and apply_technique use it, and the compose tools (add_title, ' +
      'add_background, …) take its palette and easing. Give the brand colour as accent when there is one. Returns the ' +
      'palette and type to use when you build layers yourself.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['lookId'],
      properties: {
        lookId: { type: 'string' },
        accent: { type: 'string', description: 'Brand accent, hex.' },
        mode: { type: 'string', enum: ['dark', 'light'] },
      },
    },
  },
  {
    name: 'list_techniques',
    kind: 'read',
    description:
      'The motion technique library — about 110 hand-authored, professionally timed techniques: entrances, kinetic type, ' +
      'camera moves, transitions, backgrounds, emphasis, exits, product-UI motion. Each line: id, intent, energy, duration, ' +
      'which roles it animates, params. Filtered and ordered by the active look.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: 'string', enum: ['entrance', 'kinetic_type', 'transition', 'camera', 'background', 'emphasis', 'exit', 'ui'] },
        query: { type: 'string', description: 'Words to match in id, intent or tags.' },
      },
    },
  },
  {
    name: 'apply_technique',
    kind: 'compose',
    description:
      'Animate layers you made with a library technique — far better motion than hand-keyed fades: designed easing, ' +
      'property offsets, overshoot, blur on fast moves. Give the layer ids per ROLE the technique animates (from ' +
      'list_techniques), and when it starts. It never creates the content itself.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Technique id, e.g. "entrance.mask_rise".' },
        targets: { type: 'object', description: 'Role → layer ids, e.g. { "headline": ["layer_2"], "subhead": ["layer_3"] }.' },
        startSec: { type: 'number', minimum: 0, default: 0 },
        durationSec: { type: 'number', minimum: 0.1, description: 'Fitted to the technique\'s own range.' },
        params: { type: 'object', description: 'The technique\'s params (see list_techniques).' },
        seed: { type: 'integer', description: 'Pick another of its authored variants.' },
      },
    },
  },
  {
    name: 'cast_piece',
    kind: 'compose',
    description:
      'Build a complete designed piece from a brief: Premation sequences your beats, gives each a layout template and a ' +
      'motion technique in the active look, lints design and timing, repairs problems, and builds the best of several ' +
      'variants in the active composition. Write REAL copy in each beat. Call with menusOnly: true first to see the layout ' +
      'and technique options per beat and choose them (layoutPicks / motionPicks); omit picks to take the best-ranked.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['beats'],
      properties: {
        tone: { type: 'string', description: 'One line: what the piece is and how it should feel.' },
        energy: { type: 'number', minimum: 0, maximum: 1, default: 0.5, description: '0 calm … 1 high-energy.' },
        durationSec: { type: 'number', minimum: 1, description: 'Default: the composition length.' },
        lookId: { type: 'string', description: 'Default: the look from apply_look.' },
        accent: { type: 'string' },
        mode: { type: 'string', enum: ['dark', 'light'] },
        append: {
          type: 'boolean',
          description:
            'By default a second cast_piece in this session REPLACES the piece the first one built (re-casting with better copy ' +
            'or picks never leaves two copies in the composition). Pass true to keep the earlier piece and add this one.',
        },
        beats: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              purpose: { type: 'string', description: 'What the beat is for: hook, reveal, feature, stat, quote, cta, …' },
              weight: { type: 'number', description: 'Relative length (default 1).' },
              content: {
                type: 'object',
                description: 'headline, subhead, support, overline, quote, attribution, cta, items [{value,label} | {title,body}], mediaAssetId (from list_assets).',
              },
            },
          },
        },
        layoutPicks: { type: 'array', items: { type: 'object' }, description: '[{ beatIndex, id, seed? }] from the menus.' },
        motionPicks: { type: 'array', items: { type: 'object' }, description: '[{ beatIndex, id, params?, seed? }] from the menus.' },
        variants: { type: 'integer', minimum: 1, maximum: 4, default: 3 },
        menusOnly: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'review_design',
    kind: 'read',
    description:
      'Critique the active composition: mechanical checks (off-screen, invisible, past the end, everything popping in ' +
      'together), a filmstrip sampled around the keyframes plus speed graphs of the hero moves, and the questions a senior ' +
      'motion designer asks. Call after building and after each round of fixes.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'list_sfx',
    kind: 'read',
    description: 'Premation\'s built-in sound effects (clicks, whooshes, impacts, risers, booms, drones…), with length. Add with add_sfx.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'add_sfx',
    kind: 'write',
    description:
      'Add a built-in sound effect to the active composition at a time — a whoosh into a transition, an impact on a reveal, ' +
      'a riser before a drop, a click on a UI tap. Time it to the motion it belongs to.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'atSec'],
      properties: {
        id: { type: 'string', description: 'From list_sfx, e.g. "sfx-whoosh".' },
        atSec: { type: 'number', minimum: 0 },
        levelDb: { type: 'number', minimum: -48, maximum: 12, description: 'Loudness, dB (0 = as is).' },
      },
    },
  },
  {
    name: 'set_audio_levels',
    kind: 'write',
    description:
      'Set an audio layer\'s level (dB, 0 = unity, -6 half as loud, -96 silent) and optionally fade it in and/or out. ' +
      'Use to sit effects and voice over music.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string' },
        levelDb: { type: 'number', minimum: -96, maximum: 12 },
        fadeInSec: { type: 'number', minimum: 0, maximum: 30 },
        fadeOutSec: { type: 'number', minimum: 0, maximum: 30 },
      },
    },
  },
  {
    name: 'duck_audio',
    kind: 'write',
    description: 'Lower the music automatically while a voice-over plays (sidechain ducking), like a professional mix.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['musicId', 'voiceId'],
      properties: {
        musicId: { type: 'string', description: 'The music layer.' },
        voiceId: { type: 'string', description: 'The voice / dialogue layer.' },
        duckDb: { type: 'number', minimum: -40, maximum: 0, default: -12 },
      },
    },
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
        placeOnTimeline: { type: 'boolean', default: true, description: 'Also add each as a layer of the active composition.' },
        atSec: { type: 'number', minimum: 0, default: 0, description: 'Where each placed layer starts, composition seconds (default 0).' },
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
        append: {
          type: 'boolean',
          description:
            'By default a beat the composition already has (same beat name from an earlier author_scene) is REPLACED, ' +
            'so re-running a revised script never leaves two copies. Pass true to build next to what is there.',
        },
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
  'Premation is a desktop motion-design editor (an After Effects-class timeline with 2D/3D layers, keyframes, effects, cameras, lights and audio). These tools drive the running Premation app; the user watches every change live and can undo it.',
  'You are the designer. Aim for work a senior motion designer would sign: a real concept for THIS brief, not a template. Premation gives you the whole engine and compiles exactly what you write:',
  '1. Start with get_app_state. No project open: create_project (1920x1080 video, 1080x1920 vertical, 1080x1080 square) or open_project.',
  '2. Read get_author_guide once (and get_design_guide for the craft rules). Decide the concept, palette, type scale, grid and beats from the brief and any reference the user gave.',
  '3. Build it with author_scene: every layer, property, effect, keyframe and ease written by you — real 3D (primitives, extruded and bevelled type, PBR metal / glass materials, typed lights with soft shadows, environment skies), cameras, text animators, trim paths, repeaters, masks, mattes, blend modes, generated imagery and your own vectors are all available. Then refine with the layer tools (set_keyframes, set_easing, text_animator, add_effect, add_camera_move, set_light).',
  '4. Instruments, only when they serve your idea: apply_look (a palette/type/pacing pack), apply_technique (a hand-authored move for layers you made), cast_piece (template layouts; you pick a layout and a technique per beat from its menus). Never start from them — a piece that is only a look pack and a template reads as one.',
  '5. Sound: list_sfx / add_sfx on the moments that hit, set_audio_levels and duck_audio for the mix; import_media for the user\'s music; generate_speech for voice-over.',
  '6. review_design after building; fix the three biggest problems inside begin_edit / end_edit; review again; then save_project.',
  'Look before editing: describe_scene, get_selection ("this"), list_compositions, list_capabilities. Multi-scene: one composition per scene or format (create_composition / set_active_composition), nest with create_precomp.',
  'import_media, export_video and generate_speech need the user to click Allow in Premation; say what you are about to do first.',
  'Times are composition seconds. Ids come from describe_scene, list_compositions or the tool that created the thing. A failed call says why: change the call rather than repeating it.',
].join('\n');
