// Inner/Outer Key: alpha by projecting the pixel's colour onto the segment
// from the local background colour (tex2) to the local foreground colour
// (tex1), forced by the sure zones (tex3); the foreground colour unmixed from
// the background (c = a F + (1 - a) B).
// p0 = (edge threshold, invert, blend with original, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = at0(uv);
  let c = unpremul(src);
  let f4 = at1(uv);
  let b4 = at2(uv);
  let z = at3(uv);
  let fgc = select(c, f4.rgb / f4.a, f4.a > 0.0001);
  let bgc = select(c, b4.rgb / b4.a, b4.a > 0.0001);
  let d = fgc - bgc;
  let dd = dot(d, d);
  var a = select(0.5, clamp(dot(c - bgc, d) / dd, 0.0, 1.0), dd > 0.000001);
  if (f4.a <= 0.0001) { a = 0.0; }
  if (b4.a <= 0.0001) { a = 1.0; }
  a = max(a, z.r);
  a = a * (1.0 - z.g);
  let thr = P(0).x;
  a = clamp((a - thr) / max(1.0 - thr, 0.0001), 0.0, 1.0);
  var fgOut = select(fgc, clamp((c - (1.0 - a) * bgc) / max(a, 0.0001), vec3<f32>(0.0), vec3<f32>(64.0)), a > 0.02);
  if (P(0).y > 0.5) {
    a = 1.0 - a;
    fgOut = select(bgc, clamp((c - (1.0 - a) * fgc) / max(a, 0.0001), vec3<f32>(0.0), vec3<f32>(64.0)), a > 0.02);
  }
  let keyed = vec4<f32>(fgOut * a * src.a, a * src.a);
  return mix(keyed, src, P(0).z);
}
