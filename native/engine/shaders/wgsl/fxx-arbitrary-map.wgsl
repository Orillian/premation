// PS Arbitrary Map (docs/PROGRAM_DEEP_EFFECTS.md #15): each display channel
// through its 256-entry table (DATA, tex1: red, green, blue, then the master
// alone for alpha), the index cycled by Phase.
// p0 = (phase 0..1, apply to alpha, 0, 0).
fn lut(ch : i32, v : f32) -> f32 {
  var x = clamp(v, 0.0, 1.0) * 255.0 + P(0).x * 256.0;
  x = x - floor(x / 256.0) * 256.0;
  let i = i32(floor(x));
  let j = (i + 1) % 256;
  let f = x - floor(x);
  return mix(fetchF(tex1, ch * 256 + i), fetchF(tex1, ch * 256 + select(j, i, i == 255)), f);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let d = toDisp(at0(uv));
  let rgb = vec3<f32>(lut(0, d.r), lut(1, d.g), lut(2, d.b));
  let a = select(d.a, lut(3, d.a), P(0).y > 0.5);
  return fromDisp(rgb, a);
}
