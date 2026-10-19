// Fluid Ink: one Jacobi iteration of the pressure Poisson equation
// (lap p = div v): pressure in tex0, divergence in tex1.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = simTexel(tex0);
  let h = simCell();
  let pl = atQ(tex0, uv - vec2<f32>(t.x, 0.0)).x;
  let pr = atQ(tex0, uv + vec2<f32>(t.x, 0.0)).x;
  let pb = atQ(tex0, uv - vec2<f32>(0.0, t.y)).x;
  let pt = atQ(tex0, uv + vec2<f32>(0.0, t.y)).x;
  let d = atQ(tex1, uv).x;
  let ax = 1.0 / (h.x * h.x);
  let ay = 1.0 / (h.y * h.y);
  let p = ((pl + pr) * ax + (pb + pt) * ay - d) / (2.0 * ax + 2.0 * ay);
  return vec4<f32>(p, 0.0, 0.0, 0.0);
}
