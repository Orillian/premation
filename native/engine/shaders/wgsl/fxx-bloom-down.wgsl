// Lens Bloom: a 2x downsample (four bilinear taps one source texel out, a 4x4 tent).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = texel0();
  let s = at0(uv + vec2<f32>(-t.x, -t.y)) + at0(uv + vec2<f32>(t.x, -t.y)) + at0(uv + vec2<f32>(-t.x, t.y)) + at0(uv + vec2<f32>(t.x, t.y));
  return vec4<f32>(s.rgb * 0.25, 0.0);
}
