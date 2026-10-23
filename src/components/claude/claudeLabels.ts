/**
 * What Claude is doing, in words for the user — the badge and the activity
 * panel read these instead of raw tool names.
 */

import { t } from '@core/i18n';

/** Called at use time: `t()` must not run at module scope. */
function labels(): Record<string, string> {
  return {
    get_app_state: t('ui.claude.tool.getAppState', 'Looking at Premation'),
    list_projects: t('ui.claude.tool.listProjects', 'Listing projects'),
    create_project: t('ui.claude.tool.createProject', 'Creating a project'),
    open_project: t('ui.claude.tool.openProject', 'Opening a project'),
    list_compositions: t('ui.claude.tool.listCompositions', 'Reading compositions'),
    create_composition: t('ui.claude.tool.createComposition', 'Adding a composition'),
    set_active_composition: t('ui.claude.tool.setActiveComposition', 'Switching composition'),
    save_project: t('ui.claude.tool.saveProject', 'Saving'),
    import_media: t('ui.claude.tool.importMedia', 'Importing media'),
    export_video: t('ui.claude.tool.exportVideo', 'Rendering video'),
    describe_scene: t('ui.claude.tool.describeScene', 'Reading the scene'),
    get_selection: t('ui.claude.tool.getSelection', 'Reading the selection'),
    list_capabilities: t('ui.claude.tool.listCapabilities', 'Checking what Premation can do'),
    evaluate_at: t('ui.claude.tool.evaluateAt', 'Measuring a layer'),
    read_tracks: t('ui.claude.tool.readTracks', 'Reading animation'),
    list_assets: t('ui.claude.tool.listAssets', 'Listing media'),
    list_presets: t('ui.claude.tool.listPresets', 'Listing presets'),
    render_frame: t('ui.claude.tool.renderFrame', 'Looking at a frame'),
    render_filmstrip: t('ui.claude.tool.renderFilmstrip', 'Watching the motion'),
    analyze_motion: t('ui.claude.tool.analyzeMotion', 'Measuring the motion'),
    render_motion_sheet: t('ui.claude.tool.renderMotionSheet', 'Studying a moment frame by frame'),
    search_library: t('ui.claude.tool.searchLibrary', 'Searching the library'),
    preview_library: t('ui.claude.tool.previewLibrary', 'Previewing library items'),
    insert_library_item: t('ui.claude.tool.insertLibraryItem', 'Adding from the library'),
    render_rig_view: t('ui.claude.tool.renderRigView', 'Looking at the rig'),
    rig_character: t('ui.claude.tool.rigCharacter', 'Rigging the character'),
    rig_cycle: t('ui.claude.tool.rigCycle', 'Animating the rig'),
    begin_edit: t('ui.claude.tool.beginEdit', 'Starting a change'),
    end_edit: t('ui.claude.tool.endEdit', 'Finishing a change'),
    get_author_guide: t('ui.claude.tool.readDesignGuide', 'Reading the design guide'),
    author_scene: t('ui.claude.tool.authorScene', 'Building the scene'),
    create_layer: t('ui.claude.tool.createLayer', 'Adding a layer'),
    update_layer: t('ui.claude.tool.updateLayer', 'Editing a layer'),
    delete_layer: t('ui.claude.tool.deleteLayer', 'Deleting a layer'),
    set_keyframes: t('ui.claude.tool.setKeyframes', 'Animating'),
    remove_keyframes: t('ui.claude.tool.removeKeyframes', 'Removing keyframes'),
    set_easing: t('ui.claude.tool.setEasing', 'Easing the motion'),
    set_expression: t('ui.claude.tool.setExpression', 'Writing an expression'),
    add_effect: t('ui.claude.tool.addEffect', 'Adding an effect'),
    update_effect: t('ui.claude.tool.updateEffect', 'Tuning an effect'),
    update_effect_param: t('ui.claude.tool.updateEffect', 'Tuning an effect'),
    text_animator: t('ui.claude.tool.textAnimator', 'Animating text'),
    add_camera_move: t('ui.claude.tool.addCameraMove', 'Moving the camera'),
    set_light: t('ui.claude.tool.setLight', 'Lighting the scene'),
    create_precomp: t('ui.claude.tool.createPrecomp', 'Nesting a composition'),
    update_composition: t('ui.claude.tool.updateComposition', 'Changing composition settings'),
    get_design_guide: t('ui.claude.tool.readDesignGuide', 'Reading the design guide'),
    list_looks: t('ui.claude.tool.listLooks', 'Choosing a look'),
    apply_look: t('ui.claude.tool.applyLook', 'Applying a look'),
    list_techniques: t('ui.claude.tool.listTechniques', 'Choosing motion'),
    apply_technique: t('ui.claude.tool.applyTechnique', 'Animating with a technique'),
    cast_piece: t('ui.claude.tool.castPiece', 'Designing the piece'),
    review_design: t('ui.claude.tool.reviewDesign', 'Reviewing the design'),
    list_sfx: t('ui.claude.tool.listSfx', 'Choosing sound effects'),
    add_sfx: t('ui.claude.tool.addSfx', 'Adding a sound effect'),
    set_audio_levels: t('ui.claude.tool.setAudioLevels', 'Mixing audio'),
    duck_audio: t('ui.claude.tool.duckAudio', 'Ducking the music'),
    generate_speech: t('ui.claude.tool.generateSpeech', 'Recording a voice-over'),
  };
}

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
  if (!setup) return t('ui.claude.assistant', 'Assistant');
  const live = [...new Set(setup.bridge.clients.map((c) => mcpClientLabel(c.name)).filter(Boolean))];
  if (live.length > 0) return live.join(' · ');
  const ready = (setup.apps ?? []).filter((a) => a.state === 'ok').map((a) => a.name);
  if (setup.configured) ready.unshift('Claude');
  const unique = [...new Set(ready)];
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) return unique.join(' · ');
  return t('ui.claude.assistant', 'Assistant');
}

export function claudeToolLabel(tool: string | null | undefined): string {
  if (!tool) return '';
  const known = labels()[tool];
  if (known) return known;
  const words = tool.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "12s ago", "3 min ago", "2 h ago". */
export function agoText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return s < 5 ? t('ui.claude.ago.justNow', 'just now') : t('ui.claude.ago.seconds', '{n}s ago', { n: s });
  const m = Math.round(s / 60);
  return m < 60 ? t('ui.claude.ago.minutes', '{n} min ago', { n: m }) : t('ui.claude.ago.hours', '{n} h ago', { n: Math.round(m / 60) });
}
