// The straight colour of one picture (tex0) under the alpha of another (tex1):
// a matte feathered without blurring its colour.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = at0(uv);
  let a = clamp(at1(uv).a, 0.0, 1.0);
  var rgb = unpremul(c);
  if (c.a <= 0.00001) {
    // Feathered past the sharp matte: the nearest colour the blur carried.
    rgb = unpremul(at1(uv));
  }
  return vec4<f32>(rgb * a, a);
}
