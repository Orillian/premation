// Shine rays: eight taps toward the source point over a fraction p0.z of the
// distance; three passes at L, L/8, L/64 compose to 512 taps per ray.
// p0 = (source px x, y, scale, falloff exponent).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let s = pxUv(P(0).xy);
  let len = P(0).z;
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 8; i++) {
    let f = len * f32(i) / 8.0;
    let w = pow(max(1.0 - f, 0.0), P(0).w);
    acc += at0(s + (uv - s) * (1.0 - f)) * w;
    wsum += w;
  }
  return acc / max(wsum, 0.00001);
}
