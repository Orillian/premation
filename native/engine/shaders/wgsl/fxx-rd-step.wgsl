// Reaction-Diffusion: one Gray-Scott step (Pearson 1993) on the state
// (tex0: A, B) with a 3 x 3 Laplacian (0.2 sides, 0.05 corners, -1 centre);
// the feed modulated by the start layer's luminance (tex1).
// p0 = (feed, kill, diffusion A, diffusion B), p1 = (feed map, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = simTexel(tex0);
  let c = atQ(tex0, uv).xy;
  var lap = -c;
  lap += (atQ(tex0, uv + vec2<f32>(t.x, 0.0)).xy + atQ(tex0, uv - vec2<f32>(t.x, 0.0)).xy +
          atQ(tex0, uv + vec2<f32>(0.0, t.y)).xy + atQ(tex0, uv - vec2<f32>(0.0, t.y)).xy) * 0.2;
  lap += (atQ(tex0, uv + t).xy + atQ(tex0, uv - t).xy + atQ(tex0, uv + vec2<f32>(t.x, -t.y)).xy +
          atQ(tex0, uv + vec2<f32>(-t.x, t.y)).xy) * 0.05;
  let src = atQ(tex1, uv);
  let lum = lumaDisp(toDisp(src).rgb) * src.a;
  let f = P(0).x * (1.0 + P(1).x * (lum - 0.5) * 0.8);
  let k = P(0).y;
  let a = c.x;
  let b = c.y;
  let abb = a * b * b;
  let na = a + P(0).z * lap.x - abb + f * (1.0 - a);
  let nb = b + P(0).w * lap.y + abb - (k + f) * b;
  return vec4<f32>(clamp(na, 0.0, 1.0), clamp(nb, 0.0, 1.0), 0.0, 1.0);
}
