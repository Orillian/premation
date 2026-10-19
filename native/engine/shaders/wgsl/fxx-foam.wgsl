// Foam (docs/PROGRAM_DEEP_EFFECTS.md #45): soap bubbles born from the
// producer (each a pure function of its index and the time): rising, carried
// by wind, wobbling, growing, popping at the end of life; each a thin film —
// interference colour shifting with the film's thickness, a rim, a highlight.
// p0 = (producer px x, y, width, height), p1 = (rate, lifespan, size, size
// variance), p2 = (growth, rise speed, wind x, y), p3 = (wobble, iridescence,
// reflection, opacity), p4 = (time, seed, composite, count).
fn hb(i : f32, s : f32) -> f32 { return hcell(vec2<f32>(i, s), P(4).y); }
fn film(th : f32) -> vec3<f32> {
  // Thin-film interference: three wavelengths' phase through the film.
  return 0.5 + 0.5 * cos(TAU * (vec3<f32>(th) * vec3<f32>(1.0, 0.83, 0.67) + vec3<f32>(0.0, 0.33, 0.67)));
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let px = layerPx(uv);
  let t = P(4).x;
  let rate = P(1).x;
  let life = P(1).y;
  let n = i32(P(4).w);
  let i0 = floor((t - life) * rate);
  var acc = vec4<f32>(0.0);
  for (var j = 0; j <= 320; j++) {
    if (j > n) { break; }
    let i = i0 + f32(j);
    let birth = i / rate;
    let age = t - birth;
    if (birth < 0.0 || age < 0.0 || age >= life) { continue; }
    let u = age / life;
    let p0 = P(0).xy + (vec2<f32>(hb(i, 1.0), hb(i, 2.0)) - 0.5) * P(0).zw;
    let vel = vec2<f32>(0.0, -P(2).y * (0.7 + 0.6 * hb(i, 3.0))) + P(2).zw;
    let sway = vec2<f32>(sin(age * (1.6 + hb(i, 4.0)) + hb(i, 5.0) * 6.28), cos(age * 1.1 + hb(i, 6.0) * 6.28) * 0.4) * P(3).x * 12.0;
    let c = p0 + vel * age + sway;
    var r = P(1).z * (1.0 - P(1).w * (hb(i, 7.0) - 0.5)) * (1.0 + P(2).x * age * 0.3);
    // The pop: the last 8 % swells and vanishes.
    let pop = smoothstep(0.92, 1.0, u);
    r *= 1.0 + pop * 0.15;
    let d = length(px - c);
    if (d > r) { continue; }
    let x = d / r;
    // A wobbling outline.
    let ang = atan2(px.y - c.y, px.x - c.x);
    let wob = 1.0 + 0.04 * P(3).x * sin(ang * 3.0 + age * 5.0 + hb(i, 8.0) * 6.28);
    if (x > wob) { continue; }
    let rim = smoothstep(0.62, 1.0, x / wob);
    let th = x * 1.4 + age * 0.15 + fbmT((px - c) / r * 2.0, age * 0.5, hb(i, 9.0) * 100.0, 2) * 0.8;
    let irid = mix(vec3<f32>(1.0), film(th), clamp(P(3).y, 0.0, 1.0));
    let hl = smoothstep(0.18, 0.0, length((px - c) / r - vec2<f32>(-0.35, -0.38))) * P(3).z;
    let a = clamp((0.06 + rim * 0.55) * P(3).w * (1.0 - pop) + hl * 0.8, 0.0, 1.0);
    let col = s2l3(clamp(irid * (0.55 + rim * 0.6) + vec3<f32>(hl), vec3<f32>(0.0), vec3<f32>(1.0)));
    acc = vec4<f32>(col * a, a) + acc * (1.0 - a);
  }
  if (i32(P(4).z) == 1) { return acc; }
  return acc + base * (1.0 - acc.a);
}
