// Relight (docs/PROGRAM_DEEP_EFFECTS.md #26): the layer's surface (normals from
// its height, tex2 r, or a normal map, tex2 rgb) lit by the comp's lights (DATA,
// tex1) as AE lights a 3D layer: Lambert diffuse (with wrap), Blinn-Phong
// specular toward the camera, ambient lights (or a fixed ambient). No lights:
// a built-in key light, or the layer unlit.
// p0 = (normal map, bump depth px, diffuse, wrap), p1 = (specular, shininess,
// ambient, fallback 0 key 1 unlit), p2 = (key light direction (travel), 0), p3 = (key colour, 0).
fn hAt(uv : vec2<f32>) -> f32 { return at2(uv).r; }
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  if (base.a <= 0.0001) { return base; }
  let n0 = lightCount(tex1);
  if (n0 == 0 && P(1).w > 0.5) { return base; }
  var nrm = vec3<f32>(0.0, 0.0, -1.0);
  var h = 0.0;
  if (P(0).x > 0.5) {
    let m = toDisp(at2(uv)).rgb * 2.0 - 1.0;
    nrm = normalize(vec3<f32>(m.x, -m.y, -max(m.z, 0.05)));
  } else {
    let e = dpxUv(vec2<f32>(1.0, 1.0));
    h = hAt(uv);
    let hx = (hAt(uv + vec2<f32>(e.x, 0.0)) - hAt(uv - vec2<f32>(e.x, 0.0))) * 0.5;
    let hy = (hAt(uv + vec2<f32>(0.0, e.y)) - hAt(uv - vec2<f32>(0.0, e.y))) * 0.5;
    nrm = normalize(vec3<f32>(-hx * P(0).y, -hy * P(0).y, -1.0));
  }
  let cam = camOf(tex1);
  let sp = vec3<f32>(compPx(uv), -h * P(0).y);
  let v = normalize(cam.eye - sp);
  var amb = vec3<f32>(0.0);
  var hasAmb = false;
  var diff = vec3<f32>(0.0);
  var spec = vec3<f32>(0.0);
  let wrap = P(0).w;
  for (var k = 0; k < 8; k++) {
    if (k >= n0) { break; }
    let l = lightOf(tex1, k);
    if (l.kind == 0) {
      amb += l.col * l.inten;
      hasAmb = true;
      continue;
    }
    let la = lightAt(l, sp);
    let ld = la.xyz;
    let ndl = max((dot(nrm, ld) + wrap) / (1.0 + wrap), 0.0);
    let hv = normalize(ld + v);
    diff += l.col * l.inten * la.w * ndl;
    spec += l.col * l.inten * la.w * pow(max(dot(nrm, hv), 0.0), P(1).y) * select(0.0, 1.0, dot(nrm, ld) > 0.0);
  }
  if (n0 == 0) {
    let ld = normalize(-P(2).xyz);
    let ndl = max((dot(nrm, ld) + wrap) / (1.0 + wrap), 0.0);
    diff = P(3).rgb * ndl;
    spec = P(3).rgb * pow(max(dot(nrm, normalize(ld + v)), 0.0), P(1).y);
  }
  if (!hasAmb) { amb = vec3<f32>(P(1).z); }
  let c = unpremul(base);
  let lit = c * (amb + diff * P(0).z) + spec * P(1).x;
  return vec4<f32>(max(lit, vec3<f32>(0.0)) * base.a, base.a);
}
