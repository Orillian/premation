// CC Hair (docs/PROGRAM_DEEP_EFFECTS.md #46): strands rooted on a jittered
// grid wherever the layer is opaque, each a quadratic curve — out along the
// direction (with variance and curl), drooping by its weight, swayed by the
// wind — tapering to the tip, coloured from its root and shaded as a fibre
// (Kajiya-Kay: diffuse and specular from the tangent).
// p0 = (length, length variance, thickness, spacing), p1 = (direction x, y,
// direction variance, weight), p2 = (curl, wind, wind phase, seed), p3 =
// (custom colour, colour 0 layer 1 custom), p4 = (light angle, specular, keep layer, 0).
fn hb(c : vec2<f32>, s : f32) -> f32 { return hcell(c, P(2).w + s); }
fn bez(a : vec2<f32>, b : vec2<f32>, c : vec2<f32>, s : f32) -> vec2<f32> {
  let u = 1.0 - s;
  return u * u * a + 2.0 * u * s * b + s * s * c;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let px = layerPx(uv);
  let sp = P(0).w;
  let len = P(0).x;
  let reach = i32(min(ceil(len / sp) + 1.0, 12.0));
  let cell = floor(px / sp);
  var best = 0.0;
  var bestCol = vec3<f32>(0.0);
  let la = P(4).x;
  let lgt = vec2<f32>(cos(la), sin(la));
  for (var j = -reach; j <= reach; j++) {
    for (var i = -reach; i <= reach; i++) {
      let c = cell + vec2<f32>(f32(i), f32(j));
      let root = (c + vec2<f32>(hb(c, 1.0), hb(c, 2.0))) * sp;
      if (length(px - root) > len * 1.6 + 4.0) { continue; }
      let rootPx = at0(pxUv(root));
      if (rootPx.a < 0.5) { continue; }
      let l = len * (1.0 - P(0).y * hb(c, 3.0));
      let dv = (hb(c, 4.0) - 0.5) * P(1).z * PI * 0.5;
      let dir = vec2<f32>(P(1).x * cos(dv) - P(1).y * sin(dv), P(1).x * sin(dv) + P(1).y * cos(dv));
      let perp = vec2<f32>(-dir.y, dir.x);
      let wind = P(2).y * l * 0.3 * sin(P(2).z + hb(c, 5.0) * 6.28);
      let ctrl = root + dir * l * 0.55 + perp * (P(2).x * l * 0.4 * (hb(c, 6.0) - 0.5));
      let tip = root + dir * l + vec2<f32>(wind, P(1).w * l * 0.5);
      // Nearest point of the curve: 6 chords.
      var prev = root;
      for (var k = 1; k <= 6; k++) {
        let s1 = f32(k) / 6.0;
        let cur = bez(root, ctrl, tip, s1);
        let ab = cur - prev;
        let tt = clamp(dot(px - prev, ab) / max(dot(ab, ab), 0.0001), 0.0, 1.0);
        let d = length(px - (prev + ab * tt));
        let s = s1 - (1.0 - tt) / 6.0;
        let w = P(0).z * (1.0 - s * 0.8);
        let cov = 1.0 - smoothstep(w * 0.5 - 0.4, w * 0.5 + 0.6, d);
        if (cov > best) {
          best = cov;
          let tg = normalize(ab + vec2<f32>(0.00001));
          let tl = dot(tg, lgt);
          let sinTL = sqrt(max(1.0 - tl * tl, 0.0));
          var col = P(3).rgb;
          if (P(3).w < 0.5) { col = unpremul(rootPx); }
          let shade = col * (0.45 + 0.55 * sinTL) * (0.6 + 0.4 * s) + vec3<f32>(pow(sinTL, 40.0) * P(4).y * 0.35);
          bestCol = shade;
        }
        prev = cur;
      }
    }
  }
  let hairC = vec4<f32>(bestCol * best, best);
  if (P(4).z < 0.5) { return hairC; }
  return hairC + base * (1.0 - best);
}
