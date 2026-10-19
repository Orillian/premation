// Denoiser (docs/PROGRAM_DEEP_EFFECTS.md #40): the frames before (tex1) and
// after (tex2), motion-compensated by the flows from now to each (tex3 rg /
// ba, buffer uv), averaged into this frame (tex0) where they agree with it —
// a sample unlike the centre (an occlusion, a new object) is rejected — then
// detail (the local contrast) kept. p0 = (temporal strength, detail, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = at0(uv);
  let fl = at3(uv);
  let p = at1(uv + fl.rg);
  let n = at2(uv + fl.ba);
  let cd = l2s3(max(unpremul(c), vec3<f32>(0.0)));
  let pd = l2s3(max(unpremul(p), vec3<f32>(0.0)));
  let nd = l2s3(max(unpremul(n), vec3<f32>(0.0)));
  let sigma = 0.05 + 0.15 * P(0).x;
  let wp = exp(-dot(pd - cd, pd - cd) / (sigma * sigma)) * P(0).x;
  let wn = exp(-dot(nd - cd, nd - cd) / (sigma * sigma)) * P(0).x;
  let avg = (c + p * wp + n * wn) / (1.0 + wp + wn);
  // Detail: where the frame has local contrast, keep more of it.
  let t = texel0();
  let e = abs(lumaLin(at0(uv + vec2<f32>(t.x, 0.0)).rgb) - lumaLin(at0(uv - vec2<f32>(t.x, 0.0)).rgb)) +
          abs(lumaLin(at0(uv + vec2<f32>(0.0, t.y)).rgb) - lumaLin(at0(uv - vec2<f32>(0.0, t.y)).rgb));
  return mix(avg, c, clamp(e * 4.0, 0.0, 1.0) * P(0).y);
}
