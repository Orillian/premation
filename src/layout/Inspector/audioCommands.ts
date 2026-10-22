/**
 * Audio editing commands: fade in / out, remove silence, duck music, gate.
 *
 * The three analysis tools are dialog-first — they have several parameters and
 * a readout that only means something once the audio has been analysed — so
 * the command opens the dialog rather than doing the edit. The dialogs
 * register themselves here ({@link setAudioToolOpener}) when their module
 * loads. The fades are the Inspector's own `fadeEdit` (level keyframes, one
 * entry). What has sound is read off the document mirror (B4 round 8): an
 * audio layer, or a video layer (its own track).
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { DEFAULT_FADE_SEC, type FadeSide } from '@core/audio/audioFades';
import { fadeEdit } from './audioEdits';
import { t } from '@core/i18n';

export const REMOVE_SILENCE_COMMAND = asCommandId('audio.removeSilence');
export const DUCK_MUSIC_COMMAND = asCommandId('audio.duckMusic');
export const GATE_COMMAND = asCommandId('audio.gate');
export const FADE_IN_COMMAND = asCommandId('audio.fadeIn');
export const FADE_OUT_COMMAND = asCommandId('audio.fadeOut');

/** Which dialog an opener stands for. */
export type AudioTool = 'silence' | 'ducking' | 'gate';

const openers = new Map<AudioTool, (nodeId: string) => void>();

/** Called by each dialog module as it loads. Replacing is fine (HMR). */
export function setAudioToolOpener(tool: AudioTool, open: (nodeId: string) => void): void {
  openers.set(tool, open);
}

function notify(message: string, level: 'info' | 'warning' = 'warning'): void {
  useUIStore.getState().notify({ level, message, durationMs: 5000 });
}

/** Whether a layer carries sound (the mirror's kind: an audio layer, or footage with its own track). */
function hasSound(id: string): boolean {
  const k = documentMirror().layer(id)?.kind;
  return k === 'audio' || k === 'video';
}

/** The selected layer that has sound, or undefined. */
export function selectedAudioNodeId(): string | undefined {
  return useSelectionStore.getState().ids.find(hasSound);
}

/** "Select a layer with sound first — <tool> needs something to listen to.", one whole sentence per tool. */
function noSoundMessage(tool: AudioTool): string {
  switch (tool) {
    case 'silence': return t('inspector.audioCommands.noSound.silence', 'Select a layer with sound first — silence removal needs something to listen to.');
    case 'ducking': return t('inspector.audioCommands.noSound.ducking', 'Select a layer with sound first — ducking needs something to listen to.');
    default: return t('inspector.audioCommands.noSound.gate', 'Select a layer with sound first — the noise gate needs something to listen to.');
  }
}

function run(tool: AudioTool): void {
  const nodeId = selectedAudioNodeId();
  if (!nodeId) {
    notify(noSoundMessage(tool));
    return;
  }
  const open = openers.get(tool);
  if (!open) {
    notify(t('inspector.audioCommands.notLoaded', 'The audio panel has not loaded yet. Open the Inspector and try again.'), 'info');
    return;
  }
  open(nodeId);
}

/**
 * Every SELECTED layer that has sound. The fades act on the whole selection —
 * "fade these three out" is one act and one undo entry.
 */
function selectedAudioNodeIds(): string[] {
  return useSelectionStore.getState().ids.filter(hasSound);
}

function runFade(side: FadeSide): void {
  const ids = selectedAudioNodeIds();
  if (ids.length === 0) {
    notify(t('inspector.audioCommands.noSound.fade', 'Select a layer with sound first — a fade needs something to fade.'));
    return;
  }
  void fadeEdit(ids, side).then((faded) => {
    if (faded === 0) notify(t('inspector.audioCommands.nothingToFade', 'Those layers have no audible span to fade — check their bars are not zero-length.'));
  });
}

/** Every audio command, for `buildStaticCommands` or a direct registration. */
export function buildAudioCommands(): ReadonlyArray<Command> {
  return [
    {
      id: REMOVE_SILENCE_COMMAND,
      label: t('inspector.audioCommands.removeSilence', 'Remove Silence…'),
      description: t('inspector.audioCommands.removeSilenceDesc', 'Find the dead air in this layer and cut it out, closing the gaps — picture and sound from the same file stay in sync.'),
      icon: 'audio',
      enabled: () => selectedAudioNodeId() !== undefined,
      execute: () => run('silence'),
    },
    {
      id: DUCK_MUSIC_COMMAND,
      label: t('inspector.audioCommands.duck', 'Duck Under Voice…'),
      description: t('inspector.audioCommands.duckDesc', 'Hold this layer’s level down whenever another layer is talking, as level keyframes.'),
      icon: 'audio',
      enabled: () => selectedAudioNodeId() !== undefined,
      execute: () => run('ducking'),
    },
    {
      id: GATE_COMMAND,
      label: t('inspector.audioCommands.gate', 'Noise Gate…'),
      description: t('inspector.audioCommands.gateDesc', 'Pull this layer down wherever it is below a threshold — room tone between phrases, hiss under a take — as level keyframes you can reshape.'),
      icon: 'audio',
      enabled: () => selectedAudioNodeId() !== undefined,
      execute: () => run('gate'),
    },
    {
      id: FADE_IN_COMMAND,
      label: t('inspector.audioCommands.fadeIn', 'Fade In'),
      description: t('inspector.audioCommands.fadeInDesc', 'Ramp this layer up from silence over {sec}s from where its bar starts, as ordinary level keyframes you can reshape in the graph editor.', { sec: DEFAULT_FADE_SEC }),
      icon: 'audio',
      enabled: () => selectedAudioNodeIds().length > 0,
      execute: () => runFade('in'),
    },
    {
      id: FADE_OUT_COMMAND,
      label: t('inspector.audioCommands.fadeOut', 'Fade Out'),
      description: t('inspector.audioCommands.fadeOutDesc', 'Ramp this layer down to silence over the last {sec}s of its bar, as ordinary level keyframes you can reshape in the graph editor.', { sec: DEFAULT_FADE_SEC }),
      icon: 'audio',
      enabled: () => selectedAudioNodeIds().length > 0,
      execute: () => runFade('out'),
    },
  ];
}
