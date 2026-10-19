// Watercolor (docs/PROGRAM_DEEP_EFFECTS.md #5): the abstracted picture (tex0)
// and its bled copy (tex1) mixed through wet areas, pigment density
// turbulence and granulation (Bousseau et al. 2006: C' = C - (C - C^2)(d - 1)),
// darkened wet edges from the bled copy's gradient, hand tremor, paper.
// p0 = (wetness, edge darkening, pigment, pigment scale px), p1 = (granulation,
// tremor px, paper, paper scale px), p2 = (paper colour (display), on paper),
// p3 = (seed, 0, 0, 0).
fn darken(c : vec3<f32>, d : f32) -> vec3<f32> { return clamp(c - (c - c * c) * (d - 1.0), vec3<f32>(0.0), vec3<f32>(1.0)); }
fn paperH(px : vec2<f32>, s : f32) -> f32 { return fbmT(px / P(1).w, 0.0, s + 41.0, 3); }
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let seedv = P(3).x;
  let px = layerPx(uv);
  let tr = P(1).y;
  let jit = (vec2<f32>(fbmT(px / 45.0, 0.0, seedv, 2), fbmT(px / 45.0, 0.0, seedv + 5.0, 2)) - 0.5) * 2.0 * tr;
  let suv = uv + dpxUv(jit);
  let ab = toDisp(at0(suv));
  let bl = toDisp(at1(suv));
  let wet = smoothstep(0.42, 0.62, fbmT(px / (P(0).w * 3.0), 0.0, seedv + 9.0, 3)) * P(0).x;
  var col = mix(ab.rgb, bl.rgb, wet);
  let alpha = mix(ab.a, max(ab.a, bl.a), wet);
  // Pigment turbulence and granulation (granules gather where the paint is thin).
  let turb = fbmT(px / P(0).w, 0.0, seedv + 3.0, 4) * 2.0 - 1.0;
  let gran = (hcell(floor(px / 1.5), seedv + 13.0) - 0.5) * (1.0 - lumaDisp(col));
  col = darken(col, 1.0 + P(0).z * turb * 0.5 + P(1).x * gran);
  // Wet-edge darkening: the bled copy's gradient (colour and coverage).
  let e = dpxUv(vec2<f32>(1.5, 1.5));
  let gx = toDisp(at1(suv + vec2<f32>(e.x, 0.0))) - toDisp(at1(suv - vec2<f32>(e.x, 0.0)));
  let gy = toDisp(at1(suv + vec2<f32>(0.0, e.y))) - toDisp(at1(suv - vec2<f32>(0.0, e.y)));
  let grad = length(vec2<f32>(lumaDisp(gx.rgb) + gx.a, lumaDisp(gy.rgb) + gy.a));
  col = darken(col, 1.0 + P(0).y * clamp(grad * 3.0, 0.0, 1.5));
  // Paper: an embossed fibre height the pigment settles into.
  let h = paperH(px, seedv);
  let hx = paperH(px + vec2<f32>(1.0, 0.0), seedv) - h;
  let hy = paperH(px + vec2<f32>(0.0, 1.0), seedv) - h;
  let shade = 1.0 - P(1).z * (0.18 * (h - 0.5) + 2.5 * (hx + hy));
  col = clamp(col * shade, vec3<f32>(0.0), vec3<f32>(1.0));
  // A ragged, pooled edge.
  let a2 = clamp(alpha * (1.0 + (fbmT(px / 9.0, 0.0, seedv + 17.0, 2) - 0.5) * 0.9 * P(0).x), 0.0, 1.0);
  if (P(2).w > 0.5) {
    let paper = clamp(P(2).rgb * shade, vec3<f32>(0.0), vec3<f32>(1.0));
    return fromDisp(mix(paper, paper * col, a2), 1.0);
  }
  return fromDisp(col, a2);
}
