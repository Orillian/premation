// Match Grain, reduction stage 2: the strip (tex0) to the grain's standard
// deviation per channel (rgb), the same in every texel.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var acc = vec4<f32>(0.0);
  for (var i = 0; i < 256; i++) { acc += textureLoad(tex0, vec2<i32>(i, 0), 0); }
  let n = max(acc.a, 1.0);
  return vec4<f32>(sqrt(acc.rgb / n), 1.0);
}
