// Matte Stroke (docs/PROGRAM_DEEP_EFFECTS.md #57), dash frame stage 1: each of
// the strip's 256 texels sums one column of 64 taps of the matte's alpha
// (tex0) over the buffer region the chain shows: (sum a, sum a * u, sum a * v,
// taps). fxx-mstroke-centroid reduces the strip to the matte's centroid.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var acc = vec4<f32>(0.0, 0.0, 0.0, 64.0);
  for (var j = 0; j < 64; j++) {
    let q = vec2<f32>(uv.x, obj.uvRect.y + (f32(j) + 0.5) / 64.0 * obj.uvRect.w);
    let a = clamp(at0(q).a, 0.0, 1.0);
    acc += vec4<f32>(a, a * q.x, a * q.y, 0.0);
  }
  return acc;
}
