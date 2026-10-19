// Fluid Ink (docs/PROGRAM_DEEP_EFFECTS.md #41): the initial dye — the layer at
// the start time (tex0, the captured source), scaled. p0 = (dye amount, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return atQ(tex0, uv) * P(0).x;
}
