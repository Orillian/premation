/**
 * Camera interchange (camera program D4 import / D5 export) — pure maths over
 * glTF cameras, Premation camera samples and Nuke `.chan` files.
 *
 * ## Coordinate conversion (documented, round-trip exact)
 *
 * Premation comp space: x right, y DOWN, z INTO the screen, units comp px; a
 * camera looks along its local +z with +y down (camera3d.ts / transform.cpp).
 * glTF: x right, y UP, z toward the viewer, a camera looks along its local −z
 * with +y up. The change of basis is C = diag(1, −1, −1) — the same one the
 * model importer uses for meshes (modelMesh.ts gltfTranslationToLocal) — so a
 * camera's local axes map through C exactly as world points do.
 *
 * Export writes positions relative to the comp centre on the comp plane:
 *   gltf = C · (p − (w/2, h/2, 0)) / pxPerUnit      (pxPerUnit = 100: 1 px = 1 cm)
 * and stores `pxPerUnit` in the file's `asset.extras.premationPxPerUnit`, so
 * a camera-only file comes back where it was. A file from elsewhere (no extra)
 * is placed by the model importer's own fit.
 *
 * Zoom ↔ yfov: a pinhole of focal f px over a comp h px tall sees
 *   yfov = 2·atan(h / 2 / f)   ⇔   f = h / 2 / tan(yfov / 2).
 *
 * Nuke `.chan`: one line per frame — `frame tx ty tz rx ry rz vfov`,
 * translation in the glTF frame above (Y up, units = pxPerUnit), rotation in
 * degrees for Nuke's default ZXY order, vertical field of view in degrees.
 */

import type { GltfAnimation, GltfChannel, ParsedGltf } from '@core/media/gltf';
import { Matrix4Math, type Matrix4, type Vec3 } from '@motion/scene';

export const PX_PER_UNIT = 100;
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** A camera's evaluated view at one time (the engine's `sampleCamera` answer). */
export interface CameraSample {
  /** Seconds (comp time). */
  t: number;
  eye: Vec3;
  /** Degrees, Premation's orientation (yaw about y, then pitch, then roll about the view axis). */
  yaw: number;
  pitch: number;
  roll: number;
  /** Zoom, comp px. */
  focalLength: number;
}

export interface CameraTrack {
  name: string;
  /** Comp size the samples were taken in. */
  width: number;
  height: number;
  samples: CameraSample[];
}

type M3 = [[number, number, number], [number, number, number], [number, number, number]];

