// 3D Stroke (docs/PROGRAM_DEEP_EFFECTS.md #32): the mask path's copies,
// projected through the comp camera on the CPU (DATA, tex1: per copy its
// opacity, box and screen points with their thickness scale and path
// fraction), stroked here with trim, loop, taper and feather, shaded by depth,
// far copies first. p0 = (colour, feather), p1 = (start, end, offset, loop),
// p2 = (taper start, taper end, depth fade, composite 0 over 1 alone).
fn trimU(u : f32) -> f32 {
  var v = u - P(1).z;
  if (P(1).w > 0.5) { v = v - floor(v); }
  return v;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let copies = i32(fetchF(tex1, 0));
  let n = i32(fetchF(tex1, 1));
  let nearest = fetchF(tex1, 2);
  let farthest = fetchF(tex1, 3);
  let block = 8 + n * 4;
  let thick = fetchF(tex1, 4 + copies * block);
  let px = compPx(uv);
  let s0 = P(1).x;
  let s1 = P(1).y;
  let span = max(s1 - s0, 0.00001);
  var res = vec4<f32>(0.0);
  for (var k = 0; k < 16; k++) {
    if (k >= copies) { break; }
    let b0 = 4 + k * block;
    let op = fetchF(tex1, b0);
    let reach = thick * fetchF(tex1, b0 + 1) + 2.0;
    let bx = vec4<f32>(fetchF(tex1, b0 + 2), fetchF(tex1, b0 + 3), fetchF(tex1, b0 + 4), fetchF(tex1, b0 + 5));
    if (px.x < bx.x - reach || px.y < bx.y - reach || px.x > bx.z + reach || px.y > bx.w + reach) { continue; }
    let depth = fetchF(tex1, b0 + 6);
    var cov = 0.0;
    var pa = vec4<f32>(fetchF(tex1, b0 + 8), fetchF(tex1, b0 + 9), fetchF(tex1, b0 + 10), fetchF(tex1, b0 + 11));
    for (var i = 1; i < 256; i++) {
      if (i >= n) { break; }
      let o = b0 + 8 + i * 4;
      let pb = vec4<f32>(fetchF(tex1, o), fetchF(tex1, o + 1), fetchF(tex1, o + 2), fetchF(tex1, o + 3));
      let ab = pb.xy - pa.xy;
      let t = clamp(dot(px - pa.xy, ab) / max(dot(ab, ab), 0.000001), 0.0, 1.0);
      let dist = length(px - (pa.xy + ab * t));
      let u = trimU(mix(pa.w, pb.w, t));
      if (u >= s0 && u <= s1) {
        var tp = 1.0;
        if (P(2).x > 0.0) { tp *= smoothstep(0.0, P(2).x * span, u - s0); }
        if (P(2).y > 0.0) { tp *= smoothstep(0.0, P(2).y * span, s1 - u); }
        let r = thick * 0.5 * mix(pa.z, pb.z, t) * tp;
        let soft = max(r * P(0).w, 0.6);
        cov = max(cov, 1.0 - smoothstep(r - soft, r + 0.5, dist));
      }
      pa = pb;
    }
    if (cov <= 0.0) { continue; }
    var shade = 1.0;
    if (P(2).z > 0.5 && farthest > nearest) { shade = mix(1.0, 0.3, clamp((depth - nearest) / (farthest - nearest), 0.0, 1.0)); }
    let a = cov * op;
    res = vec4<f32>(P(0).rgb * shade * a, a) + res * (1.0 - a);
  }
  if (P(2).w > 0.5) { return res; }
  return res + base * (1.0 - res.a);
}
