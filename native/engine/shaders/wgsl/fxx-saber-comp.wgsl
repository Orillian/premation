// Energy Saber composite: the white-hot core (tex1) inside its coloured glow
// (tex2), over the layer (tex0) or on black / alone.
// p0 = (core colour, composite 0 add 1 screen 2 black background 3 transparent),
// p1 = (glow colour, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let core = at1(uv).r;
  let glow = max(at2(uv).r, 0.0);
  // The core whitens as it saturates; the glow carries the colour.
  let hot = clamp(core, 0.0, 1.0);
  let light = mix(P(1).rgb, P(0).rgb, hot) * core * 1.5 + P(1).rgb * glow;
  let mode = i32(P(0).w);
  if (mode == 2) { return vec4<f32>(light, 1.0); }
  if (mode == 3) { return lightOver(vec4<f32>(0.0), light, 3); }
  return lightOver(base, light, select(0, 1, mode == 1));
}
