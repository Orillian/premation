// Shine composite: the rays (tex1) colorized by intensity over the input (tex0).
// p0 = (colorize, boost light, shine opacity, source opacity), p1 = (mode,
// edge thickness, 0, 0), p2..p6 = the ramp (display rgb, position).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv) * P(0).w;
  let r = at1(uv);
  let gain = 0.25 + P(0).y * 0.75;
  let inten = max(r.a, 0.0) * gain;
  var light = max(r.rgb, vec3<f32>(0.0)) * gain;
  if (i32(P(0).x) != 0) {
    let k = pow(clamp(inten, 0.0, 1.0), mix(2.5, 0.35, P(1).y));
    light = s2l3(ramp(k, 2, 5)) * inten;
  }
  return lightOver(base, light * P(0).z, i32(P(1).x));
}
