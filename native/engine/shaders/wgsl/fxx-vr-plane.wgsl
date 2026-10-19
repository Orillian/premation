// VR Plane to Sphere (docs/PROGRAM_DEEP_EFFECTS.md #23): the layer's flat
// picture as a rectilinear plane on the sphere — for each equirectangular
// output pixel, its direction turned into the plane's space (the inverse
// rotation, p1..p3), projected onto the plane, feathered at the edge.
// p0 = (tan(half field of view), aspect, feather (fraction), 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let q = layerPx(uv) / lwh();
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { return vec4<f32>(0.0); }
  let d = rot3(eqDir(q), 1);
  if (d.z <= 0.0001) { return vec4<f32>(0.0); }
  let tx = P(0).x;
  let ty = tx * (lwh().y / lwh().x) / P(0).y;
  let s = vec2<f32>((d.x / d.z / tx + 1.0) * 0.5, (1.0 - d.y / d.z / ty) * 0.5);
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) { return vec4<f32>(0.0); }
  let fe = max(P(0).z, 0.0001);
  let edge = min(min(s.x, 1.0 - s.x), min(s.y, 1.0 - s.y));
  let k = smoothstep(0.0, fe, edge);
  return at0(pxUv(s * lwh())) * k;
}
