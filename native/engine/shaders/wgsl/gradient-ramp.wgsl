
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, colors: mat4x4<f32>, points: vec4<f32>, blend: f32 };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn srgbToLinearChan(c : f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let p0 = obj.points.xy; let p1 = obj.points.zw;
  let dir = p1 - p0; let len2 = dot(dir, dir);
  let t = clamp(dot(uv - p0, dir) / max(len2, 0.0001), 0.0, 1.0);
  // The stops are authored (display-referred sRGB) colours and blend in sRGB, as
  // the Canvas2D ramp does (effect_color.cpp); the chain buffer is linear working
  // space, so the ramp is decoded before it lands (four-color-gradient's encodeOut).
  // Writing the sRGB value raw had the display encode apply to it a second time.
  let rampColor = mix(obj.colors[0], obj.colors[1], t);
  let s = clamp(rampColor.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let rampLinear = vec3<f32>(srgbToLinearChan(s.r), srgbToLinearChan(s.g), srgbToLinearChan(s.b));
  let c = textureSample(tex, smp, uv);
  // c.rgb is premultiplied; unpremultiply before mixing with straight rampColor,
  // then re-premultiply once so the output stays premultiplied.
  let straight = select(c.rgb / c.a, vec3<f32>(0.0), c.a == 0.0);
  let outColor = mix(straight, rampLinear, rampColor.a * obj.blend);
  return vec4<f32>(outColor * c.a, c.a);
}