/** Premation camera-to-world rotation (columns = right, down, forward) from yaw / pitch / roll. */
export function rotationOf(yaw: number, pitch: number, roll: number): M3 {
  // transform.cpp unproject_screen_ray: v → roll → pitch (about x) → yaw (about y).
  const rot = (v: Vec3): Vec3 => {
    const cz = Math.cos(roll * RAD), sz = Math.sin(roll * RAD);
    const vx = cz * v.x - sz * v.y;
    const vy = sz * v.x + cz * v.y;
    const vz = v.z;
    const cx = Math.cos(pitch * RAD), sx = Math.sin(pitch * RAD);
    const cy = Math.cos(yaw * RAD), sy = Math.sin(yaw * RAD);
    const y1 = cx * vy - sx * vz;
    const z1 = sx * vy + cx * vz;
    return { x: cy * vx + sy * z1, y: y1, z: -sy * vx + cy * z1 };
  };
  const r = rot({ x: 1, y: 0, z: 0 });
  const d = rot({ x: 0, y: 1, z: 0 });
  const f = rot({ x: 0, y: 0, z: 1 });
  return [[r.x, d.x, f.x], [r.y, d.y, f.y], [r.z, d.z, f.z]];
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Yaw / pitch / roll (degrees) of a camera looking along `forward` with `down` as its screen-down axis. */
export function orientationOf(forward: Vec3, down: Vec3): { yaw: number; pitch: number; roll: number } {
  const f = norm(forward);
  // transform.cpp look_at_orientation.
  const yaw = Math.atan2(f.x, f.z) * DEG;
  const pitch = Math.atan2(-f.y, Math.hypot(f.x, f.z)) * DEG;
  const base = rotationOf(yaw, pitch, 0);
  const r0 = { x: base[0][0], y: base[1][0], z: base[2][0] };
  const d0 = { x: base[0][1], y: base[1][1], z: base[2][1] };
  const d = norm(down);
  // down = cos(roll)·d0 − sin(roll)·r0.
  const roll = Math.atan2(-dot(d, r0), dot(d, d0)) * DEG;
  return { yaw: yaw + 0, pitch: pitch + 0, roll: Math.abs(roll) < 1e-9 ? 0 : roll };
}

export const yfovOf = (focal: number, height: number): number => 2 * Math.atan(height / 2 / Math.max(focal, 1e-6));
export const focalOf = (yfov: number, height: number): number => height / 2 / Math.tan(Math.max(yfov, 1e-6) / 2);

// ── quaternions ─────────────────────────────────────────────────────────────

type Quat = [number, number, number, number];

function quatFromM3(m: M3): Quat {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

function m3FromQuat(q: Quat): M3 {
  const [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w) || 1;
  const qx = x / n, qy = y / n, qz = z / n, qw = w / n;
  return [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
}

/** C · R · C with C = diag(1, −1, −1): a rotation between Premation and glTF frames (its own inverse). */
function flip(m: M3): M3 {
  const s = [1, -1, -1];
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[i]![j]! * s[i]! * s[j]!)) as M3;
}

// ── export: glTF 2.0 ────────────────────────────────────────────────────────

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * A self-contained `.gltf` (buffer as a data: URI) with one perspective camera
 * node animated by its baked samples (LINEAR translation + rotation), ready
 * for Blender / Cinema 4D. Zoom changes are written as `extras.yfov` keys
 * (glTF cannot animate a camera's yfov without KHR_animation_pointer).
 */
export function cameraToGltf(track: CameraTrack): string {
  const n = track.samples.length;
  const times = new Float32Array(n);
  const trans = new Float32Array(n * 3);
  const rots = new Float32Array(n * 4);
  const cx = track.width / 2;
  const cy = track.height / 2;
  let prev: Quat | null = null;
  track.samples.forEach((s, i) => {
    times[i] = s.t;
    trans[i * 3] = (s.eye.x - cx) / PX_PER_UNIT;
    trans[i * 3 + 1] = -(s.eye.y - cy) / PX_PER_UNIT;
    trans[i * 3 + 2] = -s.eye.z / PX_PER_UNIT;
    let q = quatFromM3(flip(rotationOf(s.yaw, s.pitch, s.roll)));
    // Keep the quaternion on one hemisphere so LINEAR (slerp) never takes the long way.
    if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    prev = q;
    rots.set(q, i * 4);
  });
  const bin = new Uint8Array(times.byteLength + trans.byteLength + rots.byteLength);
  bin.set(new Uint8Array(times.buffer), 0);
  bin.set(new Uint8Array(trans.buffer), times.byteLength);
  bin.set(new Uint8Array(rots.buffer), times.byteLength + trans.byteLength);
  const first = track.samples[0];
  const yfov = first ? yfovOf(first.focalLength, track.height) : 0.7;
  const tMin = n > 0 ? Math.min(...times) : 0;
  const tMax = n > 0 ? Math.max(...times) : 0;
  const gltf = {
    asset: { version: '2.0', generator: 'Premation camera export', extras: { premationPxPerUnit: PX_PER_UNIT, compWidth: track.width, compHeight: track.height } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{
      name: track.name,
      camera: 0,
      translation: first ? Array.from(trans.subarray(0, 3)) : [0, 0, 0],
      rotation: first ? Array.from(rots.subarray(0, 4)) : [0, 0, 0, 1],
    }],
    cameras: [{
      type: 'perspective',
      name: track.name,
      perspective: { yfov, aspectRatio: track.width / Math.max(1, track.height), znear: 0.01 },
      extras: { yfovKeys: track.samples.map((s) => [s.t, yfovOf(s.focalLength, track.height)]) },
    }],
    buffers: [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${base64(bin)}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: times.byteLength },
      { buffer: 0, byteOffset: times.byteLength, byteLength: trans.byteLength },
      { buffer: 0, byteOffset: times.byteLength + trans.byteLength, byteLength: rots.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: 'SCALAR', min: [tMin], max: [tMax] },
      { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: n, type: 'VEC4' },
    ],
    animations: n > 1 ? [{
      name: `${track.name} move`,
      samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }, { input: 0, output: 2, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }, { sampler: 1, target: { node: 0, path: 'rotation' } }],
    }] : [],
  };
  return JSON.stringify(gltf, null, 2);
}

// ── export: Nuke .chan ──────────────────────────────────────────────────────

