// VR Fractal Noise (docs/PROGRAM_DEEP_EFFECTS.md #21): fractal noise of the
// direction on the unit sphere (3-D value noise, so no seam and no polar
// pinch), evolving through a fourth axis (two slices blended).
// p0 = (layout, type 0 basic 1 turbulent smooth 2 turbulent sharp 3 max 4 rocky,
// invert, contrast), p1 = (brightness, scale, complexity, evolution (turns)),
// p2 = (seed, opacity, blending 0 none 1 normal 2 multiply 3 screen 4 overlay
// 5 soft light 6 add, 0), p3..p5 = rotation rows.
fn octaves(p0 : vec3<f32>, s : f32, kind : i32, cx : f32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var mx = 0.0;
  var p = p0;
  let n = i32(ceil(cx));
  for (var i = 0; i < 10; i++) {
    if (i >= n) { break; }
    let w = select(1.0, cx - f32(i), f32(i) + 1.0 > cx);
    var v = vnoise3(p, s + f32(i) * 17.0);
    if (kind == 1) { v = abs(v * 2.0 - 1.0); v = v * v * (3.0 - 2.0 * v); }
    if (kind == 2 || kind == 4) { v = abs(v * 2.0 - 1.0); }
    sum += v * amp * w;
    norm += amp * w;
    mx = max(mx, v * w);
    p = p * 2.02 + vec3<f32>(11.7, 5.3, 2.9);
    amp *= 0.5;
  }
  if (kind == 3) { return mx; }
  var r = sum / max(norm, 0.0001);
  if (kind == 4) { r = pow(r, 0.6); }
  return r;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lay = i32(P(0).x);
  let px = layerPx(uv);
  let fr = vrFrame(px, lay);
  let q = (px - fr.xy) / fr.zw;
  let d = rot3(eqDir(q), 3);
  let p = d * (4.0 / P(1).y) + vec3<f32>(17.3, 9.1, 3.7);
  let kind = i32(P(0).y);
  let evo = P(1).w;
  let k = floor(evo);
  let f = evo - k;
  let u = f * f * (3.0 - 2.0 * f);
  let seedv = P(2).x;
  var v = mix(octaves(p, seedv + k * 131.0, kind, P(1).z), octaves(p, seedv + (k + 1.0) * 131.0, kind, P(1).z), u);
  v = (v - 0.5) * P(0).w + 0.5 + P(1).x;
  if (P(0).z > 0.5) { v = 1.0 - v; }
  v = clamp(v, 0.0, 1.0);
  let base = at0(uv);
  let a = toDisp(base);
  let n = vec3<f32>(v);
  var rgb = n;
  var alpha = 1.0;
  switch (i32(P(2).z)) {
    case 1: { rgb = n; }
    case 2: { rgb = blendMode(a.rgb, n, 1); alpha = a.a; }
    case 3: { rgb = blendMode(a.rgb, n, 2); alpha = a.a; }
    case 4: { rgb = blendMode(a.rgb, n, 3); alpha = a.a; }
    case 5: { rgb = blendMode(a.rgb, n, 4); alpha = a.a; }
    case 6: { rgb = blendMode(a.rgb, n, 6); alpha = a.a; }
    default: { rgb = n; }
  }
  if (i32(P(2).z) == 1) {
    let over = fromDisp(rgb, 1.0);
    return mix(base, over, P(2).y);
  }
  return mix(base, fromDisp(rgb, alpha), P(2).y);
}
