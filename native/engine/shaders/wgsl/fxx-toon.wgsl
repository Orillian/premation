// Ink & Toon (docs/PROGRAM_DEEP_EFFECTS.md #6): XDoG lines (Winnemoeller et
// al. 2012) from two Gaussians of the picture (tex1 sigma, tex2 1.6 sigma) over
// a cel-quantised, smoothed fill (tex0); halftone dots in the shadows. The
// transparent ground reads as paper, so a silhouette is inked too.
// p0 = (phi, epsilon, tau, line opacity), p1 = (line colour (linear), fill
// opacity), p2 = (levels, saturation, halftone, dot size px), p3 = (dot angle, 0, 0, 0).
fn paperLuma(c : vec4<f32>) -> f32 {
  let d = toDisp(c);
  return mix(1.0, lumaDisp(d.rgb), d.a);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let g1 = paperLuma(at1(uv));
  let g2 = paperLuma(at2(uv));
  let dd = g1 - P(0).z * g2;
  let eps = P(0).y;
  let edge = select(1.0 + tanh(P(0).x * (dd - eps)), 1.0, dd >= eps);
  let ink = clamp(1.0 - edge, 0.0, 1.0) * P(0).w;
  let f = toDisp(at0(uv));
  var hsl = rgb2hsl(f.rgb);
  let lv = P(2).x;
  let band = hsl.z * lv;
  let k = floor(band);
  hsl.z = (k + smoothstep(0.45, 0.55, band - k)) / lv;
  hsl.y = clamp(hsl.y * P(2).y, 0.0, 1.0);
  var fill = hsl2rgb(hsl);
  if (P(2).z > 0.0) {
    let cell = rot2(layerPx(uv), P(3).x) / P(2).w;
    let dist = length(fract(cell) - 0.5);
    let rr = sqrt(clamp(1.0 - hsl.z, 0.0, 1.0)) * 0.62;
    let dotv = 1.0 - smoothstep(rr - 0.06, rr + 0.06, dist);
    fill = fill * (1.0 - dotv * P(2).z * 0.85);
  }
  let fillP = fromDisp(fill, f.a * P(1).w);
  return vec4<f32>(P(1).rgb * ink, ink) + fillP * (1.0 - ink);
}
