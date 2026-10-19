// Fluid Ink: semi-Lagrangian advection of a field (tex0) along the velocity
// (tex1, layer px / s): the value that was where this cell's fluid came from.
// p0 = (speed, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let dt = simRow().y * P(0).x;
  let v = atQ(tex1, uv).xy;
  let back = uv - v * dt / lwh();
  var r = atQ(tex0, clamp(back, vec2<f32>(0.0), vec2<f32>(1.0)));
  // The box's walls: no flow through them.
  let t = simTexel(tex0);
  if (uv.x < t.x || uv.y < t.y || uv.x > 1.0 - t.x || uv.y > 1.0 - t.y) { r = vec4<f32>(0.0, 0.0, r.z, r.w); }
  return r;
}
