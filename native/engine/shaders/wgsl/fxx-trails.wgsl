// Light Trails (docs/PROGRAM_DEEP_EFFECTS.md #38): the highlights of three
// older frames (tex0..tex2 at ages 2..4 of 4), each coloured between the head
// and the tail colour by age and faded by the decay; their light summed.
// p0 = (threshold (linear), decay, first age, 0), p1 = head colour, p2 = tail colour.
fn trail(c : vec4<f32>, age : f32) -> vec3<f32> {
  let thr = P(0).x;
  let l = lumaLin(max(c.rgb, vec3<f32>(0.0)));
  let k = smoothstep(thr, thr + 0.15, l);
  let col = mix(P(1).rgb, P(2).rgb, clamp((age - 1.0) / 3.0, 0.0, 1.0));
  return col * k * l * pow(P(0).y, age - 1.0);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let a0 = P(0).z;
  let s = trail(at0(uv), a0) + trail(at1(uv), a0 + 1.0) + trail(at2(uv), a0 + 2.0);
  return vec4<f32>(s, 0.0);
}
