// Reaction-Diffusion composite: the B concentration (tex1, a SIM slot) as a
// two-colour pattern, replacing the layer's box, over it, or inside its alpha.
// p0 = (background colour, sharpness), p1 = (pattern colour, composite).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let q = layerPx(uv) / lwh();
  let inside = q.x >= 0.0 && q.y >= 0.0 && q.x <= 1.0 && q.y <= 1.0;
  let b = atSim(tex1, uv).y;
  let w = mix(0.2, 0.01, P(0).w);
  let k = smoothstep(0.22 - w, 0.22 + w, b);
  let col = mix(P(0).rgb, P(1).rgb, k);
  let mode = i32(P(1).w);
  if (mode == 1) { return vec4<f32>(P(1).rgb * k, k) + base * (1.0 - k); }
  if (mode == 2) { return vec4<f32>(col * base.a, base.a); }
  if (!inside) { return base; }
  return vec4<f32>(col, 1.0);
}
