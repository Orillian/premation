// Painterly: the structure tensor (E, F, G) of the display-space premultiplied
// colour from a Sobel gradient (Kyprianidis et al. 2009).
fn dc(uv : vec2<f32>, o : vec2<f32>) -> vec3<f32> {
  let s = at0(uv + o * texel0());
  return l2s3(unpremul(s)) * s.a;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let gx = (-1.0 * dc(uv, vec2<f32>(-1.0, -1.0)) - 2.0 * dc(uv, vec2<f32>(-1.0, 0.0)) - 1.0 * dc(uv, vec2<f32>(-1.0, 1.0))
            + 1.0 * dc(uv, vec2<f32>(1.0, -1.0)) + 2.0 * dc(uv, vec2<f32>(1.0, 0.0)) + 1.0 * dc(uv, vec2<f32>(1.0, 1.0))) / 4.0;
  let gy = (-1.0 * dc(uv, vec2<f32>(-1.0, -1.0)) - 2.0 * dc(uv, vec2<f32>(0.0, -1.0)) - 1.0 * dc(uv, vec2<f32>(1.0, -1.0))
            + 1.0 * dc(uv, vec2<f32>(-1.0, 1.0)) + 2.0 * dc(uv, vec2<f32>(0.0, 1.0)) + 1.0 * dc(uv, vec2<f32>(1.0, 1.0))) / 4.0;
  return vec4<f32>(dot(gx, gx), dot(gx, gy), dot(gy, gy), 1.0);
}
