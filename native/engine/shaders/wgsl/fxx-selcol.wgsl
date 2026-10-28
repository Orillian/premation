// Selective Color (AI): a hue / saturation / lightness correction and an
// optional colorize, in linear light and unclamped (HDR values keep their
// range), mixed into the input (tex0) through the matte (tex1, feathered) or
// its inverse.
// p0 = (hue radians, saturation -1..1, lightness -1..1, apply to 0 inside 1 outside),
// p1 = (colorize, colorize amount 0..1, 0, 0), p2 = (colorize colour (linear), 0).
const LUMA : vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  if (base.a <= 0.00001) { return base; }
  var m = clamp(at1(uv).r, 0.0, 1.0);
  if (P(0).w > 0.5) { m = 1.0 - m; }
  if (m <= 0.0) { return base; }
  let c = base.rgb / base.a;
  var o = c;
  // Hue: a rotation of the colour about the grey axis.
  let hue = P(0).x;
  if (abs(hue) > 0.00001) {
    let ax = vec3<f32>(0.5773503);
    let cs = cos(hue);
    let sn = sin(hue);
    o = o * cs + cross(ax, o) * sn + ax * dot(ax, o) * (1.0 - cs);
  }
  // Saturation: away from / toward the colour's own luminance.
  let y = dot(o, LUMA);
  o = vec3<f32>(y) + (o - vec3<f32>(y)) * (1.0 + clamp(P(0).y, -1.0, 1.0));
  // Lightness: toward white (only what is under it is lifted) or toward black.
  let l = clamp(P(0).z, -1.0, 1.0);
  if (l > 0.0) { o = o + (vec3<f32>(1.0) - min(o, vec3<f32>(1.0))) * l; }
  if (l < 0.0) { o = o * (1.0 + l); }
  o = max(o, vec3<f32>(0.0));
  // Colorize: the colour's hue and saturation at the pixel's luminance (a
  // colour too saturated for that luminance is pulled toward grey, never clipped).
  if (P(1).x > 0.5) {
    let yo = dot(o, LUMA);
    let tint = max(P(2).rgb, vec3<f32>(0.0));
    let yt = dot(tint, LUMA);
    var z = select(vec3<f32>(yo), tint * (yo / yt), yt > 0.00001);
    let mx = max(z.r, max(z.g, z.b));
    let lim = max(1.0, yo);
    if (mx > lim && mx - yo > 0.00001) { z = vec3<f32>(yo) + (z - vec3<f32>(yo)) * ((lim - yo) / (mx - yo)); }
    o = mix(o, max(z, vec3<f32>(0.0)), clamp(P(1).y, 0.0, 1.0));
  }
  return vec4<f32>(mix(c, o, m) * base.a, base.a);
}
