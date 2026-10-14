/**
 * Layer ▸ Camera ▸ Create Stereo 3D Rig (camera program D7) — the command
 * palette / menu entry over `createStereoRigEdit` (stereoRig.ts).
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { commandCamera } from './cameraCommands';
import { createStereoRigEdit, stereoRigSource } from './stereoRig';

function notify(message: string, level: 'info' | 'success' | 'warning'): void {
  useUIStore.getState().notify({ level, message, durationMs: 5000 });
}

export function buildStereoRigCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('camera.createStereoRig'),
      label: 'Create Stereo 3D Rig',
      description: 'Left and right eye cameras that follow this camera, eye comps and a 3D Glasses output comp',
      icon: 'camera',
      enabled: () => commandCamera() !== null,
      execute: async () => {
        const cam = commandCamera();
        const src = cam ? stereoRigSource(cam) : null;
        if (!src) {
          notify('Select a camera (or look through one) to build a stereo rig', 'warning');
          return;
        }
        const rig = await createStereoRigEdit(src);
        if (!rig) {
          notify('Could not create the stereo rig', 'warning');
          return;
        }
        useSelectionStore.getState().set([rig.controls]);
        notify(
          `Stereo rig built — adjust it on "Stereo Camera Controls" (${rig.names.convergence}: 0 off · 1 point of interest · 2 zero Z); the output is the "Stereo 3D" comp`,
          'success',
        );
      },
    },
  ];
}
