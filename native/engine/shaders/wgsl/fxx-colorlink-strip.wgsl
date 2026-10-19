// Color Link (docs/PROGRAM_DEEP_EFFECTS.md #12), reduction stage 1: each of
// the strip's 256 texels gathers one column of 64 taps of the source (tex0).
// Samples (p0.x): 0 average (sum of premultiplied rgb, sum of alpha) · 1
// brightest / 2 darkest (that tap's straight colour, its luma) · 3 max / 4 min
// RGB (straight, coverage) · 5 average alpha (sum, count) · 6 max / 7 min alpha.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let mode = i32(P(0).x);
  let x = uv.x;
  var acc = vec4<f32>(0.0);
  var best = vec4<f32>(0.0, 0.0, 0.0, -1.0);
  if (mode == 2) { best.w = 1e9; }
  var mx = vec4<f32>(-1.0);
  var mn = vec4<f32>(2.0);
  var seen = 0.0;
  for (var j = 0; j < 64; j++) {
    let s = at0(vec2<f32>(x, (f32(j) + 0.5) / 64.0));
    acc += vec4<f32>(s.rgb, s.a);
    if (s.a > 0.01) {
      let c = unpremul(s);
      let l = lumaLin(c);
      if ((mode == 1 && l > best.w) || (mode == 2 && l < best.w)) { best = vec4<f32>(c, l); }
      mx = max(mx, vec4<f32>(c, s.a));
      mn = min(mn, vec4<f32>(c, s.a));
      seen = 1.0;
    }
  }
  switch (mode) {
    case 1, 2: { return select(vec4<f32>(0.0, 0.0, 0.0, -2.0), best, seen > 0.5); }
    case 3: { return select(vec4<f32>(0.0, 0.0, 0.0, -2.0), vec4<f32>(mx.rgb, 1.0), seen > 0.5); }
    case 4: { return select(vec4<f32>(0.0, 0.0, 0.0, -2.0), vec4<f32>(mn.rgb, 1.0), seen > 0.5); }
    case 5: { return vec4<f32>(acc.a, 64.0, 0.0, 0.0); }
    case 6: { return vec4<f32>(max(mx.a, 0.0), 0.0, 0.0, 0.0); }
    case 7: { return vec4<f32>(select(1.0, mn.a, seen > 0.5), 0.0, 0.0, select(-2.0, 0.0, seen > 0.5)); }
    default: { return acc; }
  }
}
