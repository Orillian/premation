// Object Matte (After Effects' Object Matte card): the layer cut by its stored
// per-frame Object Matte, refined live. tex0 = the input (the footage, whole),
// tex1 = the refined matte (fxx-selcol-matte: shifted by its distance field,
// then feathered; every channel), tex2 = the stored cut-out frame itself.
// p0 = (contrast 0..1, invert, use the cut-out's colour, 0).
// Contrast steepens the soft edge about its 1/2-contour (100 % = slope 5);
// Invert keeps the background. The cut-out's colour (decontaminated at the
// propagation) replaces the footage's wherever the cut-out has coverage, so
// edge colours stay as the propagation cleaned them.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  var m = clamp(at1(uv).r, 0.0, 1.0);
  let contrast = clamp(P(0).x, 0.0, 1.0);
  if (contrast > 0.0) { m = clamp((m - 0.5) * (1.0 + 4.0 * contrast) + 0.5, 0.0, 1.0); }
  if (P(0).y > 0.5) { m = 1.0 - m; }
  var rgb = base.rgb;
  if (P(0).z > 0.5 && base.a > 0.00001) {
    let cut = at2(uv);
    if (cut.a > 0.00001) { rgb = cut.rgb / cut.a * base.a; }
  }
  return vec4<f32>(rgb * m, base.a * m);
}
