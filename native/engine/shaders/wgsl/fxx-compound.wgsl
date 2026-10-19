// Compound Arithmetic (docs/PROGRAM_DEEP_EFFECTS.md #11): the layer (tex0) and
// a second layer (tex1) combined per channel in 8-bit display values.
// p0 = (operator, channels 0 RGB 1 ARGB 2 alpha, overflow 0 clip 1 wrap 2 scale, blend).
// Operators: 0 copy 1 add 2 subtract 3 multiply 4 difference 5 and 6 or 7 xor
// 8 lighten 9 darken 10 minimum 11 maximum 12 screen 13 overlay 14 hard light.
fn op1(a : f32, b : f32, o : i32) -> f32 {
  switch (o) {
    case 0: { return b; }
    case 1: { return a + b; }
    case 2: { return a - b; }
    case 3: { return a * b; }
    case 4: { return abs(a - b); }
    case 5: { return f32(u32(round(a * 255.0)) & u32(round(b * 255.0))) / 255.0; }
    case 6: { return f32(u32(round(a * 255.0)) | u32(round(b * 255.0))) / 255.0; }
    case 7: { return f32(u32(round(a * 255.0)) ^ u32(round(b * 255.0))) / 255.0; }
    case 8: { return max(a, b); }
    case 9: { return min(a, b); }
    case 10: { return min(a, b); }
    case 11: { return max(a, b); }
    case 12: { return 1.0 - (1.0 - a) * (1.0 - b); }
    case 13: { return overlay1(a, b); }
    case 14: { return overlay1(b, a); }
    default: { return a; }
  }
}
fn overflow1(v : f32, o : i32, mode : i32) -> f32 {
  if (mode == 1) { return v - floor(v); }
  if (mode == 2) {
    if (o == 1) { return v * 0.5; }
    if (o == 2) { return (v + 1.0) * 0.5; }
  }
  return clamp(v, 0.0, 1.0);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = at0(uv);
  let a = toDisp(src);
  let b = toDisp(at1(uv));
  let o = i32(P(0).x);
  let ch = i32(P(0).y);
  let ov = i32(P(0).z);
  var rgb = a.rgb;
  var al = a.a;
  if (ch != 2) {
    rgb = vec3<f32>(overflow1(op1(a.r, b.r, o), o, ov), overflow1(op1(a.g, b.g, o), o, ov), overflow1(op1(a.b, b.b, o), o, ov));
  }
  if (ch != 0) { al = overflow1(op1(a.a, b.a, o), o, ov); }
  return mix(fromDisp(rgb, al), src, P(0).w);
}
