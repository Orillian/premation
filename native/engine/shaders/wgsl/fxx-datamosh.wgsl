// Datamosh (docs/PROGRAM_DEEP_EFFECTS.md #39): the held frame (tex1) dragged by
// the live footage's motion (tex2: optical flow, previous -> now, buffer uv)
// quantised to macroblocks, multiplied by the frames since the hold; where the
// motion is strong the live picture (tex0) bleeds through, block by block.
// p0 = (block size px, drag (intensity x frames), bleed, motion threshold).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let px = layerPx(uv);
  let bs = P(0).x;
  let cell = floor(px / bs);
  let cuv = pxUv((cell + 0.5) * bs);
  let f = at2(cuv).rg;
  let drag = f * P(0).y;
  let moved = at1(uv - drag);
  let live = at0(uv);
  let speed = length(f / max(dpxUv(vec2<f32>(1.0, 1.0)), vec2<f32>(0.000001)));
  let gate = smoothstep(P(0).w * 20.0, P(0).w * 20.0 + 2.0, speed);
  let pick = hcell(cell, 41.0) < P(0).z;
  let k = select(0.0, gate, pick);
  return mix(moved, live, k);
}
