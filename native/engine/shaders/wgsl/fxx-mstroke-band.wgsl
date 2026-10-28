// Matte Stroke (docs/PROGRAM_DEEP_EFFECTS.md #57): the stroke's coverage, from
// the matte's distance field (tex0: r = signed distance to the 1/2-contour in
// buffer texels, + outside — fx_distance.hpp) and, dashed, the matte's centroid
// (tex1, fxx-mstroke-centroid). Written to every channel (the glow blurs it).
//
// p0 = (width px, position 0 outside 1 center 2 inside, softness px, behind:
//       the inner edge runs on under the layer, which hides it),
// p1 = (dashed, dash px, gap px, offset px).
//
// Dashes follow the contour's angle about the matte's centroid: the circle of
// the matte's own area (radius R = sqrt(area / pi)) is cut into a whole number
// of dash + gap periods, so the pattern closes without a seam and the dashes
// are their authored length where the contour is that far out. The offset
// slides them along the contour (keyframe it and they march).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let ppt = pxPerOut();
  let k = max(0.5 * (ppt.x + ppt.y), 0.000001);
  let d = at0(uv).r * k;
  let w = max(P(0).x, 0.0);
  if (w <= 0.0) { return vec4<f32>(0.0); }
  let pos = i32(P(0).y);
  var lo = 0.0;
  var hi = w;
  if (pos == 1) { lo = -0.5 * w; hi = 0.5 * w; }
  if (pos == 2) { lo = -w; hi = 0.0; }
  // Half the edge ramp: a texel of antialiasing plus the softness.
  let h = 0.5 * (k + max(P(0).z, 0.0));
  if (P(0).w > 0.5) { lo = lo - 2.0 * h; }
  var cov = smoothstep(-h, h, d - lo) * (1.0 - smoothstep(-h, h, d - hi));
  if (P(1).x > 0.5 && cov > 0.0) {
    let c = at1(uv);
    if (c.w > 0.5) {
      let q = layerPx(uv) - layerPx(c.xy);
      let region = obj.uvRect.zw * outSize();
      let area = c.z * region.x * region.y * ppt.x * ppt.y;
      let r = max(sqrt(area / PI), 1.0);
      let period = max(P(1).y + P(1).z, 0.5);
      let n = max(1.0, round(TAU * r / period));
      let duty = clamp(P(1).y / period, 0.0, 1.0);
      // In periods: the angle about the centroid, less the offset.
      let s = atan2(q.y, q.x) / TAU * n - P(1).w * n / (TAU * r);
      let f = fract(s);
      // The ramp in periods at this texel's own radius.
      let e = max(h / max(TAU * max(length(q), 1.0) / n, 0.0001), 0.0001);
      let dashOn = smoothstep(-e, e, f) * (1.0 - smoothstep(-e, e, f - duty)) + smoothstep(-e, e, f - 1.0);
      cov = cov * clamp(select(dashOn, 1.0, duty >= 1.0), 0.0, 1.0);
    }
  }
  return vec4<f32>(cov);
}
