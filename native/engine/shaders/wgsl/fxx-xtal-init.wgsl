// Crystal Growth (docs/PROGRAM_DEEP_EFFECTS.md #43): the nucleus — phase 1
// where the layer was at the start time (tex0), temperature 0 (undercooled).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = atQ(tex0, uv);
  return vec4<f32>(step(0.5, src.a), 0.0, 0.0, 1.0);
}
