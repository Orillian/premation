// The input, unchanged (a graph's straight copy of one slot).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return at0(uv);
}
