// Depth Matte (depth-matte) -- keeps the pixels whose scene depth lies between Near and Far, feathered.
// Camera program D1: reads the composition's scene depth (render_graph/scene_depth.cpp) at binding 3 —
// camera-space z of the nearest 3D surface, comp px, +inf where none — with textureLoad at this fragment.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var depthTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
struct Prm { near: f32, far: f32, feather: f32, inv: f32, lw: f32, lh: f32 };
fn prm() -> Prm { return Prm(obj.p0.x, obj.p0.y, obj.p0.z, obj.p0.w, obj.p1.x, obj.p1.y); }
const PI : f32 = 3.14159265358979;
const TAU : f32 = 6.28318530717959;
var<private> gLwh : vec2<f32>;
// FIELD coordinate (top-down buffer fractions); layer px = field -> fxBox -> lwh.
fn fieldQ(uv : vec2<f32>) -> vec2<f32> { return (uv - obj.uvRect.xy) / obj.uvRect.zw; }
fn pxUv(px : vec2<f32>) -> vec2<f32> {
  let q = obj.fxBox.xy + (px / gLwh) * obj.fxBox.zw;
  return obj.uvRect.xy + q * obj.uvRect.zw;
}
fn inBox(px : vec2<f32>) -> bool { return px.x >= 0.0 && px.y >= 0.0 && px.x <= gLwh.x && px.y <= gLwh.y; }
fn samplePx(px : vec2<f32>) -> vec4<f32> {
  if (!inBox(px)) { return vec4<f32>(0.0); }
  return textureSampleLevel(tex, smp, pxUv(px), 0.0);
}
fn sampleClampPx(px : vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(tex, smp, pxUv(clamp(px, vec2<f32>(0.5), gLwh - vec2<f32>(0.5))), 0.0);
}
fn fmod(a : f32, b : f32) -> f32 { return a - b * floor(a / b); }
fn fmod2(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> { return a - b * floor(a / b); }
fn sampleWrapPx(px : vec2<f32>) -> vec4<f32> { return sampleClampPx(fmod2(px, gLwh)); }
fn sampleMirrorPx(px : vec2<f32>) -> vec4<f32> {
  let m = fmod2(px, gLwh * 2.0);
  return sampleClampPx(select(m, gLwh * 2.0 - m, m > gLwh));
}
// One target texel, in layer px.
fn texelPx() -> vec2<f32> { return gLwh / max(obj.fxBox.zw * obj.uvRect.zw * vec2<f32>(textureDimensions(tex)), vec2<f32>(1.0)); }
fn s2l(c : f32) -> f32 { if (c <= 0.04045) { return c / 12.92; } return pow((c + 0.055) / 1.055, 2.4); }
fn l2s(c : f32) -> f32 { if (c <= 0.0031308) { return c * 12.92; } return 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055; }
fn s2l3(c : vec3<f32>) -> vec3<f32> { return vec3<f32>(s2l(c.r), s2l(c.g), s2l(c.b)); }
fn l2s3(c : vec3<f32>) -> vec3<f32> { return vec3<f32>(l2s(c.r), l2s(c.g), l2s(c.b)); }
// Premultiplied working colour -> straight display (sRGB) colour, and back.
fn toDisp(c : vec4<f32>) -> vec4<f32> {
  if (c.a <= 0.0) { return vec4<f32>(0.0); }
  return vec4<f32>(l2s3(max(c.rgb / c.a, vec3<f32>(0.0))), c.a);
}
fn fromDisp(rgb : vec3<f32>, a : f32) -> vec4<f32> { return vec4<f32>(s2l3(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0))) * a, a); }
fn luma(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }
fn lumaLin(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
// Scene depth under this fragment (+inf: no 3D surface; outside the depth buffer: +inf).
fn sceneZ(fc : vec2<f32>) -> f32 {
  let dim = vec2<i32>(textureDimensions(depthTex));
  let ij = vec2<i32>(floor(fc));
  if (ij.x < 0 || ij.y < 0 || ij.x >= dim.x || ij.y >= dim.y) { return 3.0e38; }
  return textureLoad(depthTex, ij, 0).r;
}
@fragment fn fs(@builtin(position) fc : vec4<f32>, @location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let P = prm();
  gLwh = max(vec2<f32>(P.lw, P.lh), vec2<f32>(1.0, 1.0));
  let src = textureSampleLevel(tex, smp, uv, 0.0);
  let z = sceneZ(fc.xy);
  let f = max(P.feather, 0.0001);
  let inNear = clamp((z - (P.near - f)) / f, 0.0, 1.0);
  let inFar = clamp(((P.far + f) - z) / f, 0.0, 1.0);
  var m = select(inNear * inFar, 0.0, z >= 1.0e37);
  if (P.inv > 0.5) { m = 1.0 - m; }
  return src * m;
}
