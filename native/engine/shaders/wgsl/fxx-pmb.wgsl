// Pixel Motion Blur (docs/PROGRAM_DEEP_EFFECTS.md #34): the layer (tex0)
// averaged along each pixel's motion — the optical flow from the frame before
// to the frame after (tex1, buffer uv, two frames of motion) — over the
// shutter. p0 = (shutter fraction x 0.5, samples, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let v = at1(uv).rg * P(0).x;
  if (length(v) < 0.00001) { return at0(uv); }
  let n = i32(P(0).y);
  var acc = vec4<f32>(0.0);
  for (var i = 0; i < 64; i++) {
    if (i >= n) { break; }
    let s = (f32(i) + 0.5) / f32(n) - 0.5;
    acc += at0(uv + v * s);
  }
  return acc / f32(n);
}
