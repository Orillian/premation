// VR Sharpen (docs/PROGRAM_DEEP_EFFECTS.md #24): unsharp masking of the frame
// (tex0) against its spherical blur (tex1), above a threshold.
// p0 = (amount, threshold (display), 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = at0(uv);
  let b = at1(uv);
  let diff = c - b;
  let dl = abs(lumaDisp(l2s3(max(unpremul(c), vec3<f32>(0.0)))) - lumaDisp(l2s3(max(unpremul(b), vec3<f32>(0.0)))));
  let k = select(0.0, P(0).x, dl >= P(0).y);
  let res = c + diff * k;
  return vec4<f32>(max(res.rgb, vec3<f32>(0.0)), clamp(res.a, 0.0, 1.0));
}
