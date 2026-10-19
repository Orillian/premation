// VR Glow composite: the spherically blurred highlights (tex1), saturated and
// tinted, added over the frame (tex0). p0 = (brightness, saturation, 0, 0), p1 = (tint, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  var g = max(at1(uv).rgb, vec3<f32>(0.0));
  let l = lumaLin(g);
  g = max(mix(vec3<f32>(l), g, P(0).y), vec3<f32>(0.0)) * P(1).rgb * P(0).x;
  return lightOver(base, g, 0);
}
