// Aurora (docs/PROGRAM_DEEP_EFFECTS.md #31): the camera ray (DATA, tex1)
// marched through the auroral layer (world altitude .. altitude + height, up =
// -y): curtains are thin ridges of flowing fractal noise across the ground
// plane, bright at the base and fading up, coloured from the lower to the
// upper colour; stars behind. p0 = (intensity, altitude, height, fold scale),
// p1 = (flow phase, steps, seed, stars), p2 = lower colour, p3 = upper colour.
fn curtain(xz : vec2<f32>, ph : f32, s : f32) -> f32 {
  let q = xz / P(0).w;
  let warp = vec2<f32>(fbmT(q * 0.35, ph * 0.15, s, 3), fbmT(q * 0.35 + vec2<f32>(7.1, 3.3), ph * 0.15, s + 5.0, 3));
  let n = fbmT(q * vec2<f32>(0.6, 1.8) + warp * 2.2, ph * 0.3, s + 9.0, 4);
  let ridge = 1.0 - abs(n - 0.5) * 2.0;
  return pow(max(ridge, 0.0), 10.0);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let cam = camOf(tex1);
  let d = camRay(cam, compPx(uv));
  var col = vec3<f32>(0.0);
  var alpha = 0.0;
  // Stars above the horizon.
  if (d.y < 0.0 && P(1).w > 0.0) {
    let lon = atan2(d.x, d.z);
    let lat = asin(clamp(-d.y, -1.0, 1.0));
    let g = vec2<f32>(lon, lat) * 260.0;
    let cellv = floor(g);
    let h = hcell(cellv, P(1).z + 3.0);
    if (h > 0.985) {
      let o = hcell2(cellv, P(1).z + 5.0);
      let dist = length(fract(g) - o);
      let s = exp(-dist * dist * 40.0) * (h - 0.985) * 66.0 * P(1).w;
      col += vec3<f32>(s);
      alpha = max(alpha, clamp(s, 0.0, 1.0));
    }
  }
  if (d.y < -0.0001) {
    let yb = -P(0).y;
    let yt = yb - P(0).z;
    let ta = (yb - cam.eye.y) / d.y;
    let tb = (yt - cam.eye.y) / d.y;
    let t0 = max(min(ta, tb), 0.0);
    let t1 = max(ta, tb);
    if (t1 > t0) {
      let steps = i32(P(1).y);
      let dt = (t1 - t0) / f32(steps);
      let jit = hcell(floor(uv * 4096.0), 11.0);
      var acc = vec3<f32>(0.0);
      for (var i = 0; i < steps; i++) {
        let p = cam.eye + d * (t0 + (f32(i) + jit) * dt);
        let hf = clamp((yb - p.y) / P(0).z, 0.0, 1.0);
        let c = curtain(p.xz, P(1).x, P(1).z);
        let prof = smoothstep(0.0, 0.06, hf) * exp(-hf * 2.6);
        acc += mix(P(2).rgb, P(3).rgb, pow(hf, 0.7)) * c * prof;
      }
      let aur = acc / f32(steps) * P(0).x * 2.4;
      col += aur;
      alpha = max(alpha, clamp(max(aur.r, max(aur.g, aur.b)), 0.0, 1.0));
    }
  }
  return vec4<f32>(col, alpha);
}
