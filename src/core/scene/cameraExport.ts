/**
 * Layer ▸ Camera ▸ Export Camera… (camera program D5): bake a camera's
 * EVALUATED view (the engine's `sampleCamera` — shake, auto-orient, parents
 * and expressions included) once per frame over the work area, and save it as
 * a glTF 2.0 camera (`.gltf`, Blender / Cinema 4D) and a Nuke `.chan`.
 * Coordinate conversion: cameraInterchange.ts.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import type { CameraSamples } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { flicksToSeconds } from '@core/engine/time';
import { documentMirror } from '@stores/documentMirror';
import { useUIStore } from '@stores/uiStore';
import { downloadBlob } from '@core/export/exportManager';
import { commandCamera } from './cameraCommands';
import { cameraToChan, cameraToGltf, type CameraTrack } from './cameraInterchange';

/** The engine's samples as a track (seconds, Premation orientation). */
export function trackFromSamples(name: string, answer: CameraSamples): CameraTrack {
  return {
    name,
    width: answer.compWidth,
    height: answer.compHeight,
    samples: answer.samples.map((s) => ({
      t: flicksToSeconds(s.time),
      eye: { x: s.eye.x, y: s.eye.y, z: s.eye.z },
      yaw: s.yaw,
      pitch: s.pitch,
      roll: s.roll,
      focalLength: s.zoom,
    })),
  };
}

/** Sample `camera` once per frame over its comp's work area. Null when the engine refuses. */
export async function bakeCameraTrack(camera: string): Promise<{ track: CameraTrack; fps: number } | null> {
  const m = documentMirror();
  const layer = m.layer(camera);
  const settings = layer ? m.comp(layer.comp)?.settings : undefined;
  if (!layer || !settings) return null;
  const fps = settings.frameRate.num / Math.max(1, settings.frameRate.den);
  const range = settings.workArea.duration > 0 ? settings.workArea : { start: 0, duration: settings.duration };
  const frames = Math.max(1, Math.round(flicksToSeconds(range.duration) * fps));
  const res = await engine().query({ type: 'sampleCamera', layer: camera, range, samples: frames + 1 });
  if (!res.ok) return null;
  return { track: trackFromSamples(layer.name, res.value as CameraSamples), fps };
}

export function buildCameraExportCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('camera.exportCamera'),
      label: 'Export Camera…',
      description: 'Save the camera, baked per frame over the work area, as glTF (Blender, Cinema 4D) and Nuke .chan',
      icon: 'camera',
      enabled: () => commandCamera() !== null,
      execute: async () => {
        const cam = commandCamera();
        const baked = cam ? await bakeCameraTrack(cam) : null;
        const notify = useUIStore.getState().notify;
        if (!baked) {
          notify({ level: 'warning', message: 'Select a camera to export', durationMs: 4000 });
          return;
        }
        const base = baked.track.name.replace(/[\\/:*?"<>|]+/g, '_') || 'camera';
        downloadBlob(new Blob([cameraToGltf(baked.track)], { type: 'model/gltf+json' }), `${base}.gltf`);
        downloadBlob(new Blob([cameraToChan(baked.track, baked.fps)], { type: 'text/plain' }), `${base}.chan`);
        notify({ level: 'success', message: `Exported ${baked.track.samples.length} frames of ${baked.track.name} (.gltf + .chan)`, durationMs: 4000 });
      },
    },
  ];
}