/** Nuke ZXY Euler (degrees) of a glTF-frame rotation: R = Ry · Rx · Rz. */
function eulerZXY(m: M3): [number, number, number] {
  const rx = Math.asin(Math.max(-1, Math.min(1, -m[1][2])));
  const rz = Math.atan2(m[1][0], m[1][1]);
  const ry = Math.atan2(m[0][2], m[2][2]);
  return [rx * DEG, ry * DEG, rz * DEG];
}

export function cameraToChan(track: CameraTrack, fps: number): string {
  const cx = track.width / 2;
  const cy = track.height / 2;
  const f = (v: number): string => (Math.abs(v) < 1e-10 ? '0' : Number(v.toFixed(6)).toString());
  return track.samples.map((s) => {
    const [rx, ry, rz] = eulerZXY(flip(rotationOf(s.yaw, s.pitch, s.roll)));
    const frame = Math.round(s.t * fps);
    const vfov = yfovOf(s.focalLength, track.height) * DEG;
    return [frame, (s.eye.x - cx) / PX_PER_UNIT, -(s.eye.y - cy) / PX_PER_UNIT, -s.eye.z / PX_PER_UNIT, rx, ry, rz, vfov]
      .map((v, i) => (i === 0 ? String(v) : f(v))).join('\t');
  }).join('\n') + '\n';
}

// ── import: glTF cameras ────────────────────────────────────────────────────

