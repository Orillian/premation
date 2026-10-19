// VR Chromatic Aberrations (docs/PROGRAM_DEEP_EFFECTS.md #18): each channel's
// direction pulled toward (negative) or away from (positive) a centre on the
// sphere by an angle that grows with its distance from the centre (or shrinks:
// reverse falloff). p0 = (layout, red, green, blue (radians)), p1 = (centre pan,
// centre tilt, falloff, reverse).
fn swing(d : vec3<f32>, c : vec3<f32>, amount : f32) -> vec3<f32> {
  let cosT = clamp(dot(d, c), -1.0, 1.0);
  let th = acos(cosT);
  var f = mix(1.0, th / PI, P(1).z);
  if (P(1).w > 0.5) { f = mix(1.0, 1.0 - th / PI, P(1).z); }
  let th2 = clamp(th + amount * f, 0.0, PI);
  let side = d - c * cosT;
  let sl = length(side);
  if (sl < 0.00001) { return d; }
  return c * cos(th2) + (side / sl) * sin(th2);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lay = i32(P(0).x);
  let px = layerPx(uv);
  let fr = vrFrame(px, lay);
  let q = (px - fr.xy) / fr.zw;
  let d = eqDir(q);
  let cl = P(1).y;
  let cp = P(1).x;
  let c = vec3<f32>(cos(cl) * sin(cp), sin(cl), cos(cl) * cos(cp));
  let r = vrTap(tex0, fr, dirEq(swing(d, c, P(0).y)));
  let g = vrTap(tex0, fr, dirEq(swing(d, c, P(0).z)));
  let b = vrTap(tex0, fr, dirEq(swing(d, c, P(0).w)));
  return vec4<f32>(r.r, g.g, b.b, max(r.a, max(g.a, b.a)));
}
