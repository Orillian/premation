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
};

/** "add_kinetic_title" → "Add kinetic title" for anything not listed. */
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
