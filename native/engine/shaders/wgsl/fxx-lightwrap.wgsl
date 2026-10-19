// Light Wrap (docs/PROGRAM_DEEP_EFFECTS.md #9): the blurred background (tex1)
// wrapped onto the layer (tex0) through the band just inside its edge, where
// the blurred alpha (tex2) has fallen off.
// p0 = (intensity, luma bias -1..1, mode 0 screen 1 add 2 normal 3 lighten, wrap only),
// p1 = (has background, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let fg = at0(uv);
  if (P(1).x < 0.5) { return fg; }
  let soft = at2(uv).a;
  let band = fg.a * clamp((1.0 - soft) * 2.0, 0.0, 1.0);
  let bg = at1(uv);
  let bgs = unpremul(bg);
  let bias = P(0).y;
  let lw = pow(clamp(lumaLin(bgs), 0.0, 1.0), exp2(-bias * 2.0));
  let wrap = band * P(0).x * select(1.0, lw * 2.0, abs(bias) > 0.001);
  let light = bgs * bg.a * wrap;
  if (P(0).w > 0.5) { return vec4<f32>(light, clamp(wrap * bg.a, 0.0, 1.0)); }
  let mode = i32(P(0).z);
  var rgb = fg.rgb + light - fg.rgb * clamp(light, vec3<f32>(0.0), vec3<f32>(1.0));
  if (mode == 1) { rgb = fg.rgb + light; }
  if (mode == 2) { rgb = mix(fg.rgb, bgs * fg.a, clamp(wrap * bg.a, 0.0, 1.0)); }
  if (mode == 3) { rgb = max(fg.rgb, light); }
  return vec4<f32>(rgb, fg.a);
}
