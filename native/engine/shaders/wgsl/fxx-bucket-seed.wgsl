// Paint Bucket (docs/PROGRAM_DEEP_EFFECTS.md #8): which texels match the fill
// point within tolerance (r) and which are already filled — the point itself
// (g) — at quarter resolution. p0 = (fill point px x, y, tolerance, selector).
fn matchOf(c : vec4<f32>, refc : vec4<f32>) -> f32 {
  let tol = P(0).z + 0.0001;
  let sel = i32(P(0).w);
  let dc = toDisp(c);
  let dr = toDisp(refc);
  var diff = 0.0;
  switch (sel) {
    case 1: { diff = max(abs(dc.r - dr.r), max(abs(dc.g - dr.g), abs(dc.b - dr.b))); }
    case 2: { return select(0.0, 1.0, c.a <= tol); }
    case 3: { return select(0.0, 1.0, c.a >= 1.0 - tol); }
    case 4: { diff = abs(c.a - refc.a); }
    default: {
      let a = vec4<f32>(dc.rgb * dc.a, dc.a);
      let b = vec4<f32>(dr.rgb * dr.a, dr.a);
      let d = abs(a - b);
      diff = max(max(d.r, d.g), max(d.b, d.a));
    }
  }
  return select(0.0, 1.0, diff <= tol);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let refc = at0(pxUv(P(0).xy));
  let inside = matchOf(at0(uv), refc);
  let d = length(layerPx(uv) - P(0).xy) / max(pxPerOut().x, 0.0001);
  let seeded = select(0.0, inside, d <= 1.5);
  return vec4<f32>(inside, seeded, 0.0, 1.0);
}
