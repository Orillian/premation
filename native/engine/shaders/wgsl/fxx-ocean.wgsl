// Ocean (docs/PROGRAM_DEEP_EFFECTS.md #30): the camera ray (DATA, tex1) meets
// the sea plane (world y = sea level, y down); the surface is a spectrum of
// eight Gerstner waves around the wind (each fading out with distance before
// it would alias); Fresnel mixes the water body with the reflected sky and
// sun; foam rides the steep crests; haze closes the horizon. Rays that miss
// the sea see the sky gradient and the sun (or stay transparent).
// p0 = (sea level, wave height, wavelength, choppiness), p1 = (wind x, wind z,
// phase, seed), p2 = (deep colour, foam), p3 = (shallow colour, haze distance),
// p4 = (sky top, draw sky), p5 = (sky horizon), p6 = (sun colour), p7 = (toward the sun).
fn skyAt(d : vec3<f32>) -> vec3<f32> {
  let el = clamp(-d.y, 0.0, 1.0);
  var c = mix(P(5).rgb, P(4).rgb, pow(el, 0.45));
  let sd = max(dot(d, normalize(P(7).xyz)), 0.0);
  c += P(6).rgb * (pow(sd, 900.0) * 30.0 + pow(sd, 12.0) * 0.35);
  return c;
}
// Height and its slope at a sea-plane point (x, z), the crest measure.
fn waves(xz : vec2<f32>, dist : f32, f : f32) -> vec4<f32> {
  let wind = normalize(P(1).xy + vec2<f32>(0.00001));
  var h = 0.0;
  var dx = 0.0;
  var dz = 0.0;
  var crest = 0.0;
  var len = P(0).z;
  var amp = P(0).y;
  for (var i = 0; i < 8; i++) {
    let fi = f32(i);
    let ang = (hcell(vec2<f32>(fi, 3.0), P(1).w) - 0.5) * 1.6;
    let dir = vec2<f32>(wind.x * cos(ang) - wind.y * sin(ang), wind.x * sin(ang) + wind.y * cos(ang));
    let k = TAU / len;
    // A wave smaller than ~3 px at this distance is faded out (no aliasing).
    let fade = clamp((len * f / max(dist, 1.0)) / 6.0 - 0.5, 0.0, 1.0);
    let w = sqrt(9.8 * k * 300.0);
    let ph = k * dot(dir, xz) - w * P(1).z + hcell(vec2<f32>(fi, 7.0), P(1).w) * TAU;
    let s = sin(ph);
    let c = cos(ph);
    let a = amp * fade;
    // Gerstner: sharpened crests (choppiness) — the height profile and its slope.
    let q = P(0).w;
    let hp = a * (s + q * 0.35 * (s * s - 0.5));
    h += hp;
    let slope = a * k * (c + q * 0.7 * s * c);
    dx += dir.x * slope;
    dz += dir.y * slope;
    crest += max(s, 0.0) * a * k * q * fade;
    len *= 0.63;
    amp *= 0.6;
  }
  return vec4<f32>(h, dx, dz, crest);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let cam = camOf(tex1);
  let d = camRay(cam, compPx(uv));
  let sea = P(0).x;
  let drawSky = P(4).w > 0.5;
  if (d.y <= 0.0001 || sea <= cam.eye.y) {
    if (!drawSky) { return vec4<f32>(0.0); }
    return vec4<f32>(skyAt(d), 1.0);
  }
  let t = (sea - cam.eye.y) / d.y;
  let p = cam.eye + d * t;
  let wv = waves(p.xz, t, cam.f);
  let nrm = normalize(vec3<f32>(-wv.y, -1.0, -wv.z));
  let ndv = max(dot(-d, nrm), 0.0);
  let fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  var rd = reflect(d, nrm);
  rd.y = min(rd.y, -0.001);
  let sky = skyAt(rd);
  let sun = normalize(P(7).xyz);
  let body = mix(P(2).rgb, P(3).rgb, clamp(wv.x / max(P(0).y, 0.0001) * 0.4 + 0.45, 0.0, 1.0));
  let sss = P(3).rgb * pow(max(dot(d, sun), 0.0), 4.0) * clamp(wv.x / max(P(0).y, 0.0001), 0.0, 1.0) * 0.6;
  var col = mix(body + sss, sky, fres);
  col += P(6).rgb * pow(max(dot(rd, sun), 0.0), 400.0) * 8.0;
  let foam = smoothstep(0.35, 0.9, wv.w * 2.0) * P(2).w;
  col = mix(col, vec3<f32>(0.92, 0.95, 0.97) * (0.6 + 0.4 * max(dot(nrm, -sun), 0.0)), clamp(foam, 0.0, 1.0));
  let haze = 1.0 - exp(-t / P(3).w);
  col = mix(col, P(5).rgb, haze);
  return vec4<f32>(col, 1.0);
}
