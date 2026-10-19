// Crystal Growth composite: the phase (tex1 x, a SIM slot) as the crystal,
// its growing front lit by the latent heat (T) and the phase gradient.
// p0 = (crystal colour (linear), edge glow), p1 = (composite 0 over 1 only 2 frost inside the layer, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let s = atSim(tex1, uv);
  let phi = clamp(s.x, 0.0, 1.0);
  let e = dpxUv(vec2<f32>(1.0, 1.0));
  let gx = atSim(tex1, uv + vec2<f32>(e.x, 0.0)).x - atSim(tex1, uv - vec2<f32>(e.x, 0.0)).x;
  let gy = atSim(tex1, uv + vec2<f32>(0.0, e.y)).x - atSim(tex1, uv - vec2<f32>(0.0, e.y)).x;
  let edge = clamp(length(vec2<f32>(gx, gy)) * 1.5, 0.0, 1.0);
  let heat = clamp(s.y, 0.0, 1.0);
  let col = P(0).rgb * (0.65 + 0.35 * phi) + P(0).rgb * edge * P(0).w * 0.8 + vec3<f32>(heat * 0.2 * P(0).w);
  let a = clamp(max(phi, edge * 0.6), 0.0, 1.0);
  let mode = i32(P(1).x);
  if (mode == 1) { return vec4<f32>(col * a, a); }
  if (mode == 2) { return vec4<f32>(mix(base.rgb, col * base.a, a), base.a); }
  return vec4<f32>(col * a, a) + base * (1.0 - a);
}
