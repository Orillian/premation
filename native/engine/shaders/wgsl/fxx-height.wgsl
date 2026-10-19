// A height field from a picture (Refraction): r = height 0..1 (luminance,
// alpha or a channel, weighted by coverage), a = 1.
// p0 = (source 0 luminance 1 alpha 2 red 3 green 4 blue, invert, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = at0(uv);
  let d = toDisp(c);
  var h = 0.0;
  switch (i32(P(0).x)) {
    case 1: { h = c.a; }
    case 2: { h = d.r * d.a; }
    case 3: { h = d.g * d.a; }
    case 4: { h = d.b * d.a; }
    default: { h = lumaDisp(d.rgb) * d.a; }
  }
  if (P(0).y > 0.5) { h = 1.0 - h; }
  return vec4<f32>(h, h, h, 1.0);
}
