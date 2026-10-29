// Background fill, step 2: where the subject is, the picture takes the
// background colour around it (normalized convolution: the blurred weighted
// picture over its blurred weight), so a blur that follows spreads no subject
// colour into the background — no dark halo around a person. tex0 = the
// input, tex1 = the blurred weighted picture (fxx-sfill-pre), tex2 = the matte.
// Where no background reached (deep inside a large subject) the input stays.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  let blurred = at1(uv);
  let m = clamp(at2(uv).a, 0.0, 1.0);
  if (blurred.a <= 0.0001 || base.a <= 0.00001) { return base; }
  let fill = blurred.rgb / blurred.a;
  let rgb = mix(base.rgb / base.a, fill, m);
  return vec4<f32>(rgb * base.a, base.a);
}
