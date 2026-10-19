// Shine source (docs/PROGRAM_DEEP_EFFECTS.md #2): what emits — the input above
// the threshold, scaled by the shimmer (fractal noise around the source point,
// constant along each ray). rgb = the light, a = its intensity (for colorize).
// p0 = (source px x, y, threshold, softness), p1 = (shimmer amount, detail,
// phase, seed), p2 = (base on, 0, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = at0(uv);
  let d = toDisp(c);
  let mode = i32(P(2).x);
  var v = 0.0;
  switch (mode) {
    case 1: { v = lumaDisp(d.rgb); }
    case 2: { v = 1.0; }
    case 3: { v = d.r; }
    case 4: { v = d.g; }
    case 5: { v = d.b; }
    default: { v = 0.5 * (max(d.r, max(d.g, d.b)) + min(d.r, min(d.g, d.b))); }
  }
  v = v * c.a;
  let thr = P(0).z;
  let soft = P(0).w;
  // The softness eases in ABOVE the threshold: nothing under it emits.
  let m = smoothstep(thr, thr + soft * (1.0 - thr) + 0.0001, v);
  let dir = layerPx(uv) - P(0).xy;
  let ang = atan2(dir.y, dir.x);
  let q = vec2<f32>(cos(ang), sin(ang)) * P(1).y;
  let n = fbmT(q + vec2<f32>(50.0, 50.0), P(1).z, P(1).w, 3);
  let sh = mix(1.0, smoothstep(0.3, 0.7, n) * 2.0, P(1).x);
  let e = m * sh;
  return vec4<f32>(max(c.rgb, vec3<f32>(0.0)) * e, v * e);
}
