// Detail-preserving Upscale (docs/PROGRAM_DEEP_EFFECTS.md #7): the layer
// scaled about its centre by an edge-directed 4 x 4 reconstruction — a
// Lanczos-2 kernel stretched along the local isophote and tightened across it,
// clamped to the four nearest texels (no ringing). Alpha: the same kernel, or
// plain bicubic. p0 = (scale, alpha mode, 0, 0).
fn lanczos2(x : f32) -> f32 {
  let ax = abs(x);
  if (ax < 0.0001) { return 1.0; }
  if (ax >= 2.0) { return 0.0; }
  let px = PI * ax;
  return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}
fn cubic(x : f32) -> f32 {
  let ax = abs(x);
  if (ax <= 1.0) { return (1.5 * ax - 2.5) * ax * ax + 1.0; }
  if (ax < 2.0) { return ((-0.5 * ax + 2.5) * ax - 4.0) * ax + 2.0; }
  return 0.0;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = lwh() * 0.5;
  let src = c + (layerPx(uv) - c) / P(0).x;
  let dims = vec2<f32>(textureDimensions(tex0));
  let st = pxUv(src) * dims - 0.5;
  let base = floor(st);
  let fr = st - base;
  // The local gradient (luma) at the source point.
  let tx = 1.0 / dims;
  let suv = (base + 0.5 + fr) * tx;
  let gx = lumaLin(at0(suv + vec2<f32>(tx.x, 0.0)).rgb) - lumaLin(at0(suv - vec2<f32>(tx.x, 0.0)).rgb);
  let gy = lumaLin(at0(suv + vec2<f32>(0.0, tx.y)).rgb) - lumaLin(at0(suv - vec2<f32>(0.0, tx.y)).rgb);
  let gl = length(vec2<f32>(gx, gy));
  let nrm = select(vec2<f32>(1.0, 0.0), vec2<f32>(gx, gy) / gl, gl > 0.00001);
  let tng = vec2<f32>(-nrm.y, nrm.x);
  let edge = clamp(gl * 6.0, 0.0, 1.0);
  let along = 1.0 + edge * 0.9;
  let across = 1.0 + edge * 0.35;
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  var aAcc = 0.0;
  var aw = 0.0;
  var lo = vec4<f32>(1e9);
  var hi = vec4<f32>(-1e9);
  for (var j = -1; j <= 2; j++) {
    for (var i = -1; i <= 2; i++) {
      let o = vec2<f32>(f32(i), f32(j));
      let d = o - fr;
      let s = textureLoad(tex0, vec2<i32>(clamp(base + o, vec2<f32>(0.0), dims - 1.0)), 0);
      let w = lanczos2(dot(d, tng) / along) * lanczos2(dot(d, nrm) * across);
      acc += s * w;
      wsum += w;
      let wb = cubic(d.x) * cubic(d.y);
      aAcc += s.a * wb;
      aw += wb;
      if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
        lo = min(lo, s);
        hi = max(hi, s);
      }
    }
  }
  var res = clamp(acc / select(1.0, wsum, abs(wsum) > 0.00001), lo, hi);
  if (P(0).y > 0.5) {
    let a = clamp(aAcc / select(1.0, aw, abs(aw) > 0.00001), 0.0, 1.0);
    let straight = unpremul(res);
    res = vec4<f32>(straight * a, a);
  }
  return res;
}
