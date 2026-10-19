// Energy Saber (docs/PROGRAM_DEEP_EFFECTS.md #14): the core's intensity —
// a falloff from the distance to the mask path (DATA, tex1: polyline with
// cumulative lengths, trimmed by start / end / offset) or from the layer's
// alpha (tex0) — at a point displaced by animated noise, flickering.
// p0 = (alpha core, core size px, softness, seed), p1 = (start, end, offset, 0),
// p2 = (distortion px, scale px, phase, 0), p3 = (flicker, flicker phase, 0, 0).
fn segDist(p : vec2<f32>, a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.000001), 0.0, 1.0);
  return vec2<f32>(length(p - (a + ab * t)), t);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let seedv = P(0).w;
  var px = layerPx(uv);
  let dist = P(2).x;
  if (dist > 0.0) {
    let q = px / P(2).y;
    let ph = P(2).z;
    px += (vec2<f32>(fbmT(q, ph, seedv + 3.0, 3), fbmT(q, ph, seedv + 11.0, 3)) - 0.5) * 2.0 * dist;
  }
  let size = max(P(0).y, 0.25);
  var d = 1e9;
  if (P(0).x > 0.5) {
    // Layer alpha: the shape is the core; distance grows outside its edge.
    let a = at0(pxUv(px)).a;
    d = (1.0 - a) * size * 2.0;
  } else {
    let n = i32(fetchF(tex1, 0));
    let total = max(fetchF(tex1, 2), 0.0001);
    let off = P(1).z;
    let s0 = P(1).x;
    let s1 = P(1).y;
    var prev = vec2<f32>(fetchF(tex1, 4), fetchF(tex1, 5));
    var prevL = fetchF(tex1, 6);
    for (var i = 1; i < n; i++) {
      let cur = vec2<f32>(fetchF(tex1, 4 + i * 3), fetchF(tex1, 5 + i * 3));
      let curL = fetchF(tex1, 6 + i * 3);
      let sd = segDist(px, prev, cur);
      // The point's position along the path, offset and wrapped into 0..1.
      var u = (prevL + (curL - prevL) * sd.y) / total - off;
      u = u - floor(u);
      if (u >= s0 && u <= s1) { d = min(d, sd.x); }
      prev = cur;
      prevL = curL;
    }
  }
  let soft = P(0).z;
  var core = 1.0 - smoothstep(size * (1.0 - soft), size, d);
  core += exp(-d / size) * 0.35 * soft;
  let fl = P(3).x;
  if (fl > 0.0) {
    let f = vnoise(vec2<f32>(P(3).y, 0.5), seedv + 29.0);
    core *= 1.0 + (f - 0.5) * 2.0 * fl;
  }
  core = max(core, 0.0);
  return vec4<f32>(core, core, core, clamp(core, 0.0, 1.0));
}
