// Timewarp (docs/PROGRAM_DEEP_EFFECTS.md #33): the in-between of the frames
// before (tex0) and after (tex1) the source instant at weight w: a frame mix,
// or pixel motion — both frames warped along the optical flow (tex2, buffer
// uv, before -> after) to the instant and blended, the blend leaning on the
// frame whose warped sample agrees (occlusion). Motion blur: the same over a
// shutter span of instants. p0 = (w, method 1 frame mix 2 pixel motion,
// shutter span (frames of motion), samples).
fn atInstant(uv : vec2<f32>, w : f32) -> vec4<f32> {
  if (P(0).y < 1.5) { return mix(at0(uv), at1(uv), w); }
  let f = at2(uv).rg;
  let a = at0(uv - f * w);
  let b = at1(uv + f * (1.0 - w));
  let disagree = length(a - b);
  let k = clamp(w + (smoothstep(0.1, 0.4, disagree) * (select(-1.0, 1.0, w > 0.5)) * 0.35), 0.0, 1.0);
  return mix(a, b, k);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let w = P(0).x;
  let span = P(0).z;
  if (span <= 0.0) { return atInstant(uv, w); }
  let n = i32(P(0).w);
  var acc = vec4<f32>(0.0);
  for (var i = 0; i < 32; i++) {
    if (i >= n) { break; }
    let s = (f32(i) + 0.5) / f32(n) - 0.5;
    acc += atInstant(uv, clamp(w + s * span, -1.0, 2.0));
  }
  return acc / f32(n);
}
