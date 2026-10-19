// Crystal Growth: the anisotropy terms of Kobayashi's phase-field model
// (1993) from the phase (tex0 x): eps = epsBar (1 + delta cos(j (theta -
// theta0))) with theta the interface normal's angle — out (eps^2, eps eps',
// d phi / dx, d phi / dy). p0 = (delta, j (arms), theta0, 0).
const DX : f32 = 0.03;
const EPS_BAR : f32 = 0.01;
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = simTexel(tex0);
  let px = (atQ(tex0, uv + vec2<f32>(t.x, 0.0)).x - atQ(tex0, uv - vec2<f32>(t.x, 0.0)).x) / (2.0 * DX);
  let py = (atQ(tex0, uv + vec2<f32>(0.0, t.y)).x - atQ(tex0, uv - vec2<f32>(0.0, t.y)).x) / (2.0 * DX);
  let th = atan2(py, px);
  let j = P(0).y;
  let a = j * (th - P(0).z);
  let eps = EPS_BAR * (1.0 + P(0).x * cos(a));
  let epsp = -EPS_BAR * j * P(0).x * sin(a);
  return vec4<f32>(eps * eps, eps * epsp, px, py);
}
