
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var matteTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
// params.zw: a feather radius in uv (Behind Subject's softness): the matte is
// averaged over a 13-tap disk (a centre and two rings), so its edge goes soft.
fn matteAt(uv : vec2<f32>) -> vec4<f32> {
  if (obj.params.z <= 0.0 && obj.params.w <= 0.0) { return textureSample(matteTex, smp, uv); }
  var acc = textureSample(matteTex, smp, uv);
  for (var i = 0; i < 6; i = i + 1) {
    let a = f32(i) * 1.0471976;
    let d = vec2<f32>(cos(a), sin(a)) * obj.params.zw;
    acc = acc + textureSample(matteTex, smp, uv + d * 0.5);
    acc = acc + textureSample(matteTex, smp, uv + vec2<f32>(cos(a + 0.5235988), sin(a + 0.5235988)) * obj.params.zw);
  }
  return acc / 13.0;
}

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let m = matteAt(uv);
  // Luminance is read from the PREMULTIPLIED sample deliberately: a transparent
  // region of the matte layer must read as zero coverage, not as whatever colour
  // happens to sit in its unused channels.
  var k = select(m.a, dot(m.rgb, vec3<f32>(0.299, 0.587, 0.114)), obj.params.x > 0.5);
  k = select(k, 1.0 - k, obj.params.y > 0.5);
  return textureSample(tex, smp, uv) * clamp(k, 0.0, 1.0);
}
