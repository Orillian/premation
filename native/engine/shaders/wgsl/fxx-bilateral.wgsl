// An edge-preserving (bilateral) smoothing in display space over a 7 x 7 grid
// spanning the radius: Watercolor's abstraction, Ink & Toon's fill, Upscale's
// noise reduction. p0 = (radius px, range sigma (display units), 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let s0 = at0(uv);
  let c0 = vec4<f32>(l2s3(unpremul(s0)) * s0.a, s0.a);
  let r = P(0).x;
  let sr = max(P(0).y, 0.0001);
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var j = -3; j <= 3; j++) {
    for (var i = -3; i <= 3; i++) {
      let o = vec2<f32>(f32(i), f32(j));
      let s = at0(uv + dpxUv(o * r / 3.0));
      let c = vec4<f32>(l2s3(unpremul(s)) * s.a, s.a);
      let dc = c - c0;
      let w = exp(-dot(o, o) / 4.5) * exp(-dot(dc, dc) / (2.0 * sr * sr));
      acc += c * w;
      wsum += w;
    }
  }
  let res = acc / max(wsum, 0.000001);
  if (res.a <= 0.00001) { return vec4<f32>(0.0); }
  return vec4<f32>(s2l3(clamp(res.rgb / res.a, vec3<f32>(0.0), vec3<f32>(1.0))) * res.a, res.a);
}
