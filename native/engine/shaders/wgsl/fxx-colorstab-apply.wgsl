// Color Stabilizer: this frame (tex0) corrected so its sample points read
// as at the reference (tex1 strip: 0..2 now, 3..5 reference) — brightness
// (the mid point's gain), levels (black and white mapped), or a three-point
// curve through black, mid and white — per channel, display values.
// p0 = (stabilize 0 brightness 1 levels 2 curves, 0, 0, 0).
fn st(k : i32) -> vec3<f32> { return textureLoad(tex1, vec2<i32>(k, 0), 0).rgb; }
fn curve1(x : f32, a0 : f32, a1 : f32, a2 : f32, b0 : f32, b1 : f32, b2 : f32) -> f32 {
  // Piecewise linear through (a0, b0), (a1, b1), (a2, b2), carried on past the ends.
  if (x <= a1) { return b0 + (x - a0) * (b1 - b0) / max(a1 - a0, 0.001); }
  return b1 + (x - a1) * (b2 - b1) / max(a2 - a1, 0.001);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let d = toDisp(base);
  let nb = st(0);
  let nm = st(1);
  let nw = st(2);
  let rb = st(3);
  let rm = st(4);
  let rw = st(5);
  var c = d.rgb;
  let mode = i32(P(0).x);
  if (mode == 0) {
    let g = lumaDisp(rm) / max(lumaDisp(nm), 0.001);
    c = d.rgb * g;
  } else if (mode == 1) {
    c = rb + (d.rgb - nb) * (rw - rb) / max(nw - nb, vec3<f32>(0.001));
  } else {
    c = vec3<f32>(curve1(d.r, nb.r, nm.r, nw.r, rb.r, rm.r, rw.r), curve1(d.g, nb.g, nm.g, nw.g, rb.g, rm.g, rw.g),
                  curve1(d.b, nb.b, nm.b, nw.b, rb.b, rm.b, rw.b));
  }
  return fromDisp(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), d.a);
}
