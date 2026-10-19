// Reaction-Diffusion (docs/PROGRAM_DEEP_EFFECTS.md #42): the start — A = 1
// everywhere but where B is seeded: the layer's alpha or luminance at the
// start time (tex0), or random spots. p0 = (seed from 0 alpha 1 luma 2 spots, seed, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = atQ(tex0, uv);
  let mode = i32(P(0).x);
  var b = 0.0;
  if (mode == 0) { b = step(0.5, src.a); }
  if (mode == 1) { b = step(0.5, lumaDisp(toDisp(src).rgb) * src.a); }
  if (mode == 2) {
    let px = uv * lwh();
    let cell = floor(px / 24.0);
    let o = hcell2(cell, P(0).y) * 24.0;
    let r = 3.0 + hcell(cell, P(0).y + 5.0) * 4.0;
    b = select(0.0, 1.0, hcell(cell, P(0).y + 9.0) > 0.7 && length(px - (cell * 24.0 + o)) < r);
  }
  // Sparse seeds inside the shape (a solid block of B starves and dies to a rim).
  if (mode != 2) {
    let px = uv * lwh();
    let cell = floor(px / 6.0);
    b *= step(0.78, hcell(cell, P(0).y + 13.0));
  }
  return vec4<f32>(1.0 - b * 0.5, b, 0.0, 1.0);
}
