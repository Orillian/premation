// Inner/Outer Key (docs/PROGRAM_DEEP_EFFECTS.md #13): where the key is sure —
// r = surely foreground, g = surely background. Two masks: inside the
// foreground mask (tex0) / outside the background mask (tex1). One mask: its
// blurred raster (tex0) well inside / well outside (the highlight radius).
// p0 = (two masks, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  if (P(0).x > 0.5) {
    let fg = at0(uv).a;
    let bg = 1.0 - at1(uv).a;
    return vec4<f32>(fg, bg * (1.0 - fg), 0.0, 1.0);
  }
  let m = at0(uv).a;
  return vec4<f32>(smoothstep(0.9, 0.99, m), smoothstep(0.1, 0.01, m), 0.0, 1.0);
}
