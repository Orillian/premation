// Color Stabilizer (docs/PROGRAM_DEEP_EFFECTS.md #51): the three sample
// points' mean colour (display) over a box — strip texels 0..2 now (tex0:
// black, mid, white), 3..5 at the reference frame (tex1).
// p0 = (black point px, mid point px), p1 = (white point px, box size px, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let k = i32(floor(uv.x * 256.0));
  if (k > 5) { return vec4<f32>(0.0); }
  var pt = P(0).xy;
  if (k % 3 == 1) { pt = P(0).zw; }
  if (k % 3 == 2) { pt = P(1).xy; }
  let half = P(1).z * 0.5;
  var acc = vec4<f32>(0.0);
  for (var j = 0; j < 7; j++) {
    for (var i = 0; i < 7; i++) {
      let px = pt + (vec2<f32>(f32(i), f32(j)) / 6.0 - 0.5) * 2.0 * half;
      var c = at0(pxUv(px));
      if (k >= 3) { c = at1(pxUv(px)); }
      let d = toDisp(c);
      acc += vec4<f32>(d.rgb, 1.0);
    }
  }
  return vec4<f32>(acc.rgb / max(acc.a, 1.0), 1.0);
}
