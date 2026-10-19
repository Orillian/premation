// CC Bender (docs/PROGRAM_DEEP_EFFECTS.md #56): the layer bent from its base
// toward its top — each point along the base->top axis pushed across it by
// an offset profile (Bend: s^2, Marilyn: a wave, Sharp: a kink, Boxer: a
// rounded box) — drawn by inverting that warp with fixed-point iteration.
// p0 = (top px, base px), p1 = (amount px, style, adjust to distance, 0).
fn profile(s0 : f32, style : i32) -> f32 {
  let s = clamp(s0, 0.0, 1.5);
  switch (style) {
    case 1: { return sin(s * PI * 1.5) * s; }
    case 2: { return max(s - 0.5, 0.0) * 2.0; }
    case 3: { return smoothstep(0.0, 0.35, s) - smoothstep(0.65, 1.0, s) * 0.3; }
    default: { return s * s; }
  }
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let p = layerPx(uv);
  let top = P(0).xy;
  let bas = P(0).zw;
  let ax = top - bas;
  let len = max(length(ax), 0.001);
  let t = ax / len;
  let nrm = vec2<f32>(-t.y, t.x);
  var amt = P(1).x;
  if (P(1).z > 0.5) { amt = amt * len / 300.0; }
  let style = i32(P(1).y);
  // Forward warp: src -> src + nrm * amt * profile(along / len). Invert it.
  var src = p;
  for (var k = 0; k < 6; k++) {
    let s = dot(src - bas, t) / len;
    src = p - nrm * amt * profile(s, style) * select(0.0, 1.0, s > 0.0);
  }
  if (src.x < 0.0 || src.y < 0.0 || src.x > lwh().x || src.y > lwh().y) { return vec4<f32>(0.0); }
  return at0(pxUv(src));
}
