/**
 * Camera program D4 / D5: camera import (glTF / the engine's baked FBX poses)
 * and export (glTF 2.0, Nuke .chan) — the round trip export → import gives
 * back the same world pose and field of view per frame.
 */

import { parseGltf } from '@core/media/gltf';
import { Matrix4Math, type Matrix4 } from '@motion/scene';
import {
  cameraToChan,
  cameraToGltf,
  camerasFromGltf,
  exportedRootWorld,
  orientationOf,
  rotationOf,
  focalOf,
  yfovOf,
  type CameraTrack,
} from './cameraInterchange';

const W = 1920;
const H = 1080;
const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** A camera dollying, panning, tilting, rolling and zooming over a second at 30 fps. */
function movingTrack(): CameraTrack {
  const samples = Array.from({ length: 31 }, (_, i) => {
    const t = i / 30;
    return {
      t,
      eye: { x: 960 + 400 * t, y: 540 - 120 * t, z: -1600 + 500 * t },
      yaw: -30 + 70 * t,
      pitch: 10 - 25 * t,
      roll: 5 * Math.sin(t * 3),
      focalLength: 1400 + 600 * t,
    };
  });
  return { name: 'Shot Cam', width: W, height: H, samples };
}

function expectSameRotation(a: { yaw: number; pitch: number; roll: number }, b: { yaw: number; pitch: number; roll: number }): void {
  const ra = rotationOf(a.yaw, a.pitch, a.roll);
  const rb = rotationOf(b.yaw, b.pitch, b.roll);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(ra[i]![j]!).toBeCloseTo(rb[i]![j]!, 4);
}

describe('camera interchange', () => {
  it('orientationOf inverts rotationOf (yaw, pitch and roll)', () => {
    for (const o of [{ yaw: 0, pitch: 0, roll: 0 }, { yaw: 37, pitch: -12, roll: 8 }, { yaw: -150, pitch: 60, roll: -45 }]) {
      const r = rotationOf(o.yaw, o.pitch, o.roll);
      const back = orientationOf({ x: r[0][2], y: r[1][2], z: r[2][2] }, { x: r[0][1], y: r[1][1], z: r[2][1] });
      expectSameRotation(back, o);
    }
  });

  it('zoom ↔ yfov', () => {
    expect(focalOf(yfovOf(1500, H), H)).toBeCloseTo(1500, 9);
  });

  it('D5 → D4: an exported glTF imports back to the same pose and field of view per frame', () => {
    const track = movingTrack();
    const parsed = parseGltf(bytes(cameraToGltf(track)));
    expect(parsed.cameras?.length).toBe(1);
    const root = exportedRootWorld(parsed, { width: W, height: H });
    expect(root).not.toBeNull();
    const [cam] = camerasFromGltf(parsed, root!, H, 30);
    expect(cam!.name).toBe('Shot Cam');
    expect(cam!.samples.length).toBe(track.samples.length);
    cam!.samples.forEach((s, i) => {
      const e = track.samples[i]!;
      expect(s.t).toBeCloseTo(e.t, 5);
      expect(s.eye.x).toBeCloseTo(e.eye.x, 2);
      expect(s.eye.y).toBeCloseTo(e.eye.y, 2);
      expect(s.eye.z).toBeCloseTo(e.eye.z, 2);
      expectSameRotation(s, e);
      expect(s.focalLength).toBeCloseTo(e.focalLength, 1);
    });
  });

  it('D4: a glTF camera under an animated parent bakes its world pose (looks down −Z, Y up)', () => {
    // A camera node 10 units in front of the origin (+Z toward the viewer), its parent turning 90° about Y over 1 s.
    const times = new Float32Array([0, 1]);
    const rot = new Float32Array([0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    const bin = new Uint8Array(times.byteLength + rot.byteLength);
    bin.set(new Uint8Array(times.buffer), 0);
    bin.set(new Uint8Array(rot.buffer), times.byteLength);
    let b = '';
    for (const x of bin) b += String.fromCharCode(x);
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Rig', children: [1] }, { name: 'Cam', camera: 0, translation: [0, 0, 10] }],
      cameras: [{ type: 'perspective', perspective: { yfov: 0.8, znear: 0.1 } }],
      buffers: [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${btoa(b)}` }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }, { buffer: 0, byteOffset: 8, byteLength: 32 }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' },
      ],
      animations: [{ samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] }],
    };
    const parsed = parseGltf(bytes(JSON.stringify(gltf)));
    const root: Matrix4 = [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100, 0, W / 2, H / 2, 0, 1];
    const [cam] = camerasFromGltf(parsed, root, H, 30);
    expect(cam!.samples.length).toBe(31);
    const first = cam!.samples[0]!;
    // glTF +Z (toward the viewer) is Premation −Z: the camera sits 1000 px in front of the comp, looking in.
    expect(first.eye.x).toBeCloseTo(W / 2, 6);
    expect(first.eye.y).toBeCloseTo(H / 2, 6);
    expect(first.eye.z).toBeCloseTo(-1000, 6);
    expect(first.yaw).toBeCloseTo(0, 6);
    expect(first.pitch).toBeCloseTo(0, 6);
    expect(first.focalLength).toBeCloseTo(focalOf(0.8, H), 3);
    // After the parent's quarter turn about glTF +Y the camera looks along glTF −X: Premation −X.
    const last = cam!.samples[30]!;
    const f = rotationOf(last.yaw, last.pitch, last.roll);
    expect(f[0][2]).toBeCloseTo(-1, 4);
    expect(last.eye.x).toBeCloseTo(W / 2 + 1000, 3);
    expect(Matrix4Math.identity().length).toBe(16);
  });

  it('D4: the engine’s baked FBX poses (extras.premationSamples) import as world poses', () => {
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'FbxCam', camera: 0 }],
      cameras: [{
        type: 'perspective', perspective: { yfov: 0.6 },
        extras: { premationSamples: [[0, 0, 0, 5, 0, 0, 0, 1, 0.6], [1, 2, 0, 5, 0, 0, 0, 1, 0.5]] },
      }],
    };
    const parsed = parseGltf(bytes(JSON.stringify(gltf)));
    const root: Matrix4 = [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100, 0, W / 2, H / 2, 0, 1];
    const [cam] = camerasFromGltf(parsed, root, H, 30);
    expect(cam!.samples.map((s) => s.eye.x)).toEqual([W / 2, W / 2 + 200]);
    expect(cam!.samples[0]!.eye.z).toBeCloseTo(-500, 6);
    expect(cam!.samples[1]!.focalLength).toBeCloseTo(focalOf(0.5, H), 6);
  });

  it('D5: Nuke .chan — one line per frame, frame tx ty tz rx ry rz vfov', () => {
    const track = movingTrack();
    const lines = cameraToChan(track, 30).trim().split('\n');
    expect(lines.length).toBe(31);
    const first = lines[0]!.split('\t').map(Number);
    expect(first.length).toBe(8);
    expect(first[0]).toBe(0);
    // Y up, comp centre at the origin, 1 unit = 100 px; the camera's −z (toward the viewer) is +Z.
    expect(first[1]).toBeCloseTo(0, 6);
    expect(first[3]).toBeCloseTo(16, 6);
    expect(first[7]).toBeCloseTo(yfovOf(1400, H) * 180 / Math.PI, 4);
    expect(Number(lines[30]!.split('\t')[0])).toBe(30);
  });
});
