// Volumetric Clouds (docs/PROGRAM_DEEP_EFFECTS.md #27): the camera ray
// (DATA, tex1) through a slab of clouds between the base altitude and the top
// (world y up = -y), density = fractal noise less (1 - coverage), shaped by
// height; lit by the sun with a short light march (Beer-Lambert), a powder
// term and Henyey-Greenstein forward scattering, plus sky ambient.
// p0 = (coverage, density, base altitude, thickness), p1 = (scale, detail,
// wind x, wind z), p2 = (direction toward the sun, sun from the first parallel
// light), p3 = (sun colour, steps), p4 = (sky colour, seed), p5 = (evolution, 0, 0, 0).
fn cloudDensity(p : vec3<f32>, detail : i32) -> f32 {
  let base = -P(0).z;
  let top = base - P(0).w;
  let hf = clamp((base - p.y) / P(0).w, 0.0, 1.0);
  let shape = smoothstep(0.0, 0.12, hf) * smoothstep(1.0, 0.55, hf);
  let q = (p + vec3<f32>(P(1).z, P(5).x * P(1).x, P(1).w)) / P(1).x;
  let n = fbm3(q, P(4).w, detail);
  let d = max(n - (1.0 - P(0).x), 0.0) * shape;
  if (p.y < top || p.y > base) { return 0.0; }
  return d * P(0).y * 0.004;
}
fn hgc(cosT : f32, g : f32) -> f32 {
  let d = 1.0 + g * g - 2.0 * g * cosT;
  return (1.0 - g * g) / (12.566371 * pow(max(d, 0.0001), 1.5));
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let cam = camOf(tex1);
  let d = camRay(cam, compPx(uv));
  let yb = -P(0).z;
  let yt = yb - P(0).w;
  if (abs(d.y) < 0.00001) { return vec4<f32>(0.0); }
  let ta = (yb - cam.eye.y) / d.y;
  let tb = (yt - cam.eye.y) / d.y;
  let t0 = max(min(ta, tb), 0.0);
  let t1 = min(max(ta, tb), t0 + P(0).w * 12.0);
  if (t1 <= t0) { return vec4<f32>(0.0); }
  // The sun: the first parallel light of the comp, or the controls.
  var sun = normalize(P(2).xyz);
  var sunCol = P(3).rgb;
  if (P(2).w > 0.5) {
    let n = lightCount(tex1);
    for (var k = 0; k < 8; k++) {
      if (k >= n) { break; }
      let l = lightOf(tex1, k);
      if (l.kind == 1) {
        sun = -l.aim;
        sunCol = l.col * l.inten;
        break;
      }
    }
  }
  let steps = i32(P(3).w);
  let dt = (t1 - t0) / f32(steps);
  let detail = i32(P(1).y);
  let jitter = hcell(floor(uv * 4096.0), 3.0);
  let phase = mix(hgc(dot(d, sun), 0.6), hgc(dot(d, sun), -0.2), 0.3);
  var acc = vec3<f32>(0.0);
  var trans = 1.0;
  for (var i = 0; i < steps; i++) {
    if (trans < 0.01) { break; }
    let p = cam.eye + d * (t0 + (f32(i) + jitter) * dt);
    let dens = cloudDensity(p, detail);
    if (dens <= 0.0) { continue; }
    // Light march toward the sun.
    var od = 0.0;
    let ls = P(0).w * 0.12;
    for (var j = 1; j <= 4; j++) { od += cloudDensity(p + sun * ls * f32(j), max(detail - 2, 2)) * ls; }
    let beer = exp(-od);
    let powder = 1.0 - exp(-dens * dt * 2.0);
    let hf = clamp((yb - p.y) / P(0).w, 0.0, 1.0);
    let light = sunCol * beer * phase * 6.0 * mix(1.0, powder * 2.0, 0.5) + P(4).rgb * (0.35 + 0.65 * hf);
    let a = 1.0 - exp(-dens * dt);
    acc += trans * a * light;
    trans *= 1.0 - a;
  }
  // Haze toward the horizon (far clouds thin out).
  let haze = exp(-t0 / (P(0).w * 60.0));
  return vec4<f32>(acc * haze, (1.0 - trans) * haze);
}
