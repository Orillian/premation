// Ink Bleed (program F1): ink soaking into paper. The layer's ink spreads
// outward by up to `spread` px — a reach that varies with a value-noise field
// so the wet edge is irregular, not a blur — pools darker just inside the
// original edge (drying ink collects at the rim), and granulates (pigment
// settling in the paper's tooth). Layer px through fxBox, like Roughen Edges.
// Rows: p0 = spread roughness pool granulation, p1 = scale evolution seed 0, p2 = lw lh 0 0.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}

fn fieldQ(uv : vec2<f32>) -> vec2<f32> { return (uv - obj.uvRect.xy) / obj.uvRect.zw; }
fn layerUv(px : vec2<f32>, lwh : vec2<f32>) -> vec2<f32> {
  return obj.uvRect.xy + (obj.fxBox.xy + (px / lwh) * obj.fxBox.zw) * obj.uvRect.zw;
}
fn hash2(p : vec2<f32>, s : f32) -> f32 {
  let q = vec2<f32>(dot(p, vec2<f32>(127.1, 311.7)) + s * 17.17, dot(p, vec2<f32>(269.5, 183.3)) - s * 9.31);
  return fract(sin(q.x + q.y * 0.137) * 43758.5453);
}
fn vnoise(p : vec2<f32>, s : f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i, s), hash2(i + vec2<f32>(1.0, 0.0), s), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0), s), hash2(i + vec2<f32>(1.0, 1.0), s), u.x), u.y);
}
fn fbm(p : vec2<f32>, s : f32) -> f32 {
  return vnoise(p, s) * 0.5 + vnoise(p * 2.03, s + 7.0) * 0.3 + vnoise(p * 4.11, s + 13.0) * 0.2;
}

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lwh = max(obj.p2.xy, vec2<f32>(1.0, 1.0));
  let pp = (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let spread = max(obj.p0.x, 0.0);
  let rough = clamp(obj.p0.y, 0.0, 1.0);
  let pool = clamp(obj.p0.z, 0.0, 1.0);
  let gran = clamp(obj.p0.w, 0.0, 1.0);
  let scale = max(obj.p1.x, 1.0);
  let evo = obj.p1.y;
  let seed = obj.p1.z;
  let s0 = textureSampleLevel(tex, smp, uv, 0.0);
  if (spread <= 0.0 && pool <= 0.0 && gran <= 0.0) { return s0; }

  let q = pp / scale + vec2<f32>(evo * 0.013, -evo * 0.009);
  let n1 = fbm(q, seed);
  // The local wet reach: wider where the paper drinks more.
  let reach = spread * mix(1.0, 0.25 + 1.5 * n1, rough);
  // Gather: the strongest ink within reach (falling off toward its rim), and
  // how much of the near ring is still ink (edge proximity for the pool).
  var best = vec4<f32>(0.0);
  var bestW = 0.0;
  var ring = 0.0;
  for (var k = 0; k < 12; k = k + 1) {
    let ang = f32(k) * 0.5235987756 + n1 * 1.7;
    let dir = vec2<f32>(cos(ang), sin(ang));
    for (var j = 1; j <= 2; j = j + 1) {
      let rr = reach * f32(j) * 0.5;
      let t = textureSampleLevel(tex, smp, layerUv(pp + dir * rr, lwh), 0.0);
      let w = t.a * (1.0 - smoothstep(0.55, 1.0, f32(j) * 0.5));
      if (w > bestW) { bestW = w; best = t; }
      if (j == 1) { ring = ring + t.a / 12.0; }
    }
    if (reach <= 0.0) { break; }
  }
  // Bled coverage: the reach's ink, its edge broken by a finer noise.
  let n2 = fbm(q * 3.1, seed + 3.0);
  let bled = clamp(bestW * (1.0 + rough * (n2 - 0.5) * 1.6), 0.0, 1.0);
  let a = max(s0.a, bled * 0.85);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  // Colour: the layer's own where it has ink, else the ink it bled from.
  let c0 = select(best.rgb / max(best.a, 0.00001), s0.rgb / max(s0.a, 0.00001), s0.a > 0.02);
  // Pooling: inside the original shape, near its edge (the ring is not all ink).
  let edge = s0.a * clamp((1.0 - ring) * 2.0, 0.0, 1.0);
  var c = c0 * (1.0 - pool * edge * 0.75);
  // Granulation: pigment settling in the tooth, lighter specks in the wash.
  let g = vnoise(pp * 0.9, seed + 21.0);
  let alpha = a * (1.0 - gran * smoothstep(0.55, 0.95, g) * 0.55);
  c = c * (1.0 - gran * (vnoise(pp * 0.45, seed + 33.0) - 0.5) * 0.25);
  return vec4<f32>(max(c, vec3<f32>(0.0)) * alpha, alpha);
}
