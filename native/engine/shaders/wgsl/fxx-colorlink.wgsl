// Color Link: the measured colour (tex1, the same in every texel; straight
// linear) blended over the layer (tex0).
// p0 = (sample, stencil original alpha, opacity, blending 0 normal 1 add
// 2 multiply 3 screen 4 overlay 5 soft light 6 hard light 7 difference 8 colour
// 9 hue 10 saturation 11 luminosity).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let m = at1(vec2<f32>(0.5, 0.5));
  let mode = i32(P(0).x);
  // The alpha statistics colour the layer grey at that level.
  let link = select(m.rgb, vec3<f32>(m.a), mode >= 5);
  let a = toDisp(base);
  let b = l2s3(clamp(link, vec3<f32>(0.0), vec3<f32>(1.0)));
  let bl = i32(P(0).w);
  var rgb = b;
  switch (bl) {
    case 1: { rgb = blendMode(a.rgb, b, 6); }
    case 2: { rgb = blendMode(a.rgb, b, 1); }
    case 3: { rgb = blendMode(a.rgb, b, 2); }
    case 4: { rgb = blendMode(a.rgb, b, 3); }
    case 5: { rgb = blendMode(a.rgb, b, 4); }
    case 6: { rgb = blendMode(a.rgb, b, 5); }
    case 7: { rgb = blendMode(a.rgb, b, 8); }
    case 8: { let h = rgb2hsl(b); rgb = hsl2rgb(vec3<f32>(h.x, h.y, rgb2hsl(a.rgb).z)); }
    case 9: { let h = rgb2hsl(a.rgb); rgb = hsl2rgb(vec3<f32>(rgb2hsl(b).x, h.y, h.z)); }
    case 10: { let h = rgb2hsl(a.rgb); rgb = hsl2rgb(vec3<f32>(h.x, rgb2hsl(b).y, h.z)); }
    case 11: { let h = rgb2hsl(a.rgb); rgb = hsl2rgb(vec3<f32>(h.x, h.y, rgb2hsl(b).z)); }
    default: { rgb = b; }
  }
  let alpha = select(1.0, a.a, P(0).y > 0.5);
  let linked = fromDisp(rgb, alpha);
  return mix(base, linked, P(0).z);
}
