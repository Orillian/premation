// CC Particle World (docs/PROGRAM_DEEP_EFFECTS.md #48): the particles the CPU
// placed and projected (DATA, tex1: 32 px screen tiles, each a list of
// particles far to near), drawn here per pixel from its tile: lines (a
// streak from last frame's position), faded spheres, shaded spheres, stars
// or bubbles, added or laid over the layer.
// p0 = (type 0 line 1 faded 2 shaded 3 star 4 bubble, composite 0 add 1 over, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let c = compPx(uv);
  let tx = i32(fetchF(tex1, 0));
  let ty = i32(fetchF(tex1, 1));
  let tile = fetchF(tex1, 2);
  let pbase = i32(fetchF(tex1, 3));
  let cell = vec2<i32>(floor(c / tile));
  if (cell.x < 0 || cell.y < 0 || cell.x >= tx || cell.y >= ty) { return base; }
  let ti = cell.y * tx + cell.x;
  let off = i32(fetchF(tex1, 4 + ti * 2));
  let cnt = i32(fetchF(tex1, 5 + ti * 2));
  let idxBase = 4 + tx * ty * 2;
  let kind = i32(P(0).x);
  var acc = vec4<f32>(0.0);
  var add = vec3<f32>(0.0);
  for (var k = 0; k < 96; k++) {
    if (k >= cnt) { break; }
    let pi = i32(fetchF(tex1, idxBase + off + k));
    let b = pbase + pi * 12;
    let pos = vec2<f32>(fetchF(tex1, b), fetchF(tex1, b + 1));
    let r = fetchF(tex1, b + 2);
    let col = vec3<f32>(fetchF(tex1, b + 4), fetchF(tex1, b + 5), fetchF(tex1, b + 6));
    let op = fetchF(tex1, b + 7);
    let prev = vec2<f32>(fetchF(tex1, b + 8), fetchF(tex1, b + 9));
    var a = 0.0;
    var shade = col;
    if (kind == 0) {
      let ab = pos - prev;
      let tt = clamp(dot(c - prev, ab) / max(dot(ab, ab), 0.0001), 0.0, 1.0);
      let d = length(c - (prev + ab * tt));
      a = (1.0 - smoothstep(r * 0.3, r * 0.3 + 1.0, d)) * mix(0.3, 1.0, tt);
    } else {
      let d = length(c - pos) / max(r, 0.3);
      if (kind == 1) { a = exp(-d * d * 2.2); }
      if (kind == 2) {
        a = 1.0 - smoothstep(0.92, 1.0, d);
        let q = (c - pos) / max(r, 0.3);
        let z = sqrt(max(1.0 - dot(q, q), 0.0));
        shade = col * (0.25 + 0.75 * max(dot(normalize(vec3<f32>(q, z)), normalize(vec3<f32>(-0.5, -0.6, 0.6))), 0.0));
      }
      if (kind == 3) {
        let q = (c - pos) / max(r, 0.3);
        a = clamp(exp(-abs(q.x) * 6.0) * exp(-abs(q.y) * 0.8) + exp(-abs(q.y) * 6.0) * exp(-abs(q.x) * 0.8), 0.0, 1.0) * (1.0 - smoothstep(1.8, 2.2, d));
      }
      if (kind == 4) { a = smoothstep(0.7, 0.95, d) * (1.0 - smoothstep(0.95, 1.05, d)) + 0.08 * (1.0 - smoothstep(0.95, 1.0, d)); }
    }
    a *= op;
    if (a <= 0.0) { continue; }
    add += shade * a;
    acc = vec4<f32>(shade * a, a) + acc * (1.0 - a);
  }
  if (i32(P(0).y) == 0) { return lightOver(base, add, 0); }
  return acc + base * (1.0 - acc.a);
}
