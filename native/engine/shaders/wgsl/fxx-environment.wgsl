// CC Environment (docs/PROGRAM_DEEP_EFFECTS.md #29): the camera's view ray
// (DATA, tex1) reflected off the layer's surface (facing the camera, bumped by
// its luminance, tex3) and looked up in the environment layer (tex2, drawn
// where it sits in the comp: its comp-sized frame is the map).
// p0 = (mapping 0 spherical 1 probe 2 vertical cross, horizontal offset,
// bump px, reflectivity), p1 = (fresnel, has environment, 0, 0).
fn hAt(uv : vec2<f32>) -> f32 { return at3(uv).r; }
fn crossUv(r : vec3<f32>) -> vec2<f32> {
  // Vertical cross, 3 x 4: +Y on top, -X +Z +X across, -Y, then -Z (upside down).
  let a = abs(r);
  var f = 0;
  var s = 0.0;
  var t = 0.0;
  if (a.x >= a.y && a.x >= a.z) {
    if (r.x > 0.0) { f = 0; s = -r.z / a.x; t = r.y / a.x; } else { f = 1; s = r.z / a.x; t = r.y / a.x; }
  } else if (a.y >= a.z) {
    if (r.y < 0.0) { f = 2; s = r.x / a.y; t = r.z / a.y; } else { f = 3; s = r.x / a.y; t = -r.z / a.y; }
  } else {
    if (r.z > 0.0) { f = 4; s = r.x / a.z; t = r.y / a.z; } else { f = 5; s = -r.x / a.z; t = -r.y / a.z; }
  }
  let fq = vec2<f32>(s * 0.5 + 0.5, t * 0.5 + 0.5);
  var cell = vec2<f32>(1.0, 1.0);
  switch (f) {
    case 0: { cell = vec2<f32>(2.0, 1.0); }
    case 1: { cell = vec2<f32>(0.0, 1.0); }
    case 2: { cell = vec2<f32>(1.0, 0.0); }
    case 3: { cell = vec2<f32>(1.0, 2.0); }
    case 5: { return (vec2<f32>(1.0, 3.0) + vec2<f32>(1.0) - fq) / vec2<f32>(3.0, 4.0); }
    default: { cell = vec2<f32>(1.0, 1.0); }
  }
  return (cell + fq) / vec2<f32>(3.0, 4.0);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  if (base.a <= 0.0001 || P(1).y < 0.5) { return base; }
  let cam = camOf(tex1);
  let e = dpxUv(vec2<f32>(1.0, 1.0));
  let hx = (hAt(uv + vec2<f32>(e.x, 0.0)) - hAt(uv - vec2<f32>(e.x, 0.0))) * 0.5;
  let hy = (hAt(uv + vec2<f32>(0.0, e.y)) - hAt(uv - vec2<f32>(0.0, e.y))) * 0.5;
  let nrm = normalize(vec3<f32>(-hx * P(0).z, -hy * P(0).z, -1.0));
  let sp = vec3<f32>(compPx(uv), 0.0);
  let v = normalize(sp - cam.eye);
  var r = reflect(v, nrm);
  let ho = P(0).y;
  r = vec3<f32>(r.x * cos(ho) - r.z * sin(ho), r.y, r.x * sin(ho) + r.z * cos(ho));
  var q = vec2<f32>(0.0);
  let mapping = i32(P(0).x);
  if (mapping == 1) {
    // Angular light probe: the direction's angle from -z (toward the viewer) as a radius.
    let rr = acos(clamp(-r.z, -1.0, 1.0)) / PI;
    let l = max(length(r.xy), 0.00001);
    q = vec2<f32>(0.5 + r.x / l * rr * 0.5, 0.5 + r.y / l * rr * 0.5);
  } else if (mapping == 2) {
    q = crossUv(r);
  } else {
    q = vec2<f32>(atan2(r.x, r.z) / TAU + 0.5, 0.5 + asin(clamp(r.y, -1.0, 1.0)) / PI);
  }
  let envc = at2(compUv(q * cam.comp));
  let fres = mix(1.0, pow(1.0 - max(dot(-v, nrm), 0.0), 5.0) * 0.9 + 0.1, P(1).x);
  let k = clamp(P(0).w * fres, 0.0, 1.0);
  let c = unpremul(base);
  let refl = unpremul(envc);
  return vec4<f32>(mix(c, refl, k) * base.a, base.a);
}
