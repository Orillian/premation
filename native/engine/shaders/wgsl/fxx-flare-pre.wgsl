// Image Flares prefilter (docs/PROGRAM_DEEP_EFFECTS.md #3): the input's
// highlights at half resolution (a 4-tap box, soft threshold, clamp).
// p0 = (threshold, knee, clamp, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = texel0();
  let s = at0(uv + vec2<f32>(-t.x, -t.y)) + at0(uv + vec2<f32>(t.x, -t.y)) + at0(uv + vec2<f32>(-t.x, t.y)) + at0(uv + vec2<f32>(t.x, t.y));
  let c = min(max(s.rgb * 0.25, vec3<f32>(0.0)), vec3<f32>(P(0).z));
  let thr = P(0).x;
  let k = max(P(0).y * thr, 0.00001);
  let br = max(c.r, max(c.g, c.b));
  var rq = clamp(br - thr + k, 0.0, 2.0 * k);
  rq = rq * rq / (4.0 * k);
  return vec4<f32>(c * (max(rq, br - thr) / max(br, 0.00001)), 0.0);
}
