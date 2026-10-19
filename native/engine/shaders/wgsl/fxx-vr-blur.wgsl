// VR Blur (docs/PROGRAM_DEEP_EFFECTS.md #17): one axis of a Gaussian on the
// sphere. Axis 0 runs along the latitude row, its width 1 / cos(latitude)
// (capped at the whole row), wrapping across the seam; axis 1 runs down the
// meridian, crossing the poles. Sigma is frame px at the equator.
// p0 = (frame layout, sigma px, axis, repeat edge pixels).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lay = i32(P(0).x);
  let px = layerPx(uv);
  let fr = vrFrame(px, lay);
  let q = (px - fr.xy) / fr.zw;
  let sigmaPx = P(0).y;
  if (sigmaPx <= 0.0) { return at0(uv); }
  let lat = (0.5 - q.y) * PI;
  var sig = sigmaPx / fr.z;
  var dir = vec2<f32>(1.0, 0.0);
  if (P(0).z > 0.5) {
    sig = sigmaPx / fr.w;
    dir = vec2<f32>(0.0, 1.0);
  } else {
    sig = min(sig / max(cos(lat), 0.02), 0.5);
  }
  let spacing = max(sig * 3.0 / 40.0, 0.25 / max(fr.z, fr.w));
  let n = min(i32(ceil(sig * 3.0 / spacing)), 64);
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var i = -n; i <= n; i++) {
    let o = f32(i) * spacing;
    let w = exp(-0.5 * o * o / (sig * sig));
    var tq = q + dir * o;
    if (P(0).w < 0.5 && P(0).z > 0.5 && (tq.y < 0.0 || tq.y > 1.0)) { continue; }
    acc += vrTap(tex0, fr, tq) * w;
    wsum += w;
  }
  return acc / max(wsum, 0.000001);
}
