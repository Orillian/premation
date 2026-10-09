// Ink Splatter (program F3): seeded ink splats around a centre — each a
// wobbly blob with satellite droplets thrown outward along a ray — the flick
// of a loaded brush. `reveal` grows them in (0..1, animatable: the splash
// landing). Deterministic: every shape is a function of the seed. Composited
// over the layer, or (composite 1) on transparent. Layer px through fxBox.
// Rows: p0 = amount size spread seed, p1 = cx cy reveal opacity,
//       p2 = colour (sRGB 0..1) composite, p3 = lw lh 0 0.
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
fn rnd(i : f32, k : f32, s : f32) -> f32 {
  return fract(sin(i * 12.9898 + k * 78.233 + s * 37.719) * 43758.5453);
}

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lwh = max(obj.p3.xy, vec2<f32>(1.0, 1.0));
  let pp = (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let s0 = textureSampleLevel(tex, smp, uv, 0.0);
  let count = i32(clamp(round(obj.p0.x), 0.0, 48.0));
  let size = max(obj.p0.y, 0.5);
  let spread = max(obj.p0.z, 0.0);
  let seed = obj.p0.w;
  let centre = obj.p1.xy;
  let reveal = clamp(obj.p1.z, 0.0, 1.0);
  let opacity = clamp(obj.p1.w, 0.0, 1.0);
  let composite = obj.p2.w;
  var cover = 0.0;
  if (reveal > 0.0) {
    for (var i = 0; i < 48; i = i + 1) {
      if (i >= count) { break; }
      let fi = f32(i);
      let ang = rnd(fi, 1.0, seed) * 6.2831853;
      let dist = spread * sqrt(rnd(fi, 2.0, seed));
      let c = centre + vec2<f32>(cos(ang), sin(ang)) * dist;
      // Splat sizes: many small, a few large.
      let r = size * (0.25 + 1.5 * pow(rnd(fi, 3.0, seed), 2.0)) * reveal;
      // The blob: a radius that wobbles with the angle (a splash, not a disc).
      let d = pp - c;
      let a = atan2(d.y, d.x);
      let wob = 1.0 + 0.16 * sin(a * (3.0 + floor(rnd(fi, 4.0, seed) * 5.0)) + rnd(fi, 5.0, seed) * 6.28)
                    + 0.07 * sin(a * 11.0 + rnd(fi, 6.0, seed) * 6.28);
      cover = max(cover, clamp(r * wob - length(d) + 0.5, 0.0, 1.0));
      // Satellites: droplets thrown out along the splat's own direction.
      let throwDir = vec2<f32>(cos(ang + (rnd(fi, 7.0, seed) - 0.5) * 0.8), sin(ang + (rnd(fi, 7.0, seed) - 0.5) * 0.8));
      for (var k = 0; k < 3; k = k + 1) {
        let fk = f32(k);
        let along = r * (1.5 + fk * 0.9 + rnd(fi, 8.0 + fk, seed) * 0.8);
        let rr = r * (0.22 - fk * 0.05) * (0.6 + rnd(fi, 11.0 + fk, seed) * 0.8);
        let sc = c + throwDir * along + vec2<f32>(-throwDir.y, throwDir.x) * (rnd(fi, 14.0 + fk, seed) - 0.5) * r * 0.6;
        cover = max(cover, clamp(rr - length(pp - sc) + 0.5, 0.0, 1.0));
      }
    }
  }
  let ink = cover * opacity;
  let col = clamp(obj.p2.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let lin = vec3<f32>(srgbToLinearChan(col.r), srgbToLinearChan(col.g), srgbToLinearChan(col.b));
  let under = select(s0, vec4<f32>(0.0), composite > 0.5);
  // Premultiplied over.
  return vec4<f32>(lin * ink, ink) + under * (1.0 - ink);
}
