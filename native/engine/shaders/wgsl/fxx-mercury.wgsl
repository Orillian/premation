// CC Mr. Mercury (docs/PROGRAM_DEEP_EFFECTS.md #44): blobs born from the
// producer (rate per second, each a pure function of its index), flying in
// closed form under velocity, gravity and linear resistance with a wandering
// turbulence, merged as metaballs (field sum r^2 / d^2), the surface shaded as
// liquid metal: a reflected studio gradient, a highlight, the colour.
// p0 = (producer px x, y, radius x, y), p1 = (direction x, y, spread, speed),
// p2 = (rate, longevity, gravity, resistance), p3 = (turbulence, birth size,
// death size, influence), p4 = (time, seed, colour 0 layer 1 mercury 2 custom,
// composite), p5 = (custom colour, light angle), p6 = (specular, reflection, count, 0).
fn hb(i : f32, s : f32) -> f32 { return hcell(vec2<f32>(i, s), P(4).y); }
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let px = layerPx(uv);
  let t = P(4).x;
  let rate = P(2).x;
  let life = P(2).y;
  let n = i32(P(6).z);
  let i0 = floor((t - life) * rate);
  let k = P(2).w * 2.0;
  let g = P(2).z;
  var field = 0.0;
  var grad = vec2<f32>(0.0);
  for (var j = 0; j <= 320; j++) {
    if (j > n) { break; }
    let i = i0 + f32(j);
    let birth = i / rate;
    let age = t - birth;
    if (birth < 0.0 || age < 0.0 || age >= life) { continue; }
    let p0 = P(0).xy + (vec2<f32>(hb(i, 1.0), hb(i, 2.0)) * 2.0 - 1.0) * P(0).zw;
    let ang = atan2(P(1).y, P(1).x) + (hb(i, 3.0) - 0.5) * P(1).z * PI;
    let v0 = vec2<f32>(cos(ang), sin(ang)) * P(1).w * (0.7 + 0.6 * hb(i, 4.0));
    var p = p0 + v0 * age + vec2<f32>(0.0, 0.5 * g * age * age);
    if (k > 0.0001) {
      let e = 1.0 - exp(-k * age);
      p = p0 + (v0 - vec2<f32>(0.0, g / k)) * e / k + vec2<f32>(0.0, g * age / k);
    }
    p += vec2<f32>(sin(age * 2.3 + hb(i, 5.0) * 6.28), cos(age * 1.7 + hb(i, 6.0) * 6.28)) * P(3).x * 30.0 * age;
    let u = age / life;
    let r = mix(P(3).y, P(3).z, u) * (0.75 + 0.5 * hb(i, 7.0));
    // A compact (Wyvill) kernel: blobs merge only when they meet.
    let d = px - p;
    let rr = r * 2.0;
    let x = dot(d, d) / (rr * rr);
    if (x >= 1.0) { continue; }
    let k1 = 1.0 - x;
    field += k1 * k1 * k1;
    grad += -6.0 * k1 * k1 * d / (rr * rr);
  }
  let f = field * P(3).w;
  let cov = smoothstep(0.32, 0.42, f);
  if (cov <= 0.0) {
    if (i32(P(4).w) == 1) { return vec4<f32>(0.0); }
    return base;
  }
  // The surface: a height rising with the field; its normal from the field's gradient.
  let nrm = normalize(vec3<f32>(-grad * P(3).w * 40.0, 1.0));
  let la = P(5).w;
  let lgt = normalize(vec3<f32>(cos(la), sin(la), 0.9));
  let rv = reflect(vec3<f32>(0.0, 0.0, -1.0), nrm);
  // A studio sky in the reflection: bright top, dark band, warm floor.
  let sky = mix(vec3<f32>(0.12, 0.13, 0.15), vec3<f32>(1.0, 1.0, 1.0), smoothstep(-0.3, 0.5, -rv.y)) + vec3<f32>(0.25, 0.18, 0.12) * smoothstep(0.2, 0.9, rv.y);
  var col = P(5).rgb;
  let mode = i32(P(4).z);
  if (mode == 0) { col = unpremul(at0(pxUv(P(0).xy))); }
  if (mode == 1) { col = vec3<f32>(0.55, 0.58, 0.62); }
  let diff = max(dot(nrm, lgt), 0.0);
  let spec = pow(max(dot(reflect(-lgt, nrm), vec3<f32>(0.0, 0.0, 1.0)), 0.0), 60.0) * P(6).x;
  let shaded = col * (0.25 + 0.75 * diff) * (1.0 - P(6).y) + col * sky * P(6).y + vec3<f32>(spec);
  let blob = vec4<f32>(shaded * cov, cov);
  if (i32(P(4).w) == 1) { return blob; }
  return blob + base * (1.0 - cov);
}
