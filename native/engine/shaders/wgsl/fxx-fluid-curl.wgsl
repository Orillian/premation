// Fluid Ink: the velocity's curl (y; 1/s) from central differences (velocity
// in tex0, layer px / s).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = simTexel(tex0);
  let h = simCell();
  let vr = atQ(tex0, uv + vec2<f32>(t.x, 0.0)).y;
  let vl = atQ(tex0, uv - vec2<f32>(t.x, 0.0)).y;
  let ut = atQ(tex0, uv + vec2<f32>(0.0, t.y)).x;
  let ub = atQ(tex0, uv - vec2<f32>(0.0, t.y)).x;
  let curl = (vr - vl) / (2.0 * h.x) - (ut - ub) / (2.0 * h.y);
  return vec4<f32>(0.0, curl, 0.0, 0.0);
}
