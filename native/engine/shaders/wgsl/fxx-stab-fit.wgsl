// Warp Stabilizer (docs/PROGRAM_DEEP_EFFECTS.md #49): one neighbour's motion
// — the optical flow from this frame to it (tex0, buffer uv) sampled on a
// 24 x 14 grid over the layer and fitted by least squares with a similarity
// (x' = a x - b y + tx, y' = b x + a y + ty; layer coordinates about the
// centre in half-widths) or a translation. Only strip texel k draws.
// p0 = (k, method 0 position 1 position+scale+rotation, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let k = i32(P(0).x);
  if (i32(floor(uv.x * 256.0)) != k) { discard; }
  let hb2 = lwh() * 0.5;
  var sw = 0.0;
  var sx = 0.0;
  var sy = 0.0;
  var su = 0.0;
  var sv = 0.0;
  var sxx = 0.0;
  var sxu = 0.0;
  var sxv = 0.0;
  for (var j = 0; j < 14; j++) {
    for (var i = 0; i < 24; i++) {
      let px = vec2<f32>((f32(i) + 0.5) / 24.0, (f32(j) + 0.5) / 14.0) * lwh();
      let f = at0(pxUv(px));
      let w = clamp(f.b, 0.05, 1.0);
      // The flow in layer px, then in the fit's units.
      let dpx = f.rg / max(dpxUv(vec2<f32>(1.0, 1.0)), vec2<f32>(0.000001));
      let x = (px - hb2) / hb2.x;
      let d = dpx / hb2.x;
      sw += w;
      sx += w * x.x;
      sy += w * x.y;
      su += w * d.x;
      sv += w * d.y;
      sxx += w * dot(x, x);
      sxu += w * (x.x * d.x + x.y * d.y);
      sxv += w * (x.x * d.y - x.y * d.x);
    }
  }
  let tx0 = su / max(sw, 0.00001);
  let ty0 = sv / max(sw, 0.00001);
  if (P(0).y < 0.5) { return vec4<f32>(0.0, 0.0, tx0, ty0); }
  // Similarity on (x, x + d): centred moments give the rotation-scale part.
  let mx = sx / max(sw, 0.00001);
  let my = sy / max(sw, 0.00001);
  let var2 = sxx / max(sw, 0.00001) - (mx * mx + my * my);
  let cxu = sxu / max(sw, 0.00001) - (mx * tx0 + my * ty0);
  let cxv = sxv / max(sw, 0.00001) - (mx * ty0 - my * tx0);
  let da = select(0.0, cxu / var2, var2 > 0.0001);
  let db = select(0.0, cxv / var2, var2 > 0.0001);
  // (a - 1, b): the motion's scale-rotation; t so the means map.
  let tx = tx0 - (da * mx - db * my);
  let ty = ty0 - (db * mx + da * my);
  return vec4<f32>(clamp(da, -0.5, 0.5), clamp(db, -0.5, 0.5), tx, ty);
}
