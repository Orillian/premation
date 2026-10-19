// Light Trails composite: the newest older frame's trail (tex1, age 1) and the
// older ones (tex2) over the layer (tex0).
// p0 = (threshold, decay, intensity, mode), p1 = head colour, p2 = tail colour.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let c = at1(uv);
  let thr = P(0).x;
  let l = lumaLin(max(c.rgb, vec3<f32>(0.0)));
  let head = P(1).rgb * smoothstep(thr, thr + 0.15, l) * l;
  let light = (head + max(at2(uv).rgb, vec3<f32>(0.0))) * P(0).z;
  return lightOver(base, light, i32(P(0).w));
}
