// Paper (program F2): a paper surface generated over the layer's shape —
// tone, cloudy mottling (uneven sizing), fibres (thin streaks at two angles)
// and grain. Replaces the layer's colour where the layer is (its alpha is
// kept): put it on a solid for a washi / rice-paper ground. Layer px through fxBox.
// Rows: p0 = fibre grain mottle scale, p1 = seed 0 0 0, p2 = colour (sRGB 0..1), p3 = lw lh 0 0.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, p3: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}

fn fieldQ(uv : vec2<f32>) -> vec2<f32> { return (uv - obj.uvRect.xy) / obj.uvRect.zw; }
fn srgbToLinearChan(c : f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn hash2(p : vec2<f32>, s : f32) -> f32 {
  let q = vec2<f32>(dot(p, vec2<f32>(127.1, 311.7)) + s * 17.17, dot(p, vec2<f32>(269.5, 183.3)) - s * 9.31);
  return fract(sin(q.x + q.y * 0.137) * 43758.5453);
}
fn vnoise(p : vec2<f32>, s : f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i, s), hash2(i + vec2<f32>(1.0, 0.0), s), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0), s), hash2(i + vec2<f32>(1.0, 1.0), s), u.x), u.y);
}
fn rot(p : vec2<f32>, a : f32) -> vec2<f32> {
  let c = cos(a); let s = sin(a);
  return vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
}

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lwh = max(obj.p3.xy, vec2<f32>(1.0, 1.0));
  let pp = (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let s0 = textureSampleLevel(tex, smp, uv, 0.0);
  if (s0.a <= 0.0) { return s0; }
  let fibre = clamp(obj.p0.x, 0.0, 1.0);
  let grain = clamp(obj.p0.y, 0.0, 1.0);
  let mottle = clamp(obj.p0.z, 0.0, 1.0);
  let scale = max(obj.p0.w, 0.1);
  let seed = obj.p1.x;
  // Display-referred tone, decoded to the working (linear) space at the end.
  var tone = 1.0;
  // Mottling: uneven sizing, broad soft clouds.
  let m = vnoise(pp / (60.0 * scale), seed) * 0.6 + vnoise(pp / (23.0 * scale), seed + 5.0) * 0.4;
  tone = tone * (1.0 + mottle * (m - 0.5) * 0.22);
  // Fibres: long thin streaks at two angles, a little darker than the sheet.
  let f1 = vnoise(rot(pp, 0.35) * vec2<f32>(1.0 / (40.0 * scale), 1.0 / (1.6 * scale)), seed + 11.0);
  let f2 = vnoise(rot(pp, -0.9) * vec2<f32>(1.0 / (55.0 * scale), 1.0 / (1.3 * scale)), seed + 17.0);
  let streak = max(smoothstep(0.72, 0.92, f1), smoothstep(0.75, 0.95, f2));
  tone = tone * (1.0 - fibre * streak * 0.14);
  // Grain: per-pixel tooth.
  tone = tone * (1.0 + grain * (hash2(floor(pp), seed + 29.0) - 0.5) * 0.10);
  let col = clamp(obj.p2.rgb * tone, vec3<f32>(0.0), vec3<f32>(1.0));
  let lin = vec3<f32>(srgbToLinearChan(col.r), srgbToLinearChan(col.g), srgbToLinearChan(col.b));
  return vec4<f32>(lin * s0.a, s0.a);
}
