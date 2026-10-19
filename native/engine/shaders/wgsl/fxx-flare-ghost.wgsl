// Image Flares lens system: the highlights mirrored through the optical
// centre, repeated as ghosts along the axis (each at its own scale, with
// chromatic dispersion and a coating tint) plus a halo ring.
// p0 = (ghosts, spacing, ghost size, chroma), p1 = (halo, halo radius, coating, 0),
// p2 = (centre as layer fractions, 0, 0).
fn tapQ(q : vec2<f32>) -> vec3<f32> {
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { return vec3<f32>(0.0); }
  return at0(pxUv(q * lwh())).rgb;
}
fn tapChroma(q : vec2<f32>, d : vec2<f32>) -> vec3<f32> {
  return vec3<f32>(tapQ(q + d).r, tapQ(q).g, tapQ(q - d).b);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let q = layerPx(uv) / lwh();
  let c = P(2).xy;
  let qf = 2.0 * c - q;
  let gv = (c - qf) * P(0).y;
  let n = i32(P(0).x);
  var acc = vec3<f32>(0.0);
  for (var i = 0; i < 12; i++) {
    if (i >= n) { break; }
    let fi = f32(i);
    let sc = mix(0.55, 1.7, fract(fi * 0.618034 + 0.13)) * P(0).z;
    let qi = c + (qf + gv * fi - c) / max(sc, 0.05);
    let d = length(qi - c) / 0.7071;
    let w = pow(max(1.0 - d, 0.0), 2.0);
    let dir = normalize(qi - c + vec2<f32>(0.00001)) * P(0).w * 0.012 * (1.0 + fi * 0.35);
    var col = tapChroma(qi, dir);
    let hue = fract(fi * 0.137 + d * 0.45);
    col *= mix(vec3<f32>(1.0), hsl2rgb(vec3<f32>(hue, 0.85, 0.6)) * 1.7, P(1).z);
    acc += col * w * 0.3;
  }
  let hv = normalize(c - qf + vec2<f32>(0.00001)) * P(1).y * 0.5;
  let hq = qf + hv;
  let wh = pow(max(1.0 - length(hq - c) / 0.7071, 0.0), 5.0);
  let ang = atan2(hq.y - c.y, hq.x - c.x);
  let hcol = mix(vec3<f32>(1.0), hsl2rgb(vec3<f32>(fract(ang / TAU + 0.5), 0.8, 0.6)) * 1.6, P(1).z);
  acc += tapChroma(hq, normalize(hv + vec2<f32>(0.00001)) * P(0).w * 0.02) * wh * P(1).x * hcol * 0.4;
  return vec4<f32>(acc, 0.0);
}
