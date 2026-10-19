// Match Grain (docs/PROGRAM_DEEP_EFFECTS.md #50), reduction stage 1: the
// grain of a picture (tex0) — its deviation from its own blur (tex1), display
// values — per strip column: (sum r^2, sum g^2, sum b^2, count) over 64
// samples where the picture is opaque.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var acc = vec4<f32>(0.0);
  for (var j = 0; j < 64; j++) {
    let q = vec2<f32>(uv.x, (f32(j) + 0.5) / 64.0);
    let c = at0(q);
    if (c.a < 0.95) { continue; }
    let hp = toDisp(c).rgb - toDisp(at1(q)).rgb;
    acc += vec4<f32>(hp * hp, 1.0);
  }
  return acc;
}
