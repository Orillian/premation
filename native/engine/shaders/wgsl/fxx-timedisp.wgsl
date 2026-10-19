// Time Displacement (docs/PROGRAM_DEEP_EFFECTS.md #35): each pixel's time
// offset from the map's luminance (tex0; white +max, black -max, mid grey now),
// quantised to the time resolution, read between five sampled instants.
// Pass 0 (the past): tex1 = -max, tex2 = -max/2, tex3 = now; pass 1 (the
// future): tex1 = pass 0's result (now where the offset is >= 0), tex2 =
// +max/2, tex3 = +max. p0 = (pass, quantum (fraction of max; 0 = none), blend
// between frames, has map).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var o = 0.0;
  if (P(0).w > 0.5) {
    let m = at0(uv);
    o = lumaDisp(toDisp(m).rgb) * m.a * 2.0 - 1.0;
  }
  if (P(0).y > 0.0) { o = round(o / P(0).y) * P(0).y; }
  if (P(0).z < 0.5) { o = round(o * 2.0) * 0.5; }
  if (P(0).x < 0.5) {
    if (o >= 0.0) { return at3(uv); }
    let a = -o;
    if (a <= 0.5) { return mix(at3(uv), at2(uv), a * 2.0); }
    return mix(at2(uv), at1(uv), (a - 0.5) * 2.0);
  }
  if (o <= 0.0) { return at1(uv); }
  if (o <= 0.5) { return mix(at1(uv), at2(uv), o * 2.0); }
  return mix(at2(uv), at3(uv), (o - 0.5) * 2.0);
}
