// Fluid Ink: the projection — the velocity (tex0) less the pressure gradient
// (tex1), divergence-free.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = simTexel(tex1);
  let h = simCell();
  let pl = atQ(tex1, uv - vec2<f32>(t.x, 0.0)).x;
  let pr = atQ(tex1, uv + vec2<f32>(t.x, 0.0)).x;
  let pb = atQ(tex1, uv - vec2<f32>(0.0, t.y)).x;
  let pt = atQ(tex1, uv + vec2<f32>(0.0, t.y)).x;
  let v = atQ(tex0, uv).xy - vec2<f32>((pr - pl) / (2.0 * h.x), (pt - pb) / (2.0 * h.y));
  return vec4<f32>(v, 0.0, 0.0);
}
