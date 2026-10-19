// Liquid Morph Wipe (docs/PROGRAM_DEEP_EFFECTS.md #54): the layer (tex0)
// pushed along a flowing noise field (the curl of a fractal stream function
// plus a drift) that grows with completion, its channels split along the
// flow, melting away where the noise falls under the completion; a target
// layer (tex1) flows in the other way where the layer has gone.
// p0 = (completion, distortion px, scale px, chroma), p1 = (softness, flow
// x, y, has target), p2 = (seed, 0, 0, 0).
fn psi(px : vec2<f32>) -> f32 { return fbmT(px / P(0).z, 0.0, P(2).x, 4); }
fn flowAt(px : vec2<f32>) -> vec2<f32> {
  let e = 2.0;
  let dy = (psi(px + vec2<f32>(0.0, e)) - psi(px - vec2<f32>(0.0, e))) / (2.0 * e);
  let dx = (psi(px + vec2<f32>(e, 0.0)) - psi(px - vec2<f32>(e, 0.0))) / (2.0 * e);
  return vec2<f32>(dy, -dx) * P(0).z * 2.5 + P(1).yz;
}
fn split(t : texture_2d<f32>, px : vec2<f32>, d : vec2<f32>, ch : f32) -> vec4<f32> {
  let o = d * ch * 0.08;
  let r = textureSampleLevel(t, smp, pxUv(px + o), 0.0);
  let g = textureSampleLevel(t, smp, pxUv(px), 0.0);
  let b = textureSampleLevel(t, smp, pxUv(px - o), 0.0);
  return vec4<f32>(r.r, g.g, b.b, max(r.a, max(g.a, b.a)));
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let px = layerPx(uv);
  let c = P(0).x;
  let f = flowAt(px);
  let ease = c * c * (3.0 - 2.0 * c);
  let dA = f * P(0).y * ease;
  let a = split(tex0, px - dA, dA / max(P(0).y, 1.0) * P(0).y, P(0).w);
  let n = psi(px * 0.7 + vec2<f32>(13.0, 7.0));
  let soft = P(1).x * 0.5;
  let keep = 1.0 - smoothstep(n - soft, n + soft, c * (1.0 + 2.0 * soft) - soft);
  let A = a * keep;
  if (P(1).w < 0.5) { return A; }
  let dB = -f * P(0).y * (1.0 - ease);
  let b = split(tex1, px - dB, dB / max(P(0).y, 1.0) * P(0).y, P(0).w);
  return A + b * (1.0 - A.a);
}
