// Optical flow, one pyramid level (docs/PROGRAM_DEEP_EFFECTS.md X1): iterative
// Lucas-Kanade over a Gaussian-weighted 5 x 5 window. tex0 = the level's
// luminance pair (r from, g to), tex1 = the coarser level's flow (rg, buffer
// uv) to start from. Out: rg = the flow from `from` to `to` (buffer uv),
// b = confidence (the structure tensor's smaller eigenvalue).
// p0 = (iterations, start from tex1, window radius, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = 1.0 / vec2<f32>(textureDimensions(tex0));
  var f = vec2<f32>(0.0);
  if (P(0).y > 0.5) { f = at1(uv).rg; }
  // The window's gradients and values of `from`, once.
  var ix : array<f32, 25>;
  var iy : array<f32, 25>;
  var ia : array<f32, 25>;
  var wt : array<f32, 25>;
  var g11 = 0.0;
  var g12 = 0.0;
  var g22 = 0.0;
  for (var k = 0; k < 25; k++) {
    let o = vec2<f32>(f32(k % 5 - 2), f32(k / 5 - 2));
    let q = uv + o * t;
    let gx = (at0(q + vec2<f32>(t.x, 0.0)).r - at0(q - vec2<f32>(t.x, 0.0)).r) * 0.5;
    let gy = (at0(q + vec2<f32>(0.0, t.y)).r - at0(q - vec2<f32>(0.0, t.y)).r) * 0.5;
    let w = exp(-dot(o, o) / 4.5);
    ix[k] = gx;
    iy[k] = gy;
    ia[k] = at0(q).r;
    wt[k] = w;
    g11 += w * gx * gx;
    g12 += w * gx * gy;
    g22 += w * gy * gy;
  }
  let det = g11 * g22 - g12 * g12;
  let tr = g11 + g22;
  let minEig = 0.5 * (tr - sqrt(max(tr * tr - 4.0 * det, 0.0)));
  if (det > 1e-9) {
    let iters = i32(P(0).x);
    for (var it = 0; it < 8; it++) {
      if (it >= iters) { break; }
      var b1 = 0.0;
      var b2 = 0.0;
      for (var k = 0; k < 25; k++) {
        let o = vec2<f32>(f32(k % 5 - 2), f32(k / 5 - 2));
        let dt = at0(uv + o * t + f).g - ia[k];
        b1 += wt[k] * ix[k] * dt;
        b2 += wt[k] * iy[k] * dt;
      }
      let d = -vec2<f32>(g22 * b1 - g12 * b2, g11 * b2 - g12 * b1) / det;
      f += clamp(d, vec2<f32>(-2.0), vec2<f32>(2.0)) * t;
    }
  }
  return vec4<f32>(f, clamp(minEig * 400.0, 0.0, 1.0), 1.0);
}
