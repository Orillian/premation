// Painterly: the anisotropic Kuwahara filter with polynomial sector weights
// (Kyprianidis, Kang and Doellner 2009; Kyprianidis et al. 2010). Eight sectors
// over an ellipse aligned with the smoothed structure tensor (tex1); each
// sector's mean is weighted by 1 / (1 + (255 sigma)^(q/2)). Display space,
// premultiplied (alpha edges count as variance too).
// p0 = (radius px, anisotropy alpha, sharpness q, colour levels),
// p1 = (saturation, fine detail, blend with original, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let g = at1(uv);
  let ee = g.x;
  let ff = g.y;
  let gg = g.z;
  let root = sqrt(max((ee - gg) * (ee - gg) + 4.0 * ff * ff, 0.0));
  let l1 = 0.5 * (ee + gg + root);
  let l2 = 0.5 * (ee + gg - root);
  var tv = vec2<f32>(l1 - ee, -ff);
  tv = select(vec2<f32>(0.0, 1.0), normalize(tv), length(tv) > 0.0);
  let phi = atan2(tv.y, tv.x);
  let an = select(0.0, (l1 - l2) / (l1 + l2), l1 + l2 > 0.0);
  let alpha = P(0).y;
  let r = max(P(0).x / pxPerOut().x, 1.0);
  let a = r * clamp((alpha + an) / alpha, 0.1, 2.0);
  let b = r * clamp(alpha / (alpha + an), 0.1, 2.0);
  let cp = cos(phi);
  let sp = sin(phi);
  let mx = sqrt(a * a * cp * cp + b * b * sp * sp);
  let my = sqrt(a * a * sp * sp + b * b * cp * cp);
  let stp = max(1.0, ceil(max(mx, my) / 7.0));
  let nx = min(i32(floor(mx / stp)), 8);
  let ny = min(i32(floor(my / stp)), 8);
  let zeta = 0.33;
  let eta = (zeta + 0.9238795) / 0.1464466;
  var mc : array<vec4<f32>, 8>;
  var ms : array<vec3<f32>, 8>;
  var mw : array<f32, 8>;
  for (var k = 0; k < 8; k++) {
    mc[k] = vec4<f32>(0.0);
    ms[k] = vec3<f32>(0.0);
    mw[k] = 0.0;
  }
  let tx = texel0();
  for (var j = -ny; j <= ny; j++) {
    for (var i = -nx; i <= nx; i++) {
      let o = vec2<f32>(f32(i), f32(j)) * stp;
      let v = vec2<f32>(cp * o.x + sp * o.y, -sp * o.x + cp * o.y) * vec2<f32>(0.5 / a, 0.5 / b);
      if (dot(v, v) > 0.25) { continue; }
      let s = at0(uv + o * tx);
      let c4 = vec4<f32>(l2s3(unpremul(s)) * s.a, s.a);
      var w : array<f32, 8>;
      var vv = v * 2.0;
      var sum = 0.0;
      var vxx = zeta - eta * vv.x * vv.x;
      var vyy = zeta - eta * vv.y * vv.y;
      var z = max(0.0, vv.y + vxx);
      w[0] = z * z;
      z = max(0.0, -vv.x + vyy);
      w[2] = z * z;
      z = max(0.0, -vv.y + vxx);
      w[4] = z * z;
      z = max(0.0, vv.x + vyy);
      w[6] = z * z;
      vv = 0.70710678 * vec2<f32>(vv.x - vv.y, vv.x + vv.y);
      vxx = zeta - eta * vv.x * vv.x;
      vyy = zeta - eta * vv.y * vv.y;
      z = max(0.0, vv.y + vxx);
      w[1] = z * z;
      z = max(0.0, -vv.x + vyy);
      w[3] = z * z;
      z = max(0.0, -vv.y + vxx);
      w[5] = z * z;
      z = max(0.0, vv.x + vyy);
      w[7] = z * z;
      for (var k = 0; k < 8; k++) { sum += w[k]; }
      let gk = exp(-3.125 * dot(v, v)) / max(sum, 0.000001);
      for (var k = 0; k < 8; k++) {
        let wk = w[k] * gk;
        mc[k] += c4 * wk;
        ms[k] += c4.rgb * c4.rgb * wk;
        mw[k] += wk;
      }
    }
  }
  var o4 = vec4<f32>(0.0);
  var ow = 0.0;
  for (var k = 0; k < 8; k++) {
    if (mw[k] <= 0.0) { continue; }
    let mean = mc[k] / mw[k];
    let vr = abs(ms[k] / mw[k] - mean.rgb * mean.rgb);
    let sg = vr.r + vr.g + vr.b;
    let wt = 1.0 / (1.0 + pow(255.0 * sg, 0.5 * P(0).z));
    o4 += mean * wt;
    ow += wt;
  }
  let orig = at0(uv);
  if (ow <= 0.0) { return orig; }
  let res = o4 / ow;
  if (res.a <= 0.0001) { return vec4<f32>(0.0); }
  var rgb = clamp(res.rgb / res.a, vec3<f32>(0.0), vec3<f32>(1.0));
  let l = lumaDisp(rgb);
  rgb = clamp(mix(vec3<f32>(l), rgb, P(1).x), vec3<f32>(0.0), vec3<f32>(1.0));
  let lv = P(0).w;
  if (lv >= 2.0) { rgb = floor(rgb * (lv - 1.0) + 0.5) / (lv - 1.0); }
  let od = toDisp(orig);
  rgb = clamp(rgb + (lumaDisp(od.rgb) - lumaDisp(rgb)) * P(1).y * 0.6, vec3<f32>(0.0), vec3<f32>(1.0));
  let painted = fromDisp(rgb, res.a);
  return mix(painted, orig, P(1).z);
}
