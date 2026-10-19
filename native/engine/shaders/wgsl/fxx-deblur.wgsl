// Camera Shake Deblur (docs/PROGRAM_DEEP_EFFECTS.md #52): this frame (tex0)
// and its neighbours (tex1 before, tex2 after), aligned by the flows from
// now (tex3: rg / ba), compared by local sharpness (mean Laplacian energy
// over a window); where a neighbour is sharper by more than the blurriness
// margin, its detail replaces this frame's. p0 = (blurriness, window px, 0, 0).
fn lap(t : texture_2d<f32>, uv : vec2<f32>, e : vec2<f32>) -> f32 {
  let c = lumaLin(textureSampleLevel(t, smp, uv, 0.0).rgb);
  let s = lumaLin(textureSampleLevel(t, smp, uv + vec2<f32>(e.x, 0.0), 0.0).rgb) + lumaLin(textureSampleLevel(t, smp, uv - vec2<f32>(e.x, 0.0), 0.0).rgb) +
          lumaLin(textureSampleLevel(t, smp, uv + vec2<f32>(0.0, e.y), 0.0).rgb) + lumaLin(textureSampleLevel(t, smp, uv - vec2<f32>(0.0, e.y), 0.0).rgb);
  return abs(s - 4.0 * c);
}
fn sharp(t : texture_2d<f32>, uv : vec2<f32>, win : f32) -> f32 {
  let e = texel0();
  var acc = 0.0;
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      acc += lap(t, uv + dpxUv(vec2<f32>(f32(i), f32(j)) * win / 4.0), e);
    }
  }
  return acc / 25.0;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let fl = at3(uv);
  let win = P(0).y;
  let s0 = sharp(tex0, uv, win);
  let s1 = sharp(tex1, uv + fl.rg, win);
  let s2 = sharp(tex2, uv + fl.ba, win);
  let margin = 1.0 + (1.0 - P(0).x) * 0.8;
  var res = at0(uv);
  var best = s0 * margin;
  if (s1 > best) {
    best = s1;
    res = at1(uv + fl.rg);
  }
  if (s2 > best) {
    res = at2(uv + fl.ba);
  }
  return res;
}
