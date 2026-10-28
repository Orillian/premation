// Selective Color (AI) (docs/PROGRAM_DEEP_EFFECTS.md #58): the matte the
// correction is confined to, written to every channel. tex0 = the matte source
// (another layer, the layer's own Object Matte cut-out, or its alpha), tex1 =
// its distance field (fx_distance.hpp: r = signed texels to the 1/2-contour,
// + outside) when choked. p0 = (choke px: + shrinks, - grows; use the field).
// Unchoked, the soft matte is kept as it is; choked, the edge is the field's
// 1/2-contour moved by the choke (one texel of antialiasing — feather it).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var m = clamp(at0(uv).a, 0.0, 1.0);
  if (P(0).y > 0.5) {
    let ppt = pxPerOut();
    let k = max(0.5 * (ppt.x + ppt.y), 0.000001);
    let d = at1(uv).r * k;
    m = clamp(0.5 - (d + P(0).x) / k, 0.0, 1.0);
  }
  return vec4<f32>(m);
}
