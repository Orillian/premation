// Color Link, reduction stage 2: the strip's 256 partials (tex0) to the one
// colour (straight linear rgb, alpha) every texel of this pass holds.
// p0 = (sample, 0, 0, 0) — see fxx-colorlink-strip.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let mode = i32(P(0).x);
  var acc = vec4<f32>(0.0);
  var best = vec4<f32>(0.0, 0.0, 0.0, -1.0);
  if (mode == 2) { best.w = 1e9; }
  var mx = vec3<f32>(-1.0);
  var mn = vec3<f32>(2.0);
  var amx = 0.0;
  var amn = 1.0;
  for (var i = 0; i < 256; i++) {
    let s = textureLoad(tex0, vec2<i32>(i, 0), 0);
    acc += s;
    if (s.w > -1.5) {
      if ((mode == 1 && s.w > best.w) || (mode == 2 && s.w < best.w)) { best = s; }
      mx = max(mx, s.rgb);
      mn = min(mn, s.rgb);
      amx = max(amx, s.x);
      amn = min(amn, s.x);
    }
  }
  switch (mode) {
    case 1, 2: { return vec4<f32>(max(best.rgb, vec3<f32>(0.0)), 1.0); }
    case 3: { return vec4<f32>(max(mx, vec3<f32>(0.0)), 1.0); }
    case 4: { return vec4<f32>(clamp(mn, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0); }
    case 5: { let a = acc.x / max(acc.y, 1.0); return vec4<f32>(vec3<f32>(a), a); }
    case 6: { return vec4<f32>(vec3<f32>(amx), amx); }
    case 7: { return vec4<f32>(vec3<f32>(amn), amn); }
    default: {
      let a = acc.a / (256.0 * 64.0);
      return vec4<f32>(acc.rgb / max(acc.a, 0.0001), a);
    }
  }
}
