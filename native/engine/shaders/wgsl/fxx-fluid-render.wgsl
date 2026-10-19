// Fluid Ink composite: the dye (tex1, a SIM slot over the layer box) in the
// layer's colours or a tint, over the layer, alone, or behind it.
// p0 = (tint (linear), colour mode 0 layer 1 tint), p1 = (composite 0 over 1 only 2 behind, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  var ink = atSim(tex1, uv);
  ink = vec4<f32>(max(ink.rgb, vec3<f32>(0.0)), clamp(ink.a, 0.0, 1.0));
  if (P(0).w > 0.5) { ink = vec4<f32>(P(0).rgb * ink.a, ink.a); }
  let mode = i32(P(1).x);
  if (mode == 1) { return ink; }
  if (mode == 2) { return base + ink * (1.0 - base.a); }
  return ink + base * (1.0 - ink.a);
}
