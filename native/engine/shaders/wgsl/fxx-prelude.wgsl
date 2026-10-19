// fx-graph prelude (docs/PROGRAM_DEEP_EFFECTS.md X0): prepended to every graph
// shader (render_graph/fx_graph.cpp fx_graph_wgsl) — never compiled alone.
//
// Bindings: tex0 = the pass's in0, tex1..tex3 = in1..in3 (each defaults to the
// effect's input). Uniforms: p[0..14] = the pass's rows, res = (lw, lh, outW,
// outH) — the layer box in layer px and the target the pass draws — world =
// the comp px rect the buffer shows (zero on the 3D route), and fxBox, the
// layer box in buffer fractions (top-down field space). Buffers hold
// premultiplied linear-light colour.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p: array<vec4<f32>, 15>, res: vec4<f32>, world: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex0 : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var tex1 : texture_2d<f32>;
@group(0) @binding(4) var tex2 : texture_2d<f32>;
@group(0) @binding(5) var tex3 : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
const PI : f32 = 3.14159265358979;
const TAU : f32 = 6.28318530717959;
fn P(i : i32) -> vec4<f32> { return obj.p[i]; }
fn lwh() -> vec2<f32> { return max(obj.res.xy, vec2<f32>(1.0)); }
fn outSize() -> vec2<f32> { return max(obj.res.zw, vec2<f32>(1.0)); }
// Buffer uv -> field (top-down buffer fractions) -> layer px, and back.
fn fieldQ(uv : vec2<f32>) -> vec2<f32> { return (uv - obj.uvRect.xy) / obj.uvRect.zw; }
fn layerPx(uv : vec2<f32>) -> vec2<f32> { return (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001)) * lwh(); }
fn pxUv(px : vec2<f32>) -> vec2<f32> { return obj.uvRect.xy + (obj.fxBox.xy + (px / lwh()) * obj.fxBox.zw) * obj.uvRect.zw; }
// Comp px (where the buffer shows the comp; the 3D route has no world: layer px).
fn hasWorld() -> bool { return obj.world.z > 0.0; }
fn compPx(uv : vec2<f32>) -> vec2<f32> {
  if (!hasWorld()) { return layerPx(uv); }
  return obj.world.xy + fieldQ(uv) * obj.world.zw;
}
fn compUv(c : vec2<f32>) -> vec2<f32> {
  if (!hasWorld()) { return pxUv(c); }
  return obj.uvRect.xy + ((c - obj.world.xy) / obj.world.zw) * obj.uvRect.zw;
}
// A layer-px offset as a buffer-uv offset.
fn dpxUv(d : vec2<f32>) -> vec2<f32> { return d / lwh() * obj.fxBox.zw * obj.uvRect.zw; }
// Layer px per texel of the target this pass draws.
fn pxPerOut() -> vec2<f32> { return lwh() / max(obj.fxBox.zw * obj.uvRect.zw * outSize(), vec2<f32>(0.000001)); }
fn inBox(px : vec2<f32>) -> bool { return px.x >= 0.0 && px.y >= 0.0 && px.x <= lwh().x && px.y <= lwh().y; }
fn at0(uv : vec2<f32>) -> vec4<f32> { return textureSampleLevel(tex0, smp, uv, 0.0); }
fn at1(uv : vec2<f32>) -> vec4<f32> { return textureSampleLevel(tex1, smp, uv, 0.0); }
fn at2(uv : vec2<f32>) -> vec4<f32> { return textureSampleLevel(tex2, smp, uv, 0.0); }
fn at3(uv : vec2<f32>) -> vec4<f32> { return textureSampleLevel(tex3, smp, uv, 0.0); }
fn px0(px : vec2<f32>) -> vec4<f32> { return at0(pxUv(px)); }
fn px1(px : vec2<f32>) -> vec4<f32> { return at1(pxUv(px)); }
fn px2(px : vec2<f32>) -> vec4<f32> { return at2(pxUv(px)); }
fn px3(px : vec2<f32>) -> vec4<f32> { return at3(pxUv(px)); }
// The layer only: transparent outside its box.
fn boxed0(px : vec2<f32>) -> vec4<f32> { if (!inBox(px)) { return vec4<f32>(0.0); } return px0(px); }
fn texel0() -> vec2<f32> { return 1.0 / vec2<f32>(textureDimensions(tex0)); }
// A float from a data texture (DATA: one float per RGBA8 texel, 1024 a row).
fn fetchF(t : texture_2d<f32>, i : i32) -> f32 {
  let v = textureLoad(t, vec2<i32>(i % 1024, i / 1024), 0);
  let b = vec4<u32>(round(v * 255.0));
  return bitcast<f32>(b.x | (b.y << 8u) | (b.z << 16u) | (b.w << 24u));
}
fn unpremul(c : vec4<f32>) -> vec3<f32> { return select(vec3<f32>(0.0), c.rgb / c.a, c.a > 0.00001); }
fn s2l(c : f32) -> f32 { if (c <= 0.04045) { return c / 12.92; } return pow((c + 0.055) / 1.055, 2.4); }
fn l2s(c : f32) -> f32 { if (c <= 0.0031308) { return c * 12.92; } return 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055; }
fn s2l3(c : vec3<f32>) -> vec3<f32> { return vec3<f32>(s2l(c.r), s2l(c.g), s2l(c.b)); }
fn l2s3(c : vec3<f32>) -> vec3<f32> { return vec3<f32>(l2s(c.r), l2s(c.g), l2s(c.b)); }
// Premultiplied linear -> straight display (sRGB), and back.
fn toDisp(c : vec4<f32>) -> vec4<f32> { if (c.a <= 0.0) { return vec4<f32>(0.0); } return vec4<f32>(l2s3(max(c.rgb / c.a, vec3<f32>(0.0))), c.a); }
fn fromDisp(rgb : vec3<f32>, a : f32) -> vec4<f32> { return vec4<f32>(s2l3(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0))) * a, a); }
fn lumaLin(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn lumaDisp(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }
fn pcg(v : u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hcell(c : vec2<f32>, s : f32) -> f32 {
  let i = vec2<i32>(floor(c));
  return f32(pcg((u32(i.x) * 1597334677u) ^ pcg(u32(i.y) ^ (u32(i32(floor(s))) * 3812015801u))) >> 8u) / 16777216.0;
}
fn hcell2(c : vec2<f32>, s : f32) -> vec2<f32> { return vec2<f32>(hcell(c, s), hcell(c, s + 71.0)); }
fn vnoise(q : vec2<f32>, s : f32) -> f32 {
  let i = floor(q); let f = fract(q); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hcell(i, s), hcell(i + vec2<f32>(1.0, 0.0), s), u.x), mix(hcell(i + vec2<f32>(0.0, 1.0), s), hcell(i + vec2<f32>(1.0, 1.0), s), u.x), u.y);
}
fn vnoiseT(q : vec2<f32>, z : f32, s : f32) -> f32 {
  let k = floor(z); let f = fract(z); let u = f * f * (3.0 - 2.0 * f);
  return mix(vnoise(q, s + k * 131.0), vnoise(q, s + (k + 1.0) * 131.0), u);
}
fn fbmT(q0 : vec2<f32>, z : f32, s : f32, oct : i32) -> f32 {
  var sum = 0.0; var amp = 0.5; var q = q0; var norm = 0.0;
  for (var i = 0; i < oct; i++) {
    sum += amp * vnoiseT(q, z * (1.0 + f32(i) * 0.5), s + f32(i) * 17.0); norm += amp;
    q = q * 2.03 + vec2<f32>(11.7, 5.3); amp *= 0.5;
  }
  return sum / max(norm, 0.0001);
}
// 3-D value noise (seamless on any surface sampled in 3-D: the VR sphere, volumes).
fn hash3(c : vec3<f32>, s : f32) -> f32 { return hcell(c.xy + vec2<f32>(c.z * 7919.0, c.z * 104729.0), s); }
fn vnoise3(q : vec3<f32>, s : f32) -> f32 {
  let i = floor(q); let f = fract(q); let u = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(hash3(i, s), hash3(i + vec3<f32>(1.0, 0.0, 0.0), s), u.x), mix(hash3(i + vec3<f32>(0.0, 1.0, 0.0), s), hash3(i + vec3<f32>(1.0, 1.0, 0.0), s), u.x), u.y);
  let b = mix(mix(hash3(i + vec3<f32>(0.0, 0.0, 1.0), s), hash3(i + vec3<f32>(1.0, 0.0, 1.0), s), u.x), mix(hash3(i + vec3<f32>(0.0, 1.0, 1.0), s), hash3(i + vec3<f32>(1.0, 1.0, 1.0), s), u.x), u.y);
  return mix(a, b, u.z);
}
fn fbm3(q0 : vec3<f32>, s : f32, oct : i32) -> f32 {
  var sum = 0.0; var amp = 0.5; var q = q0; var norm = 0.0;
  for (var i = 0; i < oct; i++) {
    sum += amp * vnoise3(q, s + f32(i) * 17.0); norm += amp;
    q = q * 2.02 + vec3<f32>(11.7, 5.3, 2.9); amp *= 0.5;
  }
  return sum / max(norm, 0.0001);
}
fn rot2(q : vec2<f32>, a : f32) -> vec2<f32> { let c = cos(a); let s = sin(a); return vec2<f32>(c * q.x - s * q.y, s * q.x + c * q.y); }
fn rgb2hsl(c : vec3<f32>) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b));
  let l = (mx + mn) * 0.5;
  if (mx - mn < 0.00001) { return vec3<f32>(0.0, 0.0, l); }
  let d = mx - mn;
  let s = select(d / (mx + mn), d / (2.0 - mx - mn), l > 0.5);
  var h = 0.0;
  if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3<f32>(h / 6.0, s, l);
}
fn hue2rgb(pp : f32, q : f32, t0 : f32) -> f32 {
  let t = fract(t0);
  if (t < 1.0 / 6.0) { return pp + (q - pp) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return pp + (q - pp) * (2.0 / 3.0 - t) * 6.0; }
  return pp;
}
fn hsl2rgb(c : vec3<f32>) -> vec3<f32> {
  if (c.y <= 0.0) { return vec3<f32>(c.z); }
  let q = select(c.z + c.y - c.z * c.y, c.z * (1.0 + c.y), c.z < 0.5);
  let pp = 2.0 * c.z - q;
  return vec3<f32>(hue2rgb(pp, q, c.x + 1.0 / 3.0), hue2rgb(pp, q, c.x), hue2rgb(pp, q, c.x - 1.0 / 3.0));
}
fn softLight1(a : f32, b : f32) -> f32 {
  if (b <= 0.5) { return a - (1.0 - 2.0 * b) * a * (1.0 - a); }
  let d = select(sqrt(a), ((16.0 * a - 12.0) * a + 4.0) * a, a <= 0.25);
  return a + (2.0 * b - 1.0) * (d - a);
}
fn overlay1(a : f32, b : f32) -> f32 { return select(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, a < 0.5); }
// Display-space blend of b over a: 0 normal 1 multiply 2 screen 3 overlay 4 soft
// light 5 hard light 6 add 7 subtract 8 difference 9 darken 10 lighten 11 colour
// dodge 12 colour burn 13 exclusion.
fn blendMode(a : vec3<f32>, b : vec3<f32>, m : i32) -> vec3<f32> {
  switch (m) {
    case 1: { return a * b; }
    case 2: { return 1.0 - (1.0 - a) * (1.0 - b); }
    case 3: { return vec3<f32>(overlay1(a.r, b.r), overlay1(a.g, b.g), overlay1(a.b, b.b)); }
    case 4: { return vec3<f32>(softLight1(a.r, b.r), softLight1(a.g, b.g), softLight1(a.b, b.b)); }
    case 5: { return vec3<f32>(overlay1(b.r, a.r), overlay1(b.g, a.g), overlay1(b.b, a.b)); }
    case 6: { return min(a + b, vec3<f32>(1.0)); }
    case 7: { return max(a - b, vec3<f32>(0.0)); }
    case 8: { return abs(a - b); }
    case 9: { return min(a, b); }
    case 10: { return max(a, b); }
    case 11: { return min(a / max(1.0 - b, vec3<f32>(0.0001)), vec3<f32>(1.0)); }
    case 12: { return 1.0 - min((1.0 - a) / max(b, vec3<f32>(0.0001)), vec3<f32>(1.0)); }
    case 13: { return a + b - 2.0 * a * b; }
    default: { return b; }
  }
}
// Linear-light composite of an emitted light `add` (premultiplied, unbounded)
// over the premultiplied base `base`: 0 add 1 screen 2 lighten 3 light only.
fn lightOver(base : vec4<f32>, add : vec3<f32>, mode : i32) -> vec4<f32> {
  let la = clamp(max(add.r, max(add.g, add.b)), 0.0, 1.0);
  if (mode == 3) { return vec4<f32>(add, la); }
  var rgb = base.rgb + add;
  if (mode == 1) { rgb = base.rgb + add - base.rgb * clamp(add, vec3<f32>(0.0), vec3<f32>(1.0)); }
  if (mode == 2) { rgb = max(base.rgb, add); }
  return vec4<f32>(rgb, max(base.a, la));
}
// ── 360 video: equirectangular frames on the sphere ─────────────────────────
// The frame (origin px, size px) a layer px lies in: layout 0 mono, 1 stereo
// over / under, 2 stereo side by side.
fn vrFrame(px : vec2<f32>, lay : i32) -> vec4<f32> {
  let s = lwh();
  if (lay == 1) {
    let h = s.y * 0.5;
    return vec4<f32>(0.0, select(0.0, h, px.y >= h), s.x, h);
  }
  if (lay == 2) {
    let w = s.x * 0.5;
    return vec4<f32>(select(0.0, w, px.x >= w), 0.0, w, s.y);
  }
  return vec4<f32>(0.0, 0.0, s.x, s.y);
}
// Frame uv (0..1, v down) <-> unit direction (y up, z = longitude 0, x = +90 deg).
fn eqDir(q : vec2<f32>) -> vec3<f32> {
  let lon = (q.x - 0.5) * TAU;
  let lat = (0.5 - q.y) * PI;
  return vec3<f32>(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
}
fn dirEq(d : vec3<f32>) -> vec2<f32> {
  let lon = atan2(d.x, d.z);
  let lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2<f32>(lon / TAU + 0.5, 0.5 - lat / PI);
}
// A tap of `t` at frame uv `q`: across a pole the latitude reflects and the
// longitude turns half way; the seam wraps; taps stay half a texel inside.
fn vrTap(t : texture_2d<f32>, fr : vec4<f32>, q : vec2<f32>) -> vec4<f32> {
  var qq = q;
  if (qq.y < 0.0) { qq = vec2<f32>(qq.x + 0.5, -qq.y); }
  if (qq.y > 1.0) { qq = vec2<f32>(qq.x + 0.5, 2.0 - qq.y); }
  qq.x = qq.x - floor(qq.x);
  let hm = 0.5 * pxPerOut() / fr.zw;
  qq = clamp(qq, hm, vec2<f32>(1.0) - hm);
  return textureSampleLevel(t, smp, pxUv(fr.xy + qq * fr.zw), 0.0);
}
// A rotation (3 rows from p[i0]) applied to a direction.
fn rot3(d : vec3<f32>, i0 : i32) -> vec3<f32> {
  return vec3<f32>(dot(P(i0).xyz, d), dot(P(i0 + 1).xyz, d), dot(P(i0 + 2).xyz, d));
}
// ── the scene table (DATA of a 3D-aware effect, deep_fx_scene.hpp) ─────────
// [eye xyz, focal, principal xy, R rows (world -> view), comp w h], then the
// light count and 16 numbers a light. World: comp px, y down, z into the screen.
struct Cam { eye : vec3<f32>, f : f32, pp : vec2<f32>, r0 : vec3<f32>, r1 : vec3<f32>, r2 : vec3<f32>, comp : vec2<f32> };
fn camOf(t : texture_2d<f32>) -> Cam {
  return Cam(vec3<f32>(fetchF(t, 0), fetchF(t, 1), fetchF(t, 2)), fetchF(t, 3), vec2<f32>(fetchF(t, 4), fetchF(t, 5)),
             vec3<f32>(fetchF(t, 6), fetchF(t, 7), fetchF(t, 8)), vec3<f32>(fetchF(t, 9), fetchF(t, 10), fetchF(t, 11)),
             vec3<f32>(fetchF(t, 12), fetchF(t, 13), fetchF(t, 14)), vec2<f32>(fetchF(t, 15), fetchF(t, 16)));
}
// The world direction a comp px looks along.
fn camRay(c : Cam, px : vec2<f32>) -> vec3<f32> {
  let v = vec3<f32>((px.x - c.pp.x) / c.f, (px.y - c.pp.y) / c.f, 1.0);
  return normalize(v.x * c.r0 + v.y * c.r1 + v.z * c.r2);
}
// A world point -> (comp px x, y, view depth).
fn camScreen(c : Cam, p : vec3<f32>) -> vec3<f32> {
  let d = p - c.eye;
  let v = vec3<f32>(dot(c.r0, d), dot(c.r1, d), dot(c.r2, d));
  let z = max(v.z, 1.0);
  return vec3<f32>(c.pp + v.xy * c.f / z, v.z);
}
struct Light { kind : i32, pos : vec3<f32>, col : vec3<f32>, inten : f32, aim : vec3<f32>, cone : f32, feather : f32, falloff : i32, fdist : f32 };
fn lightCount(t : texture_2d<f32>) -> i32 { return min(i32(fetchF(t, 17)), 8); }
fn lightOf(t : texture_2d<f32>, k : i32) -> Light {
  let b = 18 + k * 16;
  return Light(i32(fetchF(t, b)), vec3<f32>(fetchF(t, b + 1), fetchF(t, b + 2), fetchF(t, b + 3)),
               vec3<f32>(fetchF(t, b + 4), fetchF(t, b + 5), fetchF(t, b + 6)), fetchF(t, b + 7),
               vec3<f32>(fetchF(t, b + 8), fetchF(t, b + 9), fetchF(t, b + 10)), fetchF(t, b + 11), fetchF(t, b + 12),
               i32(fetchF(t, b + 13)), fetchF(t, b + 14));
}
// The light reaching a point: (direction toward the light, attenuation x cone).
// Parallel lights shine along their aim; points and spots fall off with
// distance by their falloff (none: unattenuated, as AE), spots by their cone.
fn lightAt(l : Light, p : vec3<f32>) -> vec4<f32> {
  if (l.kind == 1) { return vec4<f32>(-l.aim, 1.0); }
  let lv = l.pos - p;
  let dist = max(length(lv), 0.001);
  let dir = lv / dist;
  var att = 1.0;
  if (l.falloff == 1) { att = 1.0 - smoothstep(0.0, max(l.fdist, 1.0), dist); }
  if (l.falloff == 2) { att = min(1.0, (max(l.fdist, 1.0) * max(l.fdist, 1.0)) / (dist * dist)); }
  if (l.kind == 3) {
    let ca = dot(-dir, l.aim);
    let outer = cos(l.cone);
    let inner = cos(l.cone * (1.0 - clamp(l.feather, 0.0, 1.0)));
    att *= smoothstep(outer, max(inner, outer + 0.0001), ca);
  }
  return vec4<f32>(dir, att);
}
// The scene depth (binding 6, view z in comp px; +inf where no 3D surface) at a buffer uv.
// Only a pass drawn with the depth flag declares `depthTex`.
// A 3- or 5-stop colour ramp in p rows (r, g, b, position): `n` stops from row `i0`.
fn ramp(t : f32, i0 : i32, n : i32) -> vec3<f32> {
  var prev = P(i0);
  if (t <= prev.w) { return prev.rgb; }
  for (var k = 1; k < n; k++) {
    let cur = P(i0 + k);
    if (t <= cur.w) { return mix(prev.rgb, cur.rgb, clamp((t - prev.w) / max(cur.w - prev.w, 0.00001), 0.0, 1.0)); }
    prev = cur;
  }
  return prev.rgb;
}
