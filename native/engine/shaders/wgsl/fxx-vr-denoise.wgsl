// VR De-Noise (docs/PROGRAM_DEEP_EFFECTS.md #20): non-local means — every
// pixel in a search window (wider along the row toward the poles, wrapping
// across the seam) weighted by how alike its 3 x 3 patch is to this one's.
// p0 = (layout, noise level h, search radius px, detail preservation).
fn patchAt(fr : vec4<f32>, q : vec2<f32>, t : vec2<f32>, i : i32) -> vec3<f32> {
  let o = vec2<f32>(f32(i % 3 - 1), f32(i / 3 - 1)) * t;
  return l2s3(max(vrTap(tex0, fr, q + o).rgb, vec3<f32>(0.0)));
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lay = i32(P(0).x);
  let px = layerPx(uv);
  let fr = vrFrame(px, lay);
  let q = (px - fr.xy) / fr.zw;
  let lat = (0.5 - q.y) * PI;
  let t = vec2<f32>(pxPerOut().x / fr.z / max(cos(lat), 0.25), pxPerOut().y / fr.w);
  let h = P(0).y;
  let r = i32(min(P(0).z, 5.0));
  var me : array<vec3<f32>, 9>;
  for (var k = 0; k < 9; k++) { me[k] = patchAt(fr, q, t, k); }
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  let rs = P(0).z / f32(max(r, 1));
  for (var j = -r; j <= r; j++) {
    for (var i = -r; i <= r; i++) {
      let qq = q + vec2<f32>(f32(i), f32(j)) * t * rs;
      var dist = 0.0;
      for (var k = 0; k < 9; k++) {
        let dv = patchAt(fr, qq, t, k) - me[k];
        dist += dot(dv, dv);
      }
      let w = exp(-max(dist / 27.0, 0.0) / (h * h));
      acc += vrTap(tex0, fr, qq) * w;
      wsum += w;
    }
  }
  let res = acc / max(wsum, 0.000001);
  let orig = at0(uv);
  // Detail: keep the original where the centre patch has strong structure.
  let gx = me[5] - me[3];
  let gy = me[7] - me[1];
  let edge = clamp(length(vec2<f32>(lumaDisp(gx), lumaDisp(gy))) * 6.0, 0.0, 1.0);
  return mix(res, orig, edge * P(0).w);
}
