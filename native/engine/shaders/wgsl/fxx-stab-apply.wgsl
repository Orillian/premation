// Warp Stabilizer: the smoothed camera — the mean of this frame (identity)
// and its four neighbours' transforms (tex1 strip texels 0..3: a - 1, b, tx,
// ty) — and the frame (tex0) warped by its inverse so the smoothed path
// stands still; auto-scaled to hide the edges (up to the maximum).
// p0 = (strength, framing 0 crop+auto-scale 1 stabilize only, max scale, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var m = vec4<f32>(0.0);
  for (var k = 0; k < 4; k++) { m += textureLoad(tex1, vec2<i32>(k, 0), 0); }
  m = m / 5.0 * P(0).x;
  let a = 1.0 + m.x;
  let b = m.y;
  let hb2 = lwh() * 0.5;
  // Output point q (fit units) shows the frame's point S^-1 q.
  var q = (layerPx(uv) - hb2) / hb2.x;
  var s = 1.0;
  if (P(0).y < 0.5) {
    let need = 1.0 + 2.0 * max(abs(m.z), abs(m.w)) * hb2.x / max(hb2.y, 1.0) + abs(b) * 1.5 + abs(m.x);
    s = clamp(need, 1.0, P(0).z);
  }
  q = q / s;
  let det = a * a + b * b;
  let qq = q - m.zw;
  let src = vec2<f32>(a * qq.x + b * qq.y, -b * qq.x + a * qq.y) / max(det, 0.0001);
  let px = src * hb2.x + hb2;
  if (px.x < 0.0 || px.y < 0.0 || px.x > lwh().x || px.y > lwh().y) { return vec4<f32>(0.0); }
  return at0(pxUv(px));
}
