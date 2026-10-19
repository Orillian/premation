// Fluid Ink: the dye (tex0, premultiplied colour) advected by the velocity
// (tex1), fading, with the source (tex2) still emitting.
// p0 = (speed, emission, fade, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let dt = simRow().y * P(0).x;
  let v = atQ(tex1, uv).xy;
  let back = clamp(uv - v * dt / lwh(), vec2<f32>(0.0), vec2<f32>(1.0));
  var d = atQ(tex0, back) * exp(-P(0).z * 2.0 * dt);
  let src = atQ(tex2, uv);
  d += src * P(0).y * dt * 2.0;
  d.a = min(d.a, 1.0);
  d = vec4<f32>(min(d.rgb, vec3<f32>(d.a * 64.0)), d.a);
  return d;
}
