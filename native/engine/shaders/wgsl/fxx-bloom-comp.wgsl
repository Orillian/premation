// Lens Bloom composite: the accumulated light (tex1) over the input (tex0),
// brightened by the lens dirt layer's luminance (tex2).
// p0 = (mode, dirt amount, has dirt, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let light = max(at1(uv).rgb, vec3<f32>(0.0));
  var dirt = 1.0;
  if (P(0).z > 0.5) {
    let d = at2(uv);
    dirt = 1.0 + P(0).y * lumaDisp(l2s3(unpremul(d))) * d.a;
  }
  return lightOver(base, light * dirt, i32(P(0).x));
}
