// Fluid Ink: the velocity's divergence (x; 1/s), central differences.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = simTexel(tex0);
  let h = simCell();
  let ur = atQ(tex0, uv + vec2<f32>(t.x, 0.0)).x;
  let ul = atQ(tex0, uv - vec2<f32>(t.x, 0.0)).x;
  let vt = atQ(tex0, uv + vec2<f32>(0.0, t.y)).y;
  let vb = atQ(tex0, uv - vec2<f32>(0.0, t.y)).y;
  return vec4<f32>((ur - ul) / (2.0 * h.x) + (vt - vb) / (2.0 * h.y), 0.0, 0.0, 0.0);
}
