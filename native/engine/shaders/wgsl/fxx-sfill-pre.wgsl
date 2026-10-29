// Background fill, step 1 (an effect Applied To the Background that blurs):
// the picture weighted by "not the subject". tex0 = the input, tex1 = the
// subject matte (alpha = coverage). Premultiplied: rgb·(1 − m), a·(1 − m),
// so a blur of it divided by its alpha is the background's own colour.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let m = clamp(at1(uv).a, 0.0, 1.0);
  return base * (1.0 - m);
}
