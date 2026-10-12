#!/usr/bin/env node
// Writes the model3d sample's test assets (all made here, no third-party content):
//   box.glb             a 2 × 1 × 1 box, normals, uvs, an orange baseColorFactor (one file)
//   box.gltf + box.bin  the same box as JSON + an external buffer (get_asset_sibling_bytes)
//   checker.png         an 8 × 8 two-tone checker (a Base Color Map)
//
//   node native/sdk/samples/model3d/models/make_models.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const dir = path.dirname(fileURLToPath(import.meta.url));

// ── the box: 24 vertices (a normal per face), 36 indices ──
const half = [1, 0.5, 0.5];
const faces = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];
const pos = [];
const nrm = [];
const uv = [];
const idx = [];
for (const [n, u, v] of faces) {
  const base = pos.length / 3;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    for (let k = 0; k < 3; k++) pos.push((n[k] + a * u[k] + b * v[k]) * half[k]);
    nrm.push(...n);
    uv.push((a + 1) / 2, (1 - b) / 2);
  }
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
const u16 = (a) => Buffer.from(new Uint16Array(a).buffer);
const pad4 = (b, fill = 0) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);
const bPos = f32(pos);
const bNrm = f32(nrm);
const bUv = f32(uv);
const bIdx = pad4(u16(idx));
const bin = Buffer.concat([bPos, bNrm, bUv, bIdx]);
const min = [-half[0], -half[1], -half[2]];
const max = [...half];
const gltf = (uri) => ({
  asset: { version: '2.0', generator: 'premation model3d sample (make_models.mjs)' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'box' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  materials: [{ name: 'orange', pbrMetallicRoughness: { baseColorFactor: [1, 0.55, 0.15, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
  buffers: [uri ? { uri, byteLength: bin.length } : { byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: bPos.length, target: 34962 },
    { buffer: 0, byteOffset: bPos.length, byteLength: bNrm.length, target: 34962 },
    { buffer: 0, byteOffset: bPos.length + bNrm.length, byteLength: bUv.length, target: 34962 },
    { buffer: 0, byteOffset: bPos.length + bNrm.length + bUv.length, byteLength: idx.length * 2, target: 34963 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
    { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
  ],
});

// .gltf + .bin
writeFileSync(path.join(dir, 'box.gltf'), JSON.stringify(gltf('box.bin'), null, 2) + '\n');
writeFileSync(path.join(dir, 'box.bin'), bin);

// .glb: header, JSON chunk (space-padded), BIN chunk
const json = pad4(Buffer.from(JSON.stringify(gltf(null))), 0x20);
const header = Buffer.alloc(12);
const total = 12 + 8 + json.length + 8 + bin.length;
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
const chunk = (type, data) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};
writeFileSync(path.join(dir, 'box.glb'), Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]));

// checker.png: 8 × 8 RGB, 2 × 2 cells
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(0);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const W = 8;
const raw = [];
for (let y = 0; y < W; y++) {
  raw.push(0);
  for (let x = 0; x < W; x++) {
    const on = ((x >> 1) + (y >> 1)) % 2 === 0;
    raw.push(...(on ? [240, 240, 240] : [40, 90, 200]));
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(W, 4);
ihdr[8] = 8;
ihdr[9] = 2;
writeFileSync(
  path.join(dir, 'checker.png'),
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.from(raw))), pngChunk('IEND', Buffer.alloc(0))]),
);
console.log(`box.glb ${total} B, box.bin ${bin.length} B`);
