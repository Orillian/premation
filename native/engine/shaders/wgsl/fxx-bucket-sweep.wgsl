// Paint Bucket: one propagation sweep. A matching texel becomes filled when a
// filled texel lies along its row (axis 0) or column (axis 1) within `reach`
// texels with only matching texels between. Alternating sweeps connect any
// region a few turns deep. p0 = (axis, reach, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(tex0));
  let ip = clamp(vec2<i32>(floor(uv * vec2<f32>(dims))), vec2<i32>(0), dims - 1);
  let me = textureLoad(tex0, ip, 0);
  if (me.r < 0.5 || me.g > 0.5) { return me; }
  let dirv = select(vec2<i32>(0, 1), vec2<i32>(1, 0), P(0).x < 0.5);
  let reach = i32(P(0).y);
  var filled = 0.0;
  for (var side = -1; side <= 1; side += 2) {
    var q = ip;
    for (var k = 0; k < reach; k++) {
      q += dirv * side;
      if (q.x < 0 || q.y < 0 || q.x >= dims.x || q.y >= dims.y) { break; }
      let s = textureLoad(tex0, q, 0);
      if (s.r < 0.5) { break; }
      if (s.g > 0.5) {
        filled = 1.0;
        break;
      }
    }
    if (filled > 0.5) { break; }
  }
  return vec4<f32>(me.r, filled, 0.0, 1.0);
}