export interface ImportedCamera {
  name: string;
  gltfNode: number;
  /** Zoom at the first sample, comp px. */
  focalLength: number;
  /** Baked keys (one per sample) when the camera or a parent is animated; one entry otherwise. */
  samples: CameraSample[];
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function slerpQ(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
  if (d > 0.9995) {
    const o: Quat = [lerp(a[0], bx, t), lerp(a[1], by, t), lerp(a[2], bz, t), lerp(a[3], bw, t)];
    const l = Math.hypot(...o) || 1;
    return [o[0] / l, o[1] / l, o[2] / l, o[3] / l];
  }
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** A channel's value at `t` (LINEAR / STEP; CUBICSPLINE uses its values linearly, as modelAnimation does). */
export function sampleChannel(ch: GltfChannel, t: number): number[] {
  const comps = ch.path === 'rotation' ? 4 : 3;
  const stride = ch.interpolation === 'CUBICSPLINE' ? comps * 3 : comps;
  const off = ch.interpolation === 'CUBICSPLINE' ? comps : 0;
  const at = (k: number): number[] => Array.from({ length: comps }, (_, c) => ch.values[k * stride + off + c] ?? 0);
  const n = ch.times.length;
  if (n === 0) return at(0);
  if (t <= ch.times[0]!) return at(0);
  if (t >= ch.times[n - 1]!) return at(n - 1);
  let k = 0;
  while (k < n - 2 && ch.times[k + 1]! <= t) k++;
  const t0 = ch.times[k]!;
  const t1 = ch.times[k + 1]!;
  const u = ch.interpolation === 'STEP' || t1 <= t0 ? 0 : (t - t0) / (t1 - t0);
  const a = at(k);
  const b = at(k + 1);
  if (comps === 4) return slerpQ(a as Quat, b as Quat, u);
  return a.map((v, i) => lerp(v, b[i]!, u));
}

/** A node's local matrix in the converted (Premation) basis at clip time `t`. */
function localAt(parsed: ParsedGltf, node: number, clip: GltfAnimation | null, t: number): Matrix4 {
  const n = parsed.nodes[node]!;
  let tr = n.t;
  let ro = n.r;
  let sc = n.s;
  for (const ch of clip?.channels ?? []) {
    if (ch.node !== node) continue;
    if (ch.path === 'translation') tr = sampleChannel(ch, t) as [number, number, number];
    else if (ch.path === 'rotation') ro = sampleChannel(ch, t) as Quat;
    else if (ch.path === 'scale') sc = sampleChannel(ch, t) as [number, number, number];
  }
  // C · M · C: translation (x, −y, −z), rotation flipped, scale as is.
  const r = flip(m3FromQuat(ro as Quat));
  const m: Matrix4 = [
    r[0][0] * sc[0], r[1][0] * sc[0], r[2][0] * sc[0], 0,
    r[0][1] * sc[1], r[1][1] * sc[1], r[2][1] * sc[1], 0,
    r[0][2] * sc[2], r[1][2] * sc[2], r[2][2] * sc[2], 0,
    tr[0], -tr[1], -tr[2], 1,
  ];
  return m;
}

/**
 * Every perspective camera of a parsed glTF as Premation camera samples, the
 * file's first clip baked at `fps` (`rootWorld` = the model root's placement
 * in the comp: the importer's fit, or the export's own comp-centre frame).
 */
export function camerasFromGltf(parsed: ParsedGltf, rootWorld: Matrix4, compHeight: number, fps = 30): ImportedCamera[] {
  const parentOf = new Map<number, number>();
  parsed.nodes.forEach((n, i) => n.children.forEach((c) => parentOf.set(c, i)));
  const clip = parsed.animations.find((a) => a.channels.length > 0) ?? null;
  const out: ImportedCamera[] = [];
  parsed.nodes.forEach((n, i) => {
    if (n.camera === null || n.camera === undefined) return;
    const cam = parsed.cameras?.[n.camera];
    if (!cam || cam.type !== 'perspective') return;
    if (cam.samples && cam.samples.length > 0) {
      // Baked world poses (the engine's FBX conversion): no chain to walk.
      const samples = cam.samples.map((r) => {
        const local = localAt({ ...parsed, nodes: [{ ...n, t: [r[1]!, r[2]!, r[3]!], r: [r[4]!, r[5]!, r[6]!, r[7]!], s: [1, 1, 1] }] }, 0, null, 0);
        const w = Matrix4Math.multiply(rootWorld, local);
        const o = orientationOf(Matrix4Math.transformVector(w, { x: 0, y: 0, z: 1 }), Matrix4Math.transformVector(w, { x: 0, y: 1, z: 0 }));
        return { t: r[0]!, eye: Matrix4Math.transformPoint(w, { x: 0, y: 0, z: 0 }), ...o, focalLength: focalOf(r[8]!, compHeight) };
      });
      out.push({ name: cam.name || n.name, gltfNode: i, focalLength: samples[0]!.focalLength, samples });
      return;
    }
    const chain: number[] = [];
    for (let k: number | undefined = i; k !== undefined && chain.length < 64; k = parentOf.get(k)) chain.unshift(k);
    const animated = clip !== null && clip.channels.some((ch) => chain.includes(ch.node) && ch.path !== 'weights');
    const end = animated ? Math.max(0, ...clip!.channels.filter((ch) => chain.includes(ch.node)).map((ch) => ch.times[ch.times.length - 1] ?? 0)) : 0;
    const count = animated ? Math.max(1, Math.round(end * fps)) + 1 : 1;
    const samples: CameraSample[] = [];
    for (let s = 0; s < count; s++) {
      const t = animated ? Math.min(end, s / fps) : 0;
      let w = rootWorld;
      for (const k of chain) w = Matrix4Math.multiply(w, localAt(parsed, k, animated ? clip : null, t));
      const eye = Matrix4Math.transformPoint(w, { x: 0, y: 0, z: 0 });
      const fwd = Matrix4Math.transformVector(w, { x: 0, y: 0, z: 1 });
      const down = Matrix4Math.transformVector(w, { x: 0, y: 1, z: 0 });
      const o = orientationOf(fwd, down);
      const yfov = cam.yfovKeys ? yfovAt(cam.yfovKeys, t) : cam.yfov;
      samples.push({ t, eye, ...o, focalLength: focalOf(yfov, compHeight) });
    }
    out.push({ name: cam.name || n.name, gltfNode: i, focalLength: samples[0]!.focalLength, samples });
  });
  return out;
}

function yfovAt(keys: ReadonlyArray<readonly [number, number]>, t: number): number {
  if (keys.length === 0) return 0.7;
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]!;
    const [t0, v0] = keys[i - 1]!;
    if (t <= t1) return t1 <= t0 ? v1 : lerp(v0, v1, (t - t0) / (t1 - t0));
  }
  return keys[keys.length - 1]![1];
}

/** The root placement for a file this module exported (comp centre, px per unit), else null. */
export function exportedRootWorld(parsed: ParsedGltf, comp: { width: number; height: number }): Matrix4 | null {
  const k = parsed.pxPerUnit ?? null;
  if (!k) return null;
  return [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, comp.width / 2, comp.height / 2, 0, 1];
}

/** The camera layer props for an imported camera's first sample (one-node: orientation, no Point of Interest). */
export function cameraLayerProps(c: ImportedCamera): Record<string, number> {
  const s = c.samples[0]!;
  return {
    x: s.eye.x, y: s.eye.y, z: s.eye.z,
    focalLength: s.focalLength,
    orientationX: s.pitch, orientationY: s.yaw, orientationZ: s.roll,
  };
}
