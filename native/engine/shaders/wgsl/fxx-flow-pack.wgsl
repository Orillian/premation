// Two flows in one texture: rg = tex0's, ba = tex1's (both buffer uv).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(at0(uv).rg, at1(uv).rg);
}
