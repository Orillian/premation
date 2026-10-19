// Paint Bucket composite: the fill colour through the matte's edge treatment
// (tex1 = the blurred matte, tex2 = the hard one) onto the input (tex0).
// p0 = (stroke mode 0 antialias 1 feather 2 spread 3 choke 4 stroke, width px,
// view threshold, blending 0 normal 1 behind 2 fill only 3 multiply 4 screen
// 5 colour), p1 = (colour (linear), opacity).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let soft = at1(uv).r;
  let mode = i32(P(0).x);
  var m = soft;
  switch (mode) {
    case 2: { m = smoothstep(0.02, 0.4, soft); }
    case 3: { m = smoothstep(0.6, 0.98, soft); }
    case 4: { m = clamp(1.0 - abs(soft - 0.5) * 2.4, 0.0, 1.0); }
    default: { m = soft; }
  }
  if (P(0).z > 0.5) { return vec4<f32>(vec3<f32>(at2(uv).r), 1.0); }
  let a = clamp(m * P(1).w, 0.0, 1.0);
  let fillC = P(1).rgb;
  let bl = i32(P(0).w);
  switch (bl) {
    case 1: { return base + vec4<f32>(fillC * a, a) * (1.0 - base.a); }
    case 2: { return vec4<f32>(fillC * a, a); }
    case 3: {
      let mixed = base.rgb * mix(vec3<f32>(1.0), fillC, a);
      return vec4<f32>(mixed + fillC * a * (1.0 - base.a), base.a + a * (1.0 - base.a));
    }
    case 4: {
      let scr = base.rgb + fillC * a - base.rgb * fillC * a;
      return vec4<f32>(scr, base.a + a * (1.0 - base.a));
    }
    case 5: {
      let d = toDisp(base);
      let h = rgb2hsl(d.rgb);
      let f = rgb2hsl(l2s3(fillC));
      let tinted = fromDisp(hsl2rgb(vec3<f32>(f.x, f.y, h.z)), d.a);
      return mix(base, tinted, a);
    }
    default: { return vec4<f32>(fillC * a, a) + base * (1.0 - a); }
  }
}
