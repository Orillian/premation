// A generated sky element (tex1, premultiplied) with the input (tex0):
// 0 over the layer, 1 behind it, 2 alone. p0 = (mode, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let sky = at1(uv);
  let mode = i32(P(0).x);
  if (mode == 1) { return base + sky * (1.0 - base.a); }
  if (mode == 2) { return sky; }
  return sky + base * (1.0 - sky.a);
}
