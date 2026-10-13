/**
 * What Claude is doing, in words for the user — the badge and the activity
 * panel read these instead of raw tool names.
 */

const LABELS: Record<string, string> = {
  get_app_state: 'Looking at Premation',
  list_projects: 'Listing projects',
  create_project: 'Creating a project',
  open_project: 'Opening a project',
  list_compositions: 'Reading compositions',
  create_composition: 'Adding a composition',
  set_active_composition: 'Switching composition',
  save_project: 'Saving',
  import_media: 'Importing media',
  export_video: 'Rendering video',
  describe_scene: 'Reading the scene',
  get_selection: 'Reading the selection',
  list_capabilities: 'Checking what Premation can do',
  evaluate_at: 'Measuring a layer',
  read_tracks: 'Reading animation',
  list_assets: 'Listing media',
  list_presets: 'Listing presets',
  render_frame: 'Looking at a frame',
  render_filmstrip: 'Watching the motion',
  begin_edit: 'Starting a change',
  end_edit: 'Finishing a change',
  get_author_guide: 'Reading the design guide',
  author_scene: 'Building the scene',
  create_layer: 'Adding a layer',
  update_layer: 'Editing a layer',
  delete_layer: 'Deleting a layer',
  set_keyframes: 'Animating',
  remove_keyframes: 'Removing keyframes',
  set_easing: 'Easing the motion',
  set_expression: 'Writing an expression',
  add_effect: 'Adding an effect',
  update_effect: 'Tuning an effect',
  update_effect_param: 'Tuning an effect',
  text_animator: 'Animating text',
  add_camera_move: 'Moving the camera',
  set_light: 'Lighting the scene',
  create_precomp: 'Nesting a composition',
  update_composition: 'Changing composition settings',
  get_design_guide: 'Reading the design guide',
  list_looks: 'Choosing a look',
  apply_look: 'Applying a look',
  list_techniques: 'Choosing motion',
  apply_technique: 'Animating with a technique',
  cast_piece: 'Designing the piece',
  review_design: 'Reviewing the design',
  list_sfx: 'Choosing sound effects',
  add_sfx: 'Adding a sound effect',
  set_audio_levels: 'Mixing audio',
  duck_audio: 'Ducking the music',
  generate_speech: 'Recording a voice-over',
};

/** "add_kinetic_title" → "Add kinetic title" for anything not listed. */
/** Who is on the pipe, in words. Cursor, Antigravity and ChatGPT use the same connection. */
export function mcpClientLabel(name: string): string {
  const n = name.trim();
  if (!n) return '';
  if (/cursor/i.test(n)) return 'Cursor';
  if (/antigravity|gemini/i.test(n)) return 'Antigravity';
  if (/codex|chatgpt|openai/i.test(n)) return 'ChatGPT';
  if (/claude-?code/i.test(n)) return 'Claude Code';
  if (/claude/i.test(n)) return 'Claude';
  if (/\s/.test(n)) return n;
  return n.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The name on the pill, the panel and the status line.
 *
 * A live client wins. Otherwise every app that is actually connected is
 * named — including Claude, when its extension is installed. Claude is not
 * the fallback for Cursor, Antigravity or ChatGPT.
 */
export function assistantName(setup: {
  configured: boolean;
  bridge: { clients: Array<{ name: string }> };
  apps?: Array<{ name: string; state: string }>;
} | null | undefined): string {
  if (!setup) return 'Assistant';
  const live = [...new Set(setup.bridge.clients.map((c) => mcpClientLabel(c.name)).filter(Boolean))];
  if (live.length > 0) return live.join(' · ');
  const ready = (setup.apps ?? []).filter((a) => a.state === 'ok').map((a) => a.name);
  if (setup.configured) ready.unshift('Claude');
  const unique = [...new Set(ready)];
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) return unique.join(' · ');
  return 'Assistant';
}

export function claudeToolLabel(tool: string | null | undefined): string {
  if (!tool) return '';
  const known = LABELS[tool];
  if (known) return known;
  const words = tool.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "12s ago", "3 min ago", "2 h ago". */
export function agoText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return s < 5 ? 'just now' : `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
