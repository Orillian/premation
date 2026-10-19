// CC Time Blend (docs/PROGRAM_DEEP_EFFECTS.md #37): three frames folded
// oldest first — r = tex0; r = fold(tex1, r); r = fold(tex2, r) — each newer
// frame taking the older result in by the transfer mode at the accumulation.
// p0 = (transfer 0 add 1 screen 2 lighten 3 darken 4 difference 5 blend, accumulation, 0, 0).
fn fold(c : vec4<f32>, r : vec4<f32>) -> vec4<f32> {
  let a = P(0).y;
  let ra = r * a;
  switch (i32(P(0).x)) {
    case 1: { return c + ra - c * clamp(ra, vec4<f32>(0.0), vec4<f32>(1.0)); }
    case 2: { return max(c, ra); }
    case 3: { return select(c, min(c, mix(c, r, a)), r.a > 0.0); }
    case 4: { return vec4<f32>(abs(c.rgb - ra.rgb), max(c.a, ra.a)); }
    case 5: { return mix(c, r, a); }
    default: { return vec4<f32>(c.rgb + ra.rgb, min(c.a + ra.a, 1.0)); }
  }
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var r = at0(uv);
  r = fold(at1(uv), r);
  r = fold(at2(uv), r);
  return r;
}
