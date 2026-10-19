// Optical flow input (docs/PROGRAM_DEEP_EFFECTS.md X1): the two frames' display
// luminance (coverage counted) at this level's resolution, r = from (tex0),
// g = to (tex1). A 4-tap box keeps the level from aliasing.
fn lumaAt(t : texture_2d<f32>, uv : vec2<f32>) -> f32 {
  let c = textureSampleLevel(t, smp, uv, 0.0);
  return lumaDisp(toDisp(c).rgb) * c.a;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let h = 0.25 / outSize();
  let a = (lumaAt(tex0, uv + vec2<f32>(-h.x, -h.y)) + lumaAt(tex0, uv + vec2<f32>(h.x, -h.y)) + lumaAt(tex0, uv + vec2<f32>(-h.x, h.y)) + lumaAt(tex0, uv + vec2<f32>(h.x, h.y))) * 0.25;
  let b = (lumaAt(tex1, uv + vec2<f32>(-h.x, -h.y)) + lumaAt(tex1, uv + vec2<f32>(h.x, -h.y)) + lumaAt(tex1, uv + vec2<f32>(-h.x, h.y)) + lumaAt(tex1, uv + vec2<f32>(h.x, h.y))) * 0.25;
  return vec4<f32>(a, b, 0.0, 1.0);
}
