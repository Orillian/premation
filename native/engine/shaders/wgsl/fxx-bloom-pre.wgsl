// Lens Bloom prefilter (docs/PROGRAM_DEEP_EFFECTS.md #1): the input at half
// resolution through the 13-tap downsample (Jimenez 2014), each tap weighted
// 1 / (1 + luma) against fireflies, then the soft-knee threshold in linear light.
// p0 = (threshold, knee 0..1, clamp, saturation), p1 = (tint, 0).
fn kneeOf(c : vec3<f32>) -> vec3<f32> {
  let thr = P(0).x;
  let k = max(P(0).y * thr, 0.00001);
  let br = max(c.r, max(c.g, c.b));
  var rq = clamp(br - thr + k, 0.0, 2.0 * k);
  rq = rq * rq / (4.0 * k);
  return c * (max(rq, br - thr) / max(br, 0.00001));
}
fn tapK(uv : vec2<f32>, d : vec2<f32>, w : f32) -> vec4<f32> {
  let c = min(max(at0(uv + d * texel0()).rgb, vec3<f32>(0.0)), vec3<f32>(P(0).z));
  let kw = w / (1.0 + lumaLin(c));
  return vec4<f32>(c * kw, kw);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var acc = tapK(uv, vec2<f32>(0.0, 0.0), 0.125);
  acc += tapK(uv, vec2<f32>(-2.0, -2.0), 0.03125) + tapK(uv, vec2<f32>(2.0, -2.0), 0.03125);
  acc += tapK(uv, vec2<f32>(-2.0, 2.0), 0.03125) + tapK(uv, vec2<f32>(2.0, 2.0), 0.03125);
  acc += tapK(uv, vec2<f32>(0.0, -2.0), 0.0625) + tapK(uv, vec2<f32>(0.0, 2.0), 0.0625);
  acc += tapK(uv, vec2<f32>(-2.0, 0.0), 0.0625) + tapK(uv, vec2<f32>(2.0, 0.0), 0.0625);
  acc += tapK(uv, vec2<f32>(-1.0, -1.0), 0.125) + tapK(uv, vec2<f32>(1.0, -1.0), 0.125);
  acc += tapK(uv, vec2<f32>(-1.0, 1.0), 0.125) + tapK(uv, vec2<f32>(1.0, 1.0), 0.125);
  let c = acc.rgb / max(acc.a, 0.000001);
  var b = kneeOf(c);
  let l = lumaLin(b);
  b = max(mix(vec3<f32>(l), b, P(0).w), vec3<f32>(0.0));
  return vec4<f32>(b * P(1).rgb, 0.0);
}
