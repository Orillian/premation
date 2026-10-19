// Detail-preserving Upscale's detail pass: unsharp masking of the upscaled
// picture (tex0) against its blur (tex1), limited to the 3 x 3 neighbourhood's
// range (+10 %) so edges sharpen without halos. p0 = (detail, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = at0(uv);
  let b = at1(uv);
  let t = texel0();
  var lo = c;
  var hi = c;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let s = at0(uv + vec2<f32>(f32(i), f32(j)) * t);
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  let pad = (hi - lo) * 0.1;
  let sharp = c + (c - b) * P(0).x * 2.0;
  let res = clamp(sharp, lo - pad, hi + pad);
  return vec4<f32>(min(res.rgb, vec3<f32>(res.a * 64.0)), clamp(res.a, 0.0, 1.0));
}
