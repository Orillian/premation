// Rain on Glass (docs/PROGRAM_DEEP_EFFECTS.md #47): the picture (tex0) behind
// fogged glass (its blur, tex1); static droplets at two sizes and running
// drops (a column each, sliding down at their own pace, wiggling) act as
// lenses onto the clear picture, the running drops wiping clear trails
// studded with small droplets. p0 = (amount, drop size px, time x speed,
// trails), p1 = (fog, refraction, highlight, seed).
fn hb(c : vec2<f32>, s : f32) -> f32 { return hcell(c, P(1).w + s); }
// A drop lens at `c` of radius `r`: (offset to sample, coverage, highlight).
fn lens(px : vec2<f32>, c : vec2<f32>, r : f32) -> vec4<f32> {
  let d = px - c;
  let x = length(d) / r;
  if (x >= 1.0) { return vec4<f32>(0.0); }
  let cov = smoothstep(1.0, 0.85, x);
  let off = -d * (1.0 - x * x) * 0.9 * P(1).y;
  let hl = smoothstep(0.35, 0.0, length(d / r - vec2<f32>(-0.3, -0.35)));
  return vec4<f32>(off, cov, hl);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let px = layerPx(uv);
  let sz = P(0).y;
  let amt = P(0).x;
  var off = vec2<f32>(0.0);
  var cov = 0.0;
  var hl = 0.0;
  var clear = 0.0;
  // Static droplets: two scales on hashed grids.
  for (var layer = 0; layer < 2; layer++) {
    let s = sz * select(0.45, 1.0, layer == 1);
    let cell = floor(px / s);
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let c = cell + vec2<f32>(f32(i), f32(j));
        if (hb(c, f32(layer) * 13.0) > amt * 0.45) { continue; }
        let ctr = (c + vec2<f32>(hb(c, 1.0 + f32(layer)), hb(c, 2.0 + f32(layer)))) * s;
        let r = s * (0.12 + 0.2 * hb(c, 3.0 + f32(layer)));
        let l = lens(px, ctr, r);
        if (l.z > cov) {
          cov = l.z;
          off = l.xy;
          hl = l.w;
        }
      }
    }
  }
  // Running drops: one per column, sliding down, leaving a clear trail.
  let colW = sz * 2.6;
  let col = floor(px.x / colW);
  for (var k = -1; k <= 1; k++) {
    let cc = col + f32(k);
    if (hb(vec2<f32>(cc, 7.0), 3.0) > amt * 0.8) { continue; }
    let speed = 0.15 + 0.35 * hb(vec2<f32>(cc, 1.0), 9.0);
    let h = lwh().y * 1.3;
    let y = fract(P(0).z * speed * 0.35 + hb(vec2<f32>(cc, 2.0), 9.0)) * h - lwh().y * 0.15;
    let wig = sin(y * 0.045 + hb(vec2<f32>(cc, 3.0), 9.0) * 6.28) * colW * 0.18;
    let x = (cc + 0.5) * colW + wig;
    let r = sz * (0.35 + 0.2 * hb(vec2<f32>(cc, 4.0), 9.0));
    let l = lens(px, vec2<f32>(x, y), r);
    if (l.z > cov) {
      cov = l.z;
      off = l.xy;
      hl = l.w;
    }
    // The trail above it: wiped glass, with droplets left behind.
    let trailLen = lwh().y * 0.35 * P(0).w;
    let above = y - px.y;
    if (above > 0.0 && above < trailLen) {
      let tx = x - sin((y - above) * 0.045 + hb(vec2<f32>(cc, 3.0), 9.0) * 6.28) * colW * 0.18 + wig;
      let inTrail = smoothstep(r * 0.6, r * 0.2, abs(px.x - (tx - wig + wig)));
      clear = max(clear, inTrail * (1.0 - above / trailLen));
      let dropCell = floor(above / (r * 1.4));
      let dc = vec2<f32>(x - wig + sin((y - (dropCell + 0.5) * r * 1.4) * 0.045 + hb(vec2<f32>(cc, 3.0), 9.0) * 6.28) * colW * 0.18, y - (dropCell + 0.5) * r * 1.4);
      if (hb(vec2<f32>(cc, dropCell), 21.0) < 0.6) {
        let lt = lens(px, dc, r * 0.3);
        if (lt.z > cov) {
          cov = lt.z;
          off = lt.xy;
          hl = lt.w;
        }
      }
    }
  }
  let sharp = at0(uv + dpxUv(off));
  let fogged = mix(base, at1(uv), P(1).x * (1.0 - clear));
  var res = mix(fogged, sharp, cov);
  res = vec4<f32>(res.rgb + vec3<f32>(hl * P(1).z * 0.6) * res.a, res.a);
  return res;
}
