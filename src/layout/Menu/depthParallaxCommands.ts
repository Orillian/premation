/**
 * Layer ▸ Camera ▸ Make 3D from Photo / Video… (camera program D3): the
 * selected image / video layer's depth estimated (the engine's depthEstimate
 * job) and the layer made a depth-parallax layer; the Properties panel's
 * Depth Parallax section picks a depth-map layer instead and tunes it.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { getTime } from '@stores/playbackClockStore';
import { applyAnimationPresetEdit } from './appEdits';
import { commandCamera } from '@core/scene/cameraCommands';
import { isDepthParallaxCandidate, makeDepthFromModel } from '@core/scene/depthParallax';

function target(): string | null {
  return useSelectionStore.getState().ids.find((id) => isDepthParallaxCandidate(id)) ?? null;
}

export function buildDepthParallaxCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('camera.make3DFromPhoto'),
      label: 'Make 3D from Photo/Video…',
      description: 'Estimate the depth of the selected image or video and render it as a 3D parallax surface',
      icon: 'camera',
      enabled: () => target() !== null,
      execute: async () => {
        const layer = target();
        const ui = useUIStore.getState();
        if (!layer) {
          ui.notify({ level: 'info', message: 'Select an image or video layer', durationMs: 4000 });
          return;
        }
        const r = await makeDepthFromModel(layer);
        if (!r.ok) {
          ui.notify({ level: 'warning', message: r.message, durationMs: 6000 });
          return;
        }
        const cam = commandCamera();
        ui.notify({
          level: 'success',
          message: 'The layer is 3D now — a camera move shows the parallax',
          durationMs: 8000,
          ...(cam ? { action: { label: 'Push In', onSelect: () => { void applyAnimationPresetEdit([cam], 'Push In', getTime()); } } } : {}),
        });
      },
    },
  ];
}
