// Matte Stroke composite: the stroke (tex1 coverage) in its colour, its glow
// (tex2, the blurred coverage: emitted light, unbounded) under it, over / behind
// the input (tex0) or alone. Premultiplied linear light.
// p0 = (colour (linear), opacity), p1 = (glow amount, composite 0 on original
// 1 on transparent, behind the layer, has glow).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let op = clamp(P(0).w, 0.0, 1.0);
  let col = max(P(0).rgb, vec3<f32>(0.0));
  let cov = clamp(at1(uv).r, 0.0, 1.0) * op;
  var s = vec4<f32>(col * cov, cov);
  if (P(1).w > 0.5) {
    let g = max(at2(uv).r, 0.0) * max(P(1).x, 0.0) * op;
    s = s + vec4<f32>(col * g, clamp(g, 0.0, 1.0)) * (1.0 - s.a);
  }
  if (P(1).y > 0.5) { return s; }
  if (P(1).z > 0.5) { return base + s * (1.0 - base.a); }
  return s + base * (1.0 - s.a);
}
