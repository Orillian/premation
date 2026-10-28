// Matte Stroke, dash frame stage 2: the strip's 256 partials (tex0) to the
// matte's centroid, which every texel of this pass holds: (centroid buffer
// uv x, y, the matte's area as a fraction of the region, 1 = any matte).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var acc = vec4<f32>(0.0);
  for (var i = 0; i < 256; i++) {
    acc += textureLoad(tex0, vec2<i32>(i, 0), 0);
  }
  if (acc.x < 0.001) { return vec4<f32>(0.0); }
  return vec4<f32>(acc.y / acc.x, acc.z / acc.x, acc.x / max(acc.w, 1.0), 1.0);
}
