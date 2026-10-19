// Burn Dissolve (docs/PROGRAM_DEEP_EFFECTS.md #53): a burning front — a
// domain-warped fractal field (and a travel direction) crossing the
// completion — eats the layer; just ahead of it the ember band glows (hot
// at the very edge), behind it a band of char darkens what is left. Pass 1
// (p5.x = 1) writes the embers' light alone (for the glow's blur); pass 2
// composites the layer, the char and the embers with the blurred glow (tex1).
// p0 = (completion, scale px, warp, directionality), p1 = (direction x, y,
// ember width px, char width px), p2 = (ember colour, seed), p3 = (hot
// colour, glow), p4 = (char colour, 0), p5 = (pass, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let px = layerPx(uv);
  let sd = P(2).w;
  let sc = P(0).y;
  let q = px / sc;
  let w = vec2<f32>(fbmT(q * 0.7, 0.0, sd + 3.0, 3), fbmT(q * 0.7 + vec2<f32>(5.2, 1.3), 0.0, sd + 7.0, 3)) - 0.5;
  var v = fbmT(q + w * P(0).z, 0.0, sd, 5);
  // The travel direction: a ramp across the layer.
  let ramp = dot(px / lwh() - 0.5, P(1).xy) + 0.5;
  v = mix(v, ramp, P(0).w);
  // The front sweeps from below the field to above it.
  let c = mix(-0.1, 1.1, P(0).x);
  let slope = max(length(vec2<f32>(dpdx(v), dpdy(v))), 0.00001);
  let dist = (v - c) / slope;  // ≈ px ahead of the front (screen space)
  let pxs = 1.0 / max(pxPerOut().x, 0.00001);
  let ew = P(1).z * pxs;
  let cw = P(1).w * pxs;
  let alive = smoothstep(-0.7, 0.7, dist);
  let ember = smoothstep(0.0, ew * 0.25, dist) * (1.0 - smoothstep(ew * 0.25, ew, dist));
  let hot = 1.0 - smoothstep(0.0, ew * 0.35, dist);
  let flick = 0.75 + 0.5 * vnoise(q * 6.0, sd + 11.0);
  let emberLight = mix(P(2).rgb, P(3).rgb, hot) * ember * flick * 3.0 * base.a;
  if (P(5).x > 0.5) { return vec4<f32>(emberLight, 0.0); }
  let charK = (1.0 - smoothstep(ew, ew + cw, dist)) * alive;
  let d = unpremul(base);
  let charred = mix(d, P(4).rgb, clamp(charK * 0.9, 0.0, 1.0));
  let a = base.a * alive;
  let body = vec4<f32>(charred * a + emberLight, max(a, clamp(lumaLin(emberLight), 0.0, 1.0)));
  let glow = max(at1(uv).rgb, vec3<f32>(0.0)) * P(3).w;
  return lightOver(body, glow, 0);
}
