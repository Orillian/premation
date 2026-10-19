// Edge Rays (docs/PROGRAM_DEEP_EFFECTS.md #16): what emits — the layer's
// alpha and / or luminance edges (a Sobel gradient at the edge width), above
// the threshold, shimmering around the centre; rgb = the light, a = intensity.
// p0 = (centre px x, y, edge width px, threshold), p1 = (shimmer amount,
// detail, phase, seed), p2 = (tint (r < 0: source colours), edges 0 alpha 1 luma 2 both).
fn ev(uv : vec2<f32>, mode : i32) -> f32 {
  let c = at0(uv);
  let l = lumaDisp(toDisp(c).rgb) * c.a;
  if (mode == 0) { return c.a; }
  if (mode == 1) { return l; }
  return max(c.a, l);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let mode = i32(P(2).w);
  let e = dpxUv(vec2<f32>(P(0).z, P(0).z));
  let gx = ev(uv + vec2<f32>(e.x, 0.0), mode) - ev(uv - vec2<f32>(e.x, 0.0), mode);
  let gy = ev(uv + vec2<f32>(0.0, e.y), mode) - ev(uv - vec2<f32>(0.0, e.y), mode);
  let edge = smoothstep(P(0).w, P(0).w + 0.15, length(vec2<f32>(gx, gy)) * 0.5);
  let dir = layerPx(uv) - P(0).xy;
  let ang = atan2(dir.y, dir.x);
  let q = vec2<f32>(cos(ang), sin(ang)) * P(1).y;
  let n = fbmT(q + vec2<f32>(50.0, 50.0), P(1).z, P(1).w, 3);
  let sh = mix(1.0, smoothstep(0.3, 0.7, n) * 2.0, P(1).x);
  let k = edge * sh;
  // Source colours: the picture's own colour at the edge (its brightest neighbour).
  var col = P(2).rgb;
  if (col.r < 0.0) {
    let a = at0(uv + vec2<f32>(e.x, 0.0));
    let b = at0(uv - vec2<f32>(e.x, 0.0));
    let c = at0(uv + vec2<f32>(0.0, e.y));
    let d = at0(uv - vec2<f32>(0.0, e.y));
    let m = max(max(a, b), max(c, d));
    col = select(vec3<f32>(1.0), unpremul(m), m.a > 0.01);
  }
  return vec4<f32>(col * k, k);
}
