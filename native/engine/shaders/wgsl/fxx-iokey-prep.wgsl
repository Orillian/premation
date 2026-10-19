// Inner/Outer Key: the picture's straight colour weighted by one sure zone
// (tex1: r foreground, g background) — blurred next, then divided by its alpha
// (normalized convolution) to give each pixel the nearby sure colour.
// p0 = (zone 0 foreground 1 background, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = at0(uv);
  let z = at1(uv);
  let w = select(z.r, z.g, P(0).x > 0.5) * c.a;
  return vec4<f32>(unpremul(c) * w, w);
}
