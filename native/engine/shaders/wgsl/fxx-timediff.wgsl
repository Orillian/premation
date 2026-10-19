// Time Difference (docs/PROGRAM_DEEP_EFFECTS.md #36): the layer (tex0) less
// itself at the offset (tex1) in display values — absolute, or signed about
// mid grey — scaled by contrast; alpha by AE's modes.
// p0 = (contrast, absolute, alpha 0 original 1 target 2 blend 3 max 4 full on
// 5 lightness of result 6 max of result 7 alpha difference, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let a = toDisp(at0(uv));
  let b = toDisp(at1(uv));
  var d = (a.rgb * a.a - b.rgb * b.a) * P(0).x;
  if (P(0).y > 0.5) { d = abs(d); } else { d = d * 0.5 + 0.5; }
  d = clamp(d, vec3<f32>(0.0), vec3<f32>(1.0));
  var al = a.a;
  switch (i32(P(0).z)) {
    case 1: { al = b.a; }
    case 2: { al = (a.a + b.a) * 0.5; }
    case 3: { al = max(a.a, b.a); }
    case 4: { al = 1.0; }
    case 5: { al = 0.5 * (max(d.r, max(d.g, d.b)) + min(d.r, min(d.g, d.b))); }
    case 6: { al = max(d.r, max(d.g, d.b)); }
    case 7: { al = abs(a.a - b.a); }
    default: { al = a.a; }
  }
  return fromDisp(d, clamp(al, 0.0, 1.0));
}
