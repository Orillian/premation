// Image Flares composite: the softened flare (tex1) x a starburst about the
// optical centre x the lens dirt (tex2), over the input (tex0).
// p0 = (mode, intensity, dirt amount, 0), p1 = (starburst, rays, centre fraction x, y).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let f = max(at1(uv).rgb, vec3<f32>(0.0));
  let q = layerPx(uv) / lwh();
  let d = (q - P(1).zw) * lwh();
  let ang = atan2(d.y, d.x);
  let rays = P(1).y;
  let spikes = pow(abs(cos(ang * rays * 0.5)), 12.0);
  let jitter = vnoise(vec2<f32>(ang / TAU * rays * 3.0, 0.5), 19.0);
  let burst = 1.0 + P(1).x * (spikes * 1.5 + jitter * 0.8 - 0.4);
  var dirt = 1.0;
  if (P(0).z > 0.0) {
    let dd = at2(uv);
    dirt = 1.0 + P(0).z * lumaDisp(l2s3(unpremul(dd))) * dd.a;
  }
  return lightOver(base, f * P(0).y * max(burst, 0.0) * dirt, i32(P(0).x));
}
