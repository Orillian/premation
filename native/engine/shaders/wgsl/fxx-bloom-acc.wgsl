// Lens Bloom: one pyramid level, tent-upsampled (9 taps) and weighted (p0.rgb),
// added into the full-resolution accumulator.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = texel0();
  var s = at0(uv) * 4.0;
  s += (at0(uv + vec2<f32>(t.x, 0.0)) + at0(uv - vec2<f32>(t.x, 0.0)) + at0(uv + vec2<f32>(0.0, t.y)) + at0(uv - vec2<f32>(0.0, t.y))) * 2.0;
  s += at0(uv + t) + at0(uv - t) + at0(uv + vec2<f32>(t.x, -t.y)) + at0(uv + vec2<f32>(-t.x, t.y));
  return vec4<f32>(max(s.rgb / 16.0, vec3<f32>(0.0)) * P(0).rgb, 0.0);
}
