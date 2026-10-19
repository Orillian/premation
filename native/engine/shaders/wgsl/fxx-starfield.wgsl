// Starfield (docs/PROGRAM_DEEP_EFFECTS.md #28): stars at hashed points of a
// 3-D grid in world space, visited cell by cell along the camera ray (3-D DDA)
// so they parallax and recede truly; each a constant-size soft point that
// fades with depth, twinkles, and takes a colour temperature. A fractal nebula
// of the ray's direction sits behind.
// p0 = (density, size px, brightness, colour spread), p1 = (twinkle, time,
// depth range, seed), p2 = (nebula, nebula scale, 0, 0), p3, p4 = nebula colours.
fn starColor(h : f32, spread : f32) -> vec3<f32> {
  let warm = vec3<f32>(1.0, 0.78, 0.55);
  let cool = vec3<f32>(0.62, 0.75, 1.0);
  let k = (h - 0.5) * 2.0 * spread;
  return select(mix(vec3<f32>(1.0), warm, k), mix(vec3<f32>(1.0), cool, -k), k < 0.0);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let cam = camOf(tex1);
  let px = compPx(uv);
  let d = camRay(cam, px);
  let range = P(1).z;
  let cell = range / 24.0;
  let seedv = P(1).w;
  // 3-D DDA through the grid from the eye.
  var ic = floor(cam.eye / cell);
  let stepv = sign(d);
  let inv = 1.0 / max(abs(d), vec3<f32>(0.00001));
  var tmax = ((ic + max(stepv, vec3<f32>(0.0))) * cell - cam.eye) / select(d, vec3<f32>(0.00001), abs(d) < vec3<f32>(0.00001));
  tmax = abs(tmax);
  let tdelta = cell * inv;
  var acc = vec3<f32>(0.0);
  let pxSize = P(0).y;
  let prob = clamp(P(0).x * 0.35, 0.0, 1.0);
  for (var i = 0; i < 64; i++) {
    let h = hash3(ic, seedv);
    if (h < prob) {
      let off = vec3<f32>(hash3(ic, seedv + 11.0), hash3(ic, seedv + 23.0), hash3(ic, seedv + 37.0));
      let sp = (ic + off) * cell;
      let rel = sp - cam.eye;
      let tz = dot(rel, d);
      if (tz > cell * 0.25) {
        let s = camScreen(cam, sp);
        let dist = length(s.xy - px);
        let core = exp(-dist * dist / (pxSize * pxSize));
        let fade = 1.0 - smoothstep(range * 0.4, range, tz);
        let tw = 1.0 - P(1).x * 0.5 * (1.0 + sin(P(1).y * (3.0 + h * 9.0) + h * 61.0));
        let mag = pow(hash3(ic, seedv + 51.0), 3.0) * 2.5 + 0.2;
        acc += starColor(hash3(ic, seedv + 71.0), P(0).w) * core * fade * tw * mag;
      }
    }
    // Next cell.
    if (tmax.x < tmax.y && tmax.x < tmax.z) {
      ic.x += stepv.x;
      tmax.x += tdelta.x;
    } else if (tmax.y < tmax.z) {
      ic.y += stepv.y;
      tmax.y += tdelta.y;
    } else {
      ic.z += stepv.z;
      tmax.z += tdelta.z;
    }
    if (min(tmax.x, min(tmax.y, tmax.z)) > range) { break; }
  }
  var col = acc * P(0).z;
  var alpha = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  if (P(2).x > 0.0) {
    let q = d * (range / P(2).y);
    let n1 = fbm3(q, seedv + 91.0, 5);
    let n2 = fbm3(q * 1.7 + vec3<f32>(5.2, 1.3, 9.1), seedv + 97.0, 4);
    let neb = pow(max(n1 - 0.35, 0.0) * 1.6, 1.6) * P(2).x;
    let nc = mix(P(3).rgb, P(4).rgb, smoothstep(0.3, 0.7, n2)) * neb;
    col += nc;
    alpha = clamp(alpha + lumaLin(nc) * 1.5, 0.0, 1.0);
  }
  return vec4<f32>(col, alpha);
}
