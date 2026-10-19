// Volumetric Lights (docs/PROGRAM_DEEP_EFFECTS.md #25): every view ray marched
// through a participating medium up to the scene depth; at each step the
// comp's lights (DATA, tex1) scatter toward the eye (Henyey-Greenstein phase,
// their falloff and cone, fractal density noise), and the medium extinguishes.
// Shafts: a light screened by a 3D layer is tested along the screen line from
// the pixel toward the light against the scene depth (binding 6).
// p0 = (density, anisotropy g, max distance, noise), p1 = (noise scale,
// evolution, steps, seed), p2 = (occlusion, 0, 0, 0).
@group(0) @binding(6) var depthTex : texture_2d<f32>;
fn sceneZ(uv : vec2<f32>) -> f32 {
  let dims = vec2<i32>(textureDimensions(depthTex));
  let ip = clamp(vec2<i32>(uv * vec2<f32>(dims)), vec2<i32>(0), dims - 1);
  return textureLoad(depthTex, ip, 0).r;
}
fn hg(cosT : f32, g : f32) -> f32 {
  let d = 1.0 + g * g - 2.0 * g * cosT;
  return (1.0 - g * g) / (12.566371 * pow(max(d, 0.0001), 1.5));
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let cam = camOf(tex1);
  let px = compPx(uv);
  let d = camRay(cam, px);
  var tMax = P(0).z;
  let useDepth = P(2).x > 0.5;
  var zHere = 1e30;
  if (useDepth) {
    zHere = sceneZ(uv);
    let fwd = max(dot(d, cam.r2), 0.0001);
    if (zHere < 1e20) { tMax = min(tMax, zHere / fwd); }
  }
  let steps = i32(P(1).z);
  let dt = tMax / f32(steps);
  let jitter = hcell(floor(px), 7.0);
  let g = P(0).y;
  let dens0 = P(0).x * 0.00002;
  let n = lightCount(tex1);
  // Per light: its screen visibility (shafts) from this pixel.
  var vis : array<f32, 8>;
  for (var k = 0; k < 8; k++) {
    vis[k] = 1.0;
    if (k >= n || !useDepth) { continue; }
    let l = lightOf(tex1, k);
    if (l.kind < 2) { continue; }
    let ls = camScreen(cam, l.pos);
    if (ls.z <= 1.0) { continue; }
    let luv = compUv(ls.xy);
    var blocked = 0.0;
    for (var s = 1; s <= 12; s++) {
      let q = mix(uv, luv, f32(s) / 13.0);
      if (sceneZ(q) < ls.z - 1.0) { blocked += 1.0; }
    }
    vis[k] = 1.0 - blocked / 12.0;
  }
  var acc = vec3<f32>(0.0);
  var trans = 1.0;
  for (var i = 0; i < steps; i++) {
    let t = (f32(i) + jitter) * dt;
    let p = cam.eye + d * t;
    var dens = dens0;
    if (P(0).w > 0.0) {
      dens *= max(1.0 + P(0).w * (fbm3(p / P(1).x + vec3<f32>(P(1).y * 3.0, 0.0, P(1).y), P(1).w, 4) * 2.0 - 1.0) * 1.6, 0.0);
    }
    if (dens <= 0.0) { continue; }
    var inscatter = vec3<f32>(0.0);
    for (var k = 0; k < 8; k++) {
      if (k >= n) { break; }
      let l = lightOf(tex1, k);
      if (l.kind == 0) {
        inscatter += l.col * l.inten * 0.03;
        continue;
      }
      let la = lightAt(l, p);
      var att = la.w;
      if (l.falloff == 0 && l.kind >= 2) {
        // Unattenuated lights still read as a halo in a medium: a gentle 1/r^2 for the glow alone.
        let r = length(l.pos - p) / 800.0;
        att *= 1.0 / (1.0 + r * r);
      }
      inscatter += l.col * l.inten * att * hg(dot(d, la.xyz), g) * vis[k] * 4.0;
    }
    acc += trans * dens * dt * inscatter;
    trans *= exp(-dens * dt * 0.35);
  }
  return vec4<f32>(acc, 0.0);
}
