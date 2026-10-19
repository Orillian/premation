// Emitted light (tex1, half resolution, bilinear) tinted and laid over the
// input (tex0). p0 = (tint, intensity), p1 = (mode, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let light = max(at1(uv).rgb, vec3<f32>(0.0)) * P(0).rgb * P(0).w;
  return lightOver(base, light, i32(P(1).x));
}
