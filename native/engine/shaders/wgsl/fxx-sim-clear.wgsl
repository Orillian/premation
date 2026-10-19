// X2: a SIM slot cleared to zero.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(0.0 * uv.x);
}
