// Match Grain: grain synthesised to match the source's measured deviation
// (tex1) — less the layer's own (tex2) when compensating — as smoothed
// value noise at the grain size (aspect, softness), per channel or
// monochrome, shaped by tone (shadows / midtones / highlights), over the layer.
// p0 = (intensity, size px, softness, aspect), p1 = (compensate, monochrome,
// saturation, frame seed), p2 = (shadows, midtones, highlights, 0).
fn gnoise(px : vec2<f32>, s : f32) -> f32 {
  let g = px / vec2<f32>(P(0).y * P(0).w, P(0).y);
  let crisp = hcell(floor(g), s) - 0.5;
  let soft = vnoise(g, s) - 0.5;
  return mix(crisp, soft, P(0).z) * 3.4;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  if (base.a <= 0.0001) { return base; }
  let src = at1(vec2<f32>(0.5, 0.5)).rgb;
  let own = at2(vec2<f32>(0.5, 0.5)).rgb;
  var amp = src;
  if (P(1).x > 0.5) { amp = sqrt(max(src * src - own * own, vec3<f32>(0.0))); }
  amp *= P(0).x;
  let px = layerPx(uv);
  let sd = P(1).w;
  var n = vec3<f32>(gnoise(px, sd), gnoise(px, sd + 31.0), gnoise(px, sd + 67.0));
  let m = (n.r + n.g + n.b) / 3.0;
  if (P(1).y > 0.5) { n = vec3<f32>(gnoise(px, sd)); } else { n = mix(vec3<f32>(m), n, P(1).z); }
  let d = toDisp(base);
  let l = lumaDisp(d.rgb);
  let tone = P(2).x * (1.0 - smoothstep(0.0, 0.45, l)) + P(2).y * (1.0 - abs(l - 0.5) * 2.0) + P(2).z * smoothstep(0.55, 1.0, l);
  let rgb = d.rgb + n * amp * clamp(tone, 0.0, 4.0);
  return fromDisp(rgb, d.a);
}
