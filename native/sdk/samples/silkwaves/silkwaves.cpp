// Silk Waves — a generator: layered translucent silk sheets drifting through a
// dark atmosphere under a slowly moving light, with colour that migrates
// through five worlds (deep ocean → aurora → lavender → warm horizon → liquid
// glass → ocean) and loops seamlessly over Loop Length seconds.
//
// Every time-dependent term is a function of the loop angle a = 2π·T, T in
// [0,1), so frame N of one loop equals frame N of the next: the loop is
// mathematically closed, not cross-faded. Noise drifts along a circle in its
// own domain for the same reason.
//
// GPU: one full-output WGSL pass on the engine's Dawn device (PR_CMD_SMART_RENDER_GPU).
// CPU: the same maths per pixel (PR_CMD_SMART_RENDER) — used without a GPU and
// when the host's error scope drops the GPU frame.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numbers>

#ifdef PRS_SAMPLE_GPU
#include "sample_gpu.hpp"
#endif
#include "sample_util.hpp"

namespace {

enum : uint32_t {
  kLoop = 1, kSpeed = 2, kPhase = 3, kCount = 4, kThick = 5, kAmp = 6, kDetail = 7, kFlow = 8,
  kLight = 9, kFresnel = 10, kGlow = 11, kDrift = 12, kHue = 13, kSat = 14, kBright = 15, kGrain = 16,
  kSeed = 17, kPalette = 18, kHaze = 19
};

/// Everything the shader needs, packed as 6 × vec4 (96 bytes) — the same bytes feed the GPU uniform and the CPU path.
struct Uniforms {
  std::array<float, 24> v{};
  float& at(std::size_t i) { return v.at(i); }
  [[nodiscard]] float get(std::size_t i) const { return v.at(i); }
};

constexpr double kTicksPerSecond = 705600000.0;  // PR_TIME_SCALE

Uniforms uniforms_of(const PrInData* in, PrParamDef* const* params, float w, float h) {
  Uniforms u;
  const double loop = std::max(0.5, prs::num(params, in, kLoop, 0, 60));
  const double speed = prs::num(params, in, kSpeed, 0, 1);
  const double phase = prs::num(params, in, kPhase, 0, 0) / 360.0;
  const double sec = static_cast<double>(in->comp_time) / kTicksPerSecond;
  double t = sec * speed / loop + phase;
  t -= std::floor(t);
  u.at(0) = static_cast<float>(t);
  u.at(1) = h > 0 ? w / h : 1.0F;
  u.at(2) = w;
  u.at(3) = h;
  u.at(4) = static_cast<float>(prs::num(params, in, kSeed, 0, 0));
  u.at(5) = static_cast<float>(std::clamp(prs::num(params, in, kCount, 0, 7), 1.0, 9.0));
  u.at(6) = static_cast<float>(prs::num(params, in, kThick, 0, 100) / 100);
  u.at(7) = static_cast<float>(prs::num(params, in, kAmp, 0, 100) / 100);
  u.at(8) = static_cast<float>(prs::num(params, in, kDetail, 0, 100) / 100);
  u.at(9) = static_cast<float>(prs::num(params, in, kFlow, 0, 100) / 100);
  u.at(10) = static_cast<float>(prs::num(params, in, kLight, 0, 100) / 100);
  u.at(11) = static_cast<float>(prs::num(params, in, kFresnel, 0, 100) / 100);
  u.at(12) = static_cast<float>(prs::num(params, in, kGlow, 0, 100) / 100);
  u.at(13) = static_cast<float>(prs::num(params, in, kDrift, 0, 100) / 100);
  u.at(14) = static_cast<float>(prs::num(params, in, kGrain, 0, 40) / 100);
  u.at(15) = static_cast<float>(prs::num(params, in, kHue, 0, 0) / 360.0);
  u.at(16) = static_cast<float>(prs::num(params, in, kSat, 0, 100) / 100);
  u.at(17) = static_cast<float>(prs::num(params, in, kBright, 0, 100) / 100);
  u.at(18) = static_cast<float>(prs::num(params, in, kPalette, 0, 1));  // 1 = journey, 2..6 = one world
  u.at(19) = static_cast<float>(prs::num(params, in, kHaze, 0, 100) / 100);
  return u;
}

// ───────────────────────────── WGSL (GPU) ─────────────────────────────
constexpr const char* kWgsl = R"(
struct U { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f, f: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: U;
const PI = 3.14159265359;
const TAU = 6.28318530718;

fn mod289v3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v4(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute(x: vec4f) -> vec4f { return mod289v4(((x * 34.0) + 1.0) * x); }
fn taylorInvSqrt(r: vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }
fn snoise(v: vec3f) -> f32 {
  let C = vec2f(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4f(0.0, 0.5, 1.0, 2.0);
  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);
  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);
  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;
  i = mod289v3(i);
  let p = permute(permute(permute(i.z + vec4f(0.0, i1.z, i2.z, 1.0)) + i.y + vec4f(0.0, i1.y, i2.y, 1.0)) + i.x + vec4f(0.0, i1.x, i2.x, 1.0));
  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;
  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = 1.0 - abs(x) - abs(y);
  let b0 = vec4f(x.xy, y.xy);
  let b1 = vec4f(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4f(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;
  var p0 = vec3f(a0.xy, h.x);
  var p1 = vec3f(a0.zw, h.y);
  var p2 = vec3f(a1.xy, h.z);
  var p3 = vec3f(a1.zw, h.w);
  let norm = taylorInvSqrt(vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 = p0 * norm.x; p1 = p1 * norm.y; p2 = p2 * norm.z; p3 = p3 * norm.w;
  var m = max(0.6 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
fn fbm(p0: vec3f) -> f32 {
  var p = p0; var a = 0.5; var s = 0.0;
  for (var i = 0; i < 4; i++) { s += a * snoise(p); p = p * 2.03 + vec3f(17.1, 9.3, 3.7); a *= 0.5; }
  return s;
}
var<private> PAL: array<vec3f, 20> = array<vec3f, 20>(
  vec3f(0.024,0.075,0.161), vec3f(0.043,0.310,0.424), vec3f(0.106,0.639,0.639), vec3f(0.498,0.902,0.878),
  vec3f(0.027,0.141,0.122), vec3f(0.055,0.478,0.373), vec3f(0.243,0.863,0.627), vec3f(0.749,1.000,0.890),
  vec3f(0.102,0.082,0.251), vec3f(0.416,0.353,0.804), vec3f(0.722,0.643,1.000), vec3f(1.000,0.820,0.941),
  vec3f(0.106,0.078,0.188), vec3f(0.541,0.310,0.427), vec3f(0.914,0.655,0.486), vec3f(1.000,0.890,0.722),
  vec3f(0.059,0.102,0.165), vec3f(0.290,0.416,0.541), vec3f(0.663,0.812,0.910), vec3f(0.957,0.973,1.000));
struct Pal { d: vec3f, m: vec3f, l: vec3f, h: vec3f };
fn palette(uIn: f32) -> Pal {
  var uu = uIn;
  if (u.e.z >= 2.0) { uu = u.e.z - 2.0; }            // a fixed world
  uu = uu - floor(uu / 5.0) * 5.0;
  let i = floor(uu); var f = uu - i;
  f = f * f * (3.0 - 2.0 * f); f = f * f * (3.0 - 2.0 * f);
  let a = i32(i); let b = (a + 1) % 5;
  var o: Pal;
  o.d = mix(PAL[a * 4 + 0], PAL[b * 4 + 0], f); o.m = mix(PAL[a * 4 + 1], PAL[b * 4 + 1], f);
  o.l = mix(PAL[a * 4 + 2], PAL[b * 4 + 2], f); o.h = mix(PAL[a * 4 + 3], PAL[b * 4 + 3], f);
  return o;
}
var<private> RA: array<vec4f, 9> = array<vec4f, 9>(   // y0, amp, freq, spd
  vec4f(-0.26, 0.12, 1.1, 1.0), vec4f(0.30, 0.14, 0.8, 1.0), vec4f(-0.02, 0.13, 1.5, 2.0), vec4f(-0.44, 0.16, 0.9, 2.0),
  vec4f(0.14, 0.10, 1.9, 1.0), vec4f(0.46, 0.15, 0.7, 1.0), vec4f(-0.30, 0.11, 1.3, 3.0), vec4f(0.08, 0.09, 1.2, 2.0), vec4f(-0.14, 0.12, 1.0, 1.0));
var<private> RB: array<vec4f, 9> = array<vec4f, 9>(   // th, ns, seed, depth
  vec4f(0.24, 0.50, 1.3, 0.95), vec4f(0.20, 0.45, 2.7, 0.84), vec4f(0.12, 0.70, 4.1, 0.68), vec4f(0.17, 0.60, 7.2, 0.52),
  vec4f(0.06, 0.90, 8.8, 0.36), vec4f(0.15, 0.55, 11.3, 0.20), vec4f(0.08, 0.80, 12.9, 0.06), vec4f(0.10, 0.75, 14.2, 0.44), vec4f(0.13, 0.60, 15.7, 0.30));
fn hueRotate(c: vec3f, t: f32) -> vec3f {
  let ang = t * TAU; let cs = cos(ang); let sn = sin(ang);
  let k = (1.0 - cs) / 3.0; let s = sn / sqrt(3.0); let sum = c.r + c.g + c.b;
  return vec3f(cs * c.r + k * sum + s * (c.b - c.g), cs * c.g + k * sum + s * (c.r - c.b), cs * c.b + k * sum + s * (c.g - c.r));
}
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn yc(xx: f32, r0: vec4f, r1: vec4f, a: f32, cir: vec2f, tilt: f32, amp: f32, detail: f32) -> f32 {
  return r0.x + 0.05 * sin(a + r1.z) + tilt * xx
    + amp * r0.y * sin(r0.z * xx + r0.w * a + r1.z)
    + amp * 0.025 * sin(r0.z * 2.1 * xx - 2.0 * r0.w * a + r1.z * 2.0)
    + detail * 0.16 * fbm(vec3f(xx * r1.y + cir.x, r1.z * 0.37 + cir.y, xx * 0.2 + r1.z));
}
fn scene(px: vec2f) -> vec3f {
  let T = u.a.x; let asp = u.a.y; let R = u.a.zw;
  let seed = u.b.x; let count = i32(u.b.y); let thick = u.b.z; let amp = u.b.w;
  let detail = u.c.x; let flow = u.c.y; let light = u.c.z; let fresnelK = u.c.w;
  let glow = u.d.x; let drift = u.d.y; let hue = u.d.w; let haze = u.e.w;
  let a = T * TAU;
  let uv = px / R;
  var c = vec2f(uv.x - 0.5, 0.5 - uv.y) * vec2f(asp, 1.0);
  c = c * (1.0 + 0.018 * drift * sin(a));
  c = c + 0.012 * drift * vec2f(sin(a + 1.3), 0.6 * cos(2.0 * a + 0.4));
  c.x = c.x + 0.02 * drift * sin(a) * c.y;
  let Ld = normalize(vec3f(0.9 * cos(a + 0.6), 0.45 + 0.35 * sin(a + 2.0), 0.75));
  let lp = vec2f(0.5 * asp + 0.45 * cos(a + 0.6), 0.1 + 0.25 * sin(a + 2.0));
  let basePhase = T * 5.0 + seed * 0.37;
  let P = palette(basePhase + 0.08 * c.y);
  let vgrad = smoothstep(-0.7, 0.9, c.y);
  var col = mix(P.d * 0.30, P.d * 0.95, vgrad);
  let dl = length(c - lp);
  col += P.m * 0.22 * light * exp(-dl * dl * 2.2);
  col += P.l * 0.05 * light * exp(-dl * dl * 0.6);
  let hz = fbm(vec3f(c * 1.2 + 0.4 * vec2f(cos(a), sin(a)), 3.3 + seed));
  col += P.m * 0.06 * haze * (hz + 0.5);
  for (var k = 0; k < 9; k++) {
    if (k >= count) { break; }
    let r0 = RA[k]; let r1 = RB[k] + vec4f(0.0, 0.0, seed * 1.7, 0.0);
    let sp = r0.w;
    let cir = 0.8 * flow * vec2f(cos(sp * a + r1.z), sin(sp * a + r1.z));
    let x = c.x;
    let tilt = 0.22 * sin(a + r1.z * 1.3) + 0.08 * sin(2.0 * a + r1.z);
    let y0 = yc(x, r0, r1, a, cir, tilt, amp, detail);
    let y1 = yc(x + 0.006, r0, r1, a, cir, tilt, amp, detail);
    let slope = (y1 - y0) / 0.006;
    var th = thick * r1.x * (0.6 + 0.5 * fbm(vec3f(x * 0.7 + cir.y * 0.6, r1.z * 1.1 - cir.x * 0.6, 1.7)));
    th = th * (1.0 + 0.18 * sin(a + r1.z * 1.7));
    let d = c.y - y0;
    var nd = d / th;
    let depth = r1.w;
    let feather = mix(0.10, 0.45, depth);
    let inside = 1.0 - smoothstep(1.0 - feather, 1.0 + feather * 0.4, abs(nd));
    // soft halo past the edge (the bloom of the luminous rim), computed analytically
    let halo = exp(-max(abs(nd) - 1.0, 0.0) * 4.0) * (1.0 - inside) * glow * 0.10 * (1.0 - depth);
    let P2 = palette(basePhase + 0.20 * x + 0.22 * depth - 0.06 * clamp(nd, -1.0, 1.0));
    if (inside <= 0.001) { col += P2.l * halo * light; continue; }
    nd = clamp(nd, -1.0, 1.0);
    let n = normalize(vec3f(-slope * 0.9, 0.35 * nd, 1.0));
    let V = vec3f(0.0, 0.0, 1.0);
    let diff = clamp(0.22 + 0.78 * dot(n, Ld), 0.0, 1.0) * light;
    let H = normalize(Ld + V);
    let spec = pow(max(dot(n, H), 0.0), 40.0) * light;
    let edge = smoothstep(0.45, 1.0, abs(nd)) * fresnelK;
    let fold = 0.5 + 0.5 * sin(x * 2.0 * r0.z + 2.5 * fbm(vec3f(x * 1.5 + cir.x, nd * 0.6 + r1.z, cir.y)) + sp * a);
    let lx = 0.8 * asp * cos(a + r1.z * 0.9);
    let travel = exp(-pow((x - lx) / 0.55, 2.0));
    var rc = mix(P2.d, P2.m, clamp(diff, 0.0, 1.0));
    rc = rc * (0.96 + 0.04 * fold);
    rc = mix(rc, P2.l, clamp(0.50 * edge + 0.35 * spec + 0.25 * travel * edge, 0.0, 1.0));
    rc += P2.h * spec * 0.45 * (0.5 + 0.5 * (1.0 - depth));
    rc += P2.l * 0.12 * travel * (0.4 + 0.6 * diff);
    rc = mix(rc, P.d * 1.15 + P.m * 0.15, 0.55 * haze * depth * depth);
    let alpha = inside * (0.40 + 0.45 * (1.0 - abs(nd))) * (0.40 + 0.60 * (1.0 - depth));
    col = mix(col, rc, alpha);
    let rim = exp(-pow((abs(nd) - 0.93) / 0.05, 2.0)) * inside;
    col += P2.l * rim * 0.12 * glow * (0.3 + 0.7 * diff) * (0.4 + 0.6 * (1.0 - depth));
  }
  let vig = smoothstep(1.35, 0.35, length((uv - 0.5) * vec2f(1.0, 1.15)));
  col = col * (0.78 + 0.22 * vig);
  // finish: hue / saturation / brightness, filmic shoulder, dither
  col = hueRotate(col, hue);
  let lum = dot(col, vec3f(0.299, 0.587, 0.114));
  col = (vec3f(lum) + (col - vec3f(lum)) * u.e.x) * u.e.y;
  col = col / (1.0 + col * 0.35);
  col = pow(max(col, vec3f(0.0)), vec3f(0.96));
  let nse = hash(px + T * 7.0) + hash(px * 1.7 - T * 3.0) - 1.0;
  col += nse * (1.2 / 255.0 + u.d.z * 0.02);
  return clamp(col, vec3f(0.0), vec3f(1.0));
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let srcA = textureLoad(src, vec2i(pos.xy), 0).a;
  let c = scene(pos.xy);
  let lin = pow(c, vec3f(2.2));            // the palette is display-referred; the world is linear light
  return vec4f(lin * srcA, srcA);
}
)";

// ───────────────────────────── CPU path (the same maths) ─────────────────────────────
struct V3 { float x = 0, y = 0, z = 0; };
struct V4 { float x = 0, y = 0, z = 0, w = 0; };
inline V3 add(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 sub(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 mul(V3 a, float k) { return {a.x * k, a.y * k, a.z * k}; }
inline float dot3(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline float dot4(V4 a, V4 b) { return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w; }
inline V3 mix3(V3 a, V3 b, float t) { return add(mul(a, 1 - t), mul(b, t)); }
inline V3 floor3(V3 a) { return {std::floor(a.x), std::floor(a.y), std::floor(a.z)}; }
inline V4 floor4(V4 a) { return {std::floor(a.x), std::floor(a.y), std::floor(a.z), std::floor(a.w)}; }
inline V4 add4(V4 a, V4 b) { return {a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w}; }
inline V4 sub4(V4 a, V4 b) { return {a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w}; }
inline V4 mul4(V4 a, float k) { return {a.x * k, a.y * k, a.z * k, a.w * k}; }
inline V4 mulv4(V4 a, V4 b) { return {a.x * b.x, a.y * b.y, a.z * b.z, a.w * b.w}; }
inline V4 adds4(V4 a, float k) { return {a.x + k, a.y + k, a.z + k, a.w + k}; }
inline float stepf(float e, float x) { return x < e ? 0.0F : 1.0F; }
inline float clampf(float v, float lo, float hi) { return std::min(std::max(v, lo), hi); }
inline float smoothstepf(float e0, float e1, float x) { const float t = clampf((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
inline float mixf(float a, float b, float t) { return a + (b - a) * t; }
inline float fractf(float v) { return v - std::floor(v); }
inline V3 normalize3(V3 a) { const float l = std::sqrt(dot3(a, a)); return l > 0 ? mul(a, 1 / l) : a; }
inline V3 mod289(V3 x) { return sub(x, mul(floor3(mul(x, 1.0F / 289.0F)), 289.0F)); }
inline V4 mod289(V4 x) { return sub4(x, mul4(floor4(mul4(x, 1.0F / 289.0F)), 289.0F)); }
inline V4 permute(V4 x) { return mod289(mulv4(adds4(mul4(x, 34.0F), 1.0F), x)); }
inline V4 taylorInvSqrt(V4 r) { return adds4(mul4(r, -0.85373472095314F), 1.79284291400159F); }

float snoise(V3 v) {
  const V3 Cxxx{1.0F / 6, 1.0F / 6, 1.0F / 6};
  const V3 Cyyy{1.0F / 3, 1.0F / 3, 1.0F / 3};
  const V3 Dyyy{0.5F, 0.5F, 0.5F};
  V3 i = floor3(add(v, V3{dot3(v, Cyyy), dot3(v, Cyyy), dot3(v, Cyyy)}));
  const V3 x0 = add(sub(v, i), V3{dot3(i, Cxxx), dot3(i, Cxxx), dot3(i, Cxxx)});
  const V3 g{stepf(x0.y, x0.x), stepf(x0.z, x0.y), stepf(x0.x, x0.z)};
  const V3 l{1 - g.x, 1 - g.y, 1 - g.z};
  const V3 i1{std::min(g.x, l.z), std::min(g.y, l.x), std::min(g.z, l.y)};
  const V3 i2{std::max(g.x, l.z), std::max(g.y, l.x), std::max(g.z, l.y)};
  const V3 x1 = add(sub(x0, i1), Cxxx);
  const V3 x2 = add(sub(x0, i2), Cyyy);
  const V3 x3 = sub(x0, Dyyy);
  i = mod289(i);
  const V4 q0 = permute(adds4(V4{0, i1.z, i2.z, 1}, i.z));
  const V4 q1 = permute(add4(adds4(q0, i.y), V4{0, i1.y, i2.y, 1}));
  const V4 pp = permute(add4(adds4(q1, i.x), V4{0, i1.x, i2.x, 1}));
  const float n_ = 0.142857142857F;
  const V3 ns{n_ * 2.0F - 0.0F, n_ * 0.5F - 1.0F, n_ * 1.0F - 0.0F};  // n_*D.wyz - D.xzx = (2n, 0.5n-1, n)
  const V4 j = sub4(pp, mul4(floor4(mul4(pp, ns.z * ns.z)), 49.0F));
  const V4 x_ = floor4(mul4(j, ns.z));
  const V4 y_ = floor4(sub4(j, mul4(x_, 7.0F)));
  const V4 x = adds4(mul4(x_, ns.x), ns.y);
  const V4 y = adds4(mul4(y_, ns.x), ns.y);
  const V4 h{1 - std::abs(x.x) - std::abs(y.x), 1 - std::abs(x.y) - std::abs(y.y), 1 - std::abs(x.z) - std::abs(y.z), 1 - std::abs(x.w) - std::abs(y.w)};
  const V4 b0{x.x, x.y, y.x, y.y};
  const V4 b1{x.z, x.w, y.z, y.w};
  const V4 s0 = adds4(mul4(floor4(b0), 2.0F), 1.0F);
  const V4 s1 = adds4(mul4(floor4(b1), 2.0F), 1.0F);
  const V4 sh{-stepf(0, h.x), -stepf(0, h.y), -stepf(0, h.z), -stepf(0, h.w)};
  const V4 a0{b0.x + s0.x * sh.x, b0.z + s0.z * sh.x, b0.y + s0.y * sh.y, b0.w + s0.w * sh.y};
  const V4 a1{b1.x + s1.x * sh.z, b1.z + s1.z * sh.z, b1.y + s1.y * sh.w, b1.w + s1.w * sh.w};
  V3 p0{a0.x, a0.y, h.x};
  V3 p1{a0.z, a0.w, h.y};
  V3 p2{a1.x, a1.y, h.z};
  V3 p3{a1.z, a1.w, h.w};
  const V4 norm = taylorInvSqrt(V4{dot3(p0, p0), dot3(p1, p1), dot3(p2, p2), dot3(p3, p3)});
  p0 = mul(p0, norm.x); p1 = mul(p1, norm.y); p2 = mul(p2, norm.z); p3 = mul(p3, norm.w);
  V4 m{std::max(0.6F - dot3(x0, x0), 0.0F), std::max(0.6F - dot3(x1, x1), 0.0F), std::max(0.6F - dot3(x2, x2), 0.0F), std::max(0.6F - dot3(x3, x3), 0.0F)};
  m = mulv4(m, m);
  return 42.0F * dot4(mulv4(m, m), V4{dot3(p0, x0), dot3(p1, x1), dot3(p2, x2), dot3(p3, x3)});
}
float fbm(V3 p) {
  float a = 0.5F, s = 0;
  for (int i = 0; i < 4; ++i) { s += a * snoise(p); p = add(mul(p, 2.03F), V3{17.1F, 9.3F, 3.7F}); a *= 0.5F; }
  return s;
}
constexpr std::array<V3, 20> kPal{{
  {0.024F,0.075F,0.161F}, {0.043F,0.310F,0.424F}, {0.106F,0.639F,0.639F}, {0.498F,0.902F,0.878F},
  {0.027F,0.141F,0.122F}, {0.055F,0.478F,0.373F}, {0.243F,0.863F,0.627F}, {0.749F,1.000F,0.890F},
  {0.102F,0.082F,0.251F}, {0.416F,0.353F,0.804F}, {0.722F,0.643F,1.000F}, {1.000F,0.820F,0.941F},
  {0.106F,0.078F,0.188F}, {0.541F,0.310F,0.427F}, {0.914F,0.655F,0.486F}, {1.000F,0.890F,0.722F},
  {0.059F,0.102F,0.165F}, {0.290F,0.416F,0.541F}, {0.663F,0.812F,0.910F}, {0.957F,0.973F,1.000F}}};
constexpr std::array<V4, 9> kRA{{{-0.26F,0.12F,1.1F,1}, {0.30F,0.14F,0.8F,1}, {-0.02F,0.13F,1.5F,2}, {-0.44F,0.16F,0.9F,2},
  {0.14F,0.10F,1.9F,1}, {0.46F,0.15F,0.7F,1}, {-0.30F,0.11F,1.3F,3}, {0.08F,0.09F,1.2F,2}, {-0.14F,0.12F,1.0F,1}}};
constexpr std::array<V4, 9> kRB{{{0.24F,0.50F,1.3F,0.95F}, {0.20F,0.45F,2.7F,0.84F}, {0.12F,0.70F,4.1F,0.68F}, {0.17F,0.60F,7.2F,0.52F},
  {0.06F,0.90F,8.8F,0.36F}, {0.15F,0.55F,11.3F,0.20F}, {0.08F,0.80F,12.9F,0.06F}, {0.10F,0.75F,14.2F,0.44F}, {0.13F,0.60F,15.7F,0.30F}}};
struct Pal { V3 d, m, l, h; };
Pal palette(const Uniforms& u, float uIn) {
  float uu = uIn;
  if (u.get(18) >= 2.0F) uu = u.get(18) - 2.0F;
  uu = uu - std::floor(uu / 5.0F) * 5.0F;
  const float i = std::floor(uu);
  float f = uu - i;
  f = f * f * (3 - 2 * f); f = f * f * (3 - 2 * f);
  const std::size_t a = static_cast<std::size_t>(i);
  const std::size_t b = (a + 1) % 5;
  return {mix3(kPal.at(a * 4), kPal.at(b * 4), f), mix3(kPal.at(a * 4 + 1), kPal.at(b * 4 + 1), f),
          mix3(kPal.at(a * 4 + 2), kPal.at(b * 4 + 2), f), mix3(kPal.at(a * 4 + 3), kPal.at(b * 4 + 3), f)};
}
V3 hueRotate(V3 c, float t) {
  const float ang = t * 2.0F * std::numbers::pi_v<float>;
  const float cs = std::cos(ang), sn = std::sin(ang);
  const float k = (1 - cs) / 3, s = sn / std::sqrt(3.0F), sum = c.x + c.y + c.z;
  return {cs * c.x + k * sum + s * (c.z - c.y), cs * c.y + k * sum + s * (c.x - c.z), cs * c.z + k * sum + s * (c.y - c.x)};
}
float hashf(float px, float py) { return fractf(std::sin(px * 12.9898F + py * 78.233F) * 43758.5453F); }
float ycf(float xx, V4 r0, V4 r1, float a, float cx, float cy, float tilt, float amp, float detail) {
  return r0.x + 0.05F * std::sin(a + r1.z) + tilt * xx + amp * r0.y * std::sin(r0.z * xx + r0.w * a + r1.z) +
         amp * 0.025F * std::sin(r0.z * 2.1F * xx - 2.0F * r0.w * a + r1.z * 2.0F) +
         detail * 0.16F * fbm(V3{xx * r1.y + cx, r1.z * 0.37F + cy, xx * 0.2F + r1.z});
}
V3 scene(const Uniforms& u, float pxx, float pxy) {
  constexpr float TAU = 6.28318530718F;
  const float T = u.get(0), asp = u.get(1), Rw = u.get(2), Rh = u.get(3);
  const float seed = u.get(4); const int count = static_cast<int>(u.get(5)); const float thick = u.get(6), amp = u.get(7);
  const float detail = u.get(8), flow = u.get(9), light = u.get(10), fresnelK = u.get(11);
  const float glow = u.get(12), drift = u.get(13), hue = u.get(15), haze = u.get(19);
  const float a = T * TAU;
  const float uvx = pxx / Rw, uvy = pxy / Rh;
  float cx = (uvx - 0.5F) * asp, cy = (0.5F - uvy);
  const float br = 1.0F + 0.018F * drift * std::sin(a);
  cx *= br; cy *= br;
  cx += 0.012F * drift * std::sin(a + 1.3F); cy += 0.012F * drift * 0.6F * std::cos(2.0F * a + 0.4F);
  cx += 0.02F * drift * std::sin(a) * cy;
  const V3 Ld = normalize3({0.9F * std::cos(a + 0.6F), 0.45F + 0.35F * std::sin(a + 2.0F), 0.75F});
  const float lpx = 0.5F * asp + 0.45F * std::cos(a + 0.6F), lpy = 0.1F + 0.25F * std::sin(a + 2.0F);
  const float basePhase = T * 5.0F + seed * 0.37F;
  const Pal P = palette(u, basePhase + 0.08F * cy);
  const float vgrad = smoothstepf(-0.7F, 0.9F, cy);
  V3 col = mix3(mul(P.d, 0.30F), mul(P.d, 0.95F), vgrad);
  const float dl2 = (cx - lpx) * (cx - lpx) + (cy - lpy) * (cy - lpy);
  col = add(col, mul(P.m, 0.22F * light * std::exp(-dl2 * 2.2F)));
  col = add(col, mul(P.l, 0.05F * light * std::exp(-dl2 * 0.6F)));
  const float hz = fbm(V3{cx * 1.2F + 0.4F * std::cos(a), cy * 1.2F + 0.4F * std::sin(a), 3.3F + seed});
  col = add(col, mul(P.m, 0.06F * haze * (hz + 0.5F)));
  for (int k = 0; k < 9 && k < count; ++k) {
    const V4 r0 = kRA.at(static_cast<std::size_t>(k));
    V4 r1 = kRB.at(static_cast<std::size_t>(k));
    r1.z += seed * 1.7F;
    const float sp = r0.w;
    const float cirx = 0.8F * flow * std::cos(sp * a + r1.z), ciry = 0.8F * flow * std::sin(sp * a + r1.z);
    const float x = cx;
    const float tilt = 0.22F * std::sin(a + r1.z * 1.3F) + 0.08F * std::sin(2.0F * a + r1.z);
    const float y0 = ycf(x, r0, r1, a, cirx, ciry, tilt, amp, detail);
    const float y1 = ycf(x + 0.006F, r0, r1, a, cirx, ciry, tilt, amp, detail);
    const float slope = (y1 - y0) / 0.006F;
    float th = thick * r1.x * (0.6F + 0.5F * fbm(V3{x * 0.7F + ciry * 0.6F, r1.z * 1.1F - cirx * 0.6F, 1.7F}));
    th *= 1.0F + 0.18F * std::sin(a + r1.z * 1.7F);
    const float d = cy - y0;
    float nd = d / th;
    const float depth = r1.w;
    const float feather = mixf(0.10F, 0.45F, depth);
    const float inside = 1.0F - smoothstepf(1.0F - feather, 1.0F + feather * 0.4F, std::abs(nd));
    const float halo = std::exp(-std::max(std::abs(nd) - 1.0F, 0.0F) * 4.0F) * (1.0F - inside) * glow * 0.10F * (1.0F - depth);
    const Pal P2 = palette(u, basePhase + 0.20F * x + 0.22F * depth - 0.06F * clampf(nd, -1, 1));
    if (inside <= 0.001F) { col = add(col, mul(P2.l, halo * light)); continue; }
    nd = clampf(nd, -1, 1);
    const V3 n = normalize3({-slope * 0.9F, 0.35F * nd, 1.0F});
    const float diff = clampf(0.22F + 0.78F * dot3(n, Ld), 0, 1) * light;
    const V3 H = normalize3(add(Ld, V3{0, 0, 1}));
    const float spec = std::pow(std::max(dot3(n, H), 0.0F), 40.0F) * light;
    const float edge = smoothstepf(0.45F, 1.0F, std::abs(nd)) * fresnelK;
    const float fold = 0.5F + 0.5F * std::sin(x * 2.0F * r0.z + 2.5F * fbm(V3{x * 1.5F + cirx, nd * 0.6F + r1.z, ciry}) + sp * a);
    const float lx = 0.8F * asp * std::cos(a + r1.z * 0.9F);
    const float travel = std::exp(-std::pow((x - lx) / 0.55F, 2.0F));
    V3 rc = mix3(P2.d, P2.m, clampf(diff, 0, 1));
    rc = mul(rc, 0.96F + 0.04F * fold);
    rc = mix3(rc, P2.l, clampf(0.50F * edge + 0.35F * spec + 0.25F * travel * edge, 0, 1));
    rc = add(rc, mul(P2.h, spec * 0.45F * (0.5F + 0.5F * (1.0F - depth))));
    rc = add(rc, mul(P2.l, 0.12F * travel * (0.4F + 0.6F * diff)));
    rc = mix3(rc, add(mul(P.d, 1.15F), mul(P.m, 0.15F)), 0.55F * haze * depth * depth);
    const float alpha = inside * (0.40F + 0.45F * (1.0F - std::abs(nd))) * (0.40F + 0.60F * (1.0F - depth));
    col = mix3(col, rc, alpha);
    const float rim = std::exp(-std::pow((std::abs(nd) - 0.93F) / 0.05F, 2.0F)) * inside;
    col = add(col, mul(P2.l, rim * 0.12F * glow * (0.3F + 0.7F * diff) * (0.4F + 0.6F * (1.0F - depth))));
  }
  const float vx = (uvx - 0.5F), vy = (uvy - 0.5F) * 1.15F;
  const float vig = smoothstepf(1.35F, 0.35F, std::sqrt(vx * vx + vy * vy));
  col = mul(col, 0.78F + 0.22F * vig);
  col = hueRotate(col, hue);
  const float lum = 0.299F * col.x + 0.587F * col.y + 0.114F * col.z;
  col = mul(add(V3{lum, lum, lum}, mul(sub(col, V3{lum, lum, lum}), u.get(16))), u.get(17));
  col = {col.x / (1 + col.x * 0.35F), col.y / (1 + col.y * 0.35F), col.z / (1 + col.z * 0.35F)};
  col = {std::pow(std::max(col.x, 0.0F), 0.96F), std::pow(std::max(col.y, 0.0F), 0.96F), std::pow(std::max(col.z, 0.0F), 0.96F)};
  const float nse = hashf(pxx + T * 7.0F, pxy + T * 7.0F) + hashf(pxx * 1.7F - T * 3.0F, pxy * 1.7F - T * 3.0F) - 1.0F;
  const float dz = nse * (1.2F / 255.0F + u.get(14) * 0.02F);
  col = {clampf(col.x + dz, 0, 1), clampf(col.y + dz, 0, 1), clampf(col.z + dz, 0, 1)};
  return col;
}

PrErr cpu_render(const PrInData* in, PrOutData* /*out*/, PrParamDef* const* params) {
  PrWorld* src = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const Uniforms u = uniforms_of(in, params, static_cast<float>(dst->width), static_cast<float>(dst->height));
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      const float sa = src != nullptr ? prs::read(*src, x, y).a : 1.0F;
      const V3 c = scene(u, static_cast<float>(x) + 0.5F, static_cast<float>(y) + 0.5F);
      prs::write(*dst, x, y, {std::pow(c.x, 2.2F) * sa, std::pow(c.y, 2.2F) * sa, std::pow(c.z, 2.2F) * sa, sa});
    }
  };
  return prs::for_rows(in, dst->height, row);
}

#ifdef PRS_SAMPLE_GPU
PrErr gpu_render(const PrInData* in, PrOutData* /*out*/, PrParamDef* const* params, PrSmartRenderGpuExtra* x) {
  const prs::gpu::State* st = prs::gpu::state_of(in, x->gpu_data);
  if (st == nullptr || x->input == nullptr || x->output == nullptr) return PR_ERR_INVALID_PARAM;
  const Uniforms u = uniforms_of(in, params, static_cast<float>(x->output->width), static_cast<float>(x->output->height));
  const std::array<const PrGpuWorld*, 1> textures{x->input};
  prs::gpu::draw(*st, x, textures, u.v);
  return PR_ERR_NONE;
}
#endif

PrErr PR_CALL silk_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/, void* extra) {
  switch (cmd) {
    case PR_CMD_ABOUT:
      prs::message(out, "Silk Waves 1.0 — layered silk sheets, drifting light and migrating colour; a seamless loop over Loop Length.");
      return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_GENERATOR | PR_OUT_FLAG_NON_PARAM_VARY | PR_OUT_FLAG_THREADED_RENDER
#ifdef PRS_SAMPLE_GPU
                       | PR_OUT_FLAG_GPU_RENDER
#endif
          ;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: {
      PrErr e = prs::add_simple(in, PR_PARAM_GROUP_START, 100, "Loop", {});
      if (e == PR_ERR_NONE) e = prs::add_float(in, kLoop, "Loop Length (s)", 60, 0.5, 3600, 5, 180, 1);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kSpeed, "Speed", 1, 0, 20, 0, 4, 2);
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_ANGLE, kPhase, "Phase", {0, 0, 0, 0});
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_END, 101, "", {});
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_START, 102, "Waves", {});
      if (e == PR_ERR_NONE) e = prs::add_float(in, kCount, "Count", 7, 1, 9, 1, 9, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kThick, "Thickness %", 100, 10, 400, 20, 250, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kAmp, "Amplitude %", 100, 0, 400, 0, 250, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kDetail, "Detail %", 100, 0, 300, 0, 200, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kFlow, "Flow %", 100, 0, 400, 0, 300, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kSeed, "Seed", 0, 0, 1000, 0, 100, 0);
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_END, 103, "", {});
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_START, 104, "Light", {});
      if (e == PR_ERR_NONE) e = prs::add_float(in, kLight, "Light %", 100, 0, 400, 0, 300, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kFresnel, "Edge Glow %", 100, 0, 300, 0, 200, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kGlow, "Bloom %", 100, 0, 300, 0, 200, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kHaze, "Depth Haze %", 100, 0, 200, 0, 200, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kDrift, "Camera Drift %", 100, 0, 300, 0, 200, 0);
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_END, 105, "", {});
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_START, 106, "Color", {});
      if (e == PR_ERR_NONE)
        e = prs::add_simple(in, PR_PARAM_POPUP, kPalette, "Palette", {1, 0, 0, 0}, 0,
                            "Journey (Ocean → Glass)|Deep Ocean|Aurora|Lavender Dream|Warm Horizon|Liquid Glass");
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_ANGLE, kHue, "Hue Shift", {0, 0, 0, 0});
      if (e == PR_ERR_NONE) e = prs::add_float(in, kSat, "Saturation %", 100, 0, 300, 0, 200, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kBright, "Brightness %", 100, 0, 300, 0, 200, 0);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kGrain, "Grain %", 40, 0, 200, 0, 100, 0);
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_END, 107, "", {});
      return e;
    }
    case PR_CMD_SMART_PRE_RENDER: return in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
    case PR_CMD_SMART_RENDER: return cpu_render(in, out, params);
#ifdef PRS_SAMPLE_GPU
    case PR_CMD_GPU_DEVICE_SETUP: return prs::gpu::setup(in, static_cast<PrGpuDeviceSetupExtra*>(extra), kWgsl, "silkwaves", 96);
    case PR_CMD_GPU_DEVICE_SETDOWN: return prs::gpu::setdown(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_SMART_RENDER_GPU: return gpu_render(in, out, params, static_cast<PrSmartRenderGpuExtra*>(extra));
#endif
    default: (void)extra; return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.silkwaves", &silk_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.silkwaves", 1, kEffects, 0, nullptr, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
