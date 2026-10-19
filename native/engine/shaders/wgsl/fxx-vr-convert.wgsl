// VR Converter (docs/PROGRAM_DEEP_EFFECTS.md #19): output uv -> a direction
// (the output layout), rotated, -> the source's uv (the source layout).
// Layouts: 0 equirectangular, 1 cube 3 x 2 (+X -X +Y / -Y +Z -Z), 2 cube 6 x 1
// (+X -X +Y -Y +Z -Z), 3 cube 4 x 3 cross, 4 rectilinear view.
// p0 = (source, output, field of view (rad), seam blend), p1..p3 = rotation rows.
fn faceDir(f : i32, u : f32, v : f32) -> vec3<f32> {
  let sc = u * 2.0 - 1.0;
  let tc = v * 2.0 - 1.0;
  switch (f) {
    case 0: { return normalize(vec3<f32>(1.0, -tc, -sc)); }
    case 1: { return normalize(vec3<f32>(-1.0, -tc, sc)); }
    case 2: { return normalize(vec3<f32>(sc, 1.0, tc)); }
    case 3: { return normalize(vec3<f32>(sc, -1.0, -tc)); }
    case 4: { return normalize(vec3<f32>(sc, -tc, 1.0)); }
    default: { return normalize(vec3<f32>(-sc, -tc, -1.0)); }
  }
}
// A direction -> (face, u, v).
fn dirFace(d : vec3<f32>) -> vec3<f32> {
  let a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    if (d.x > 0.0) { return vec3<f32>(0.0, (-d.z / a.x + 1.0) * 0.5, (-d.y / a.x + 1.0) * 0.5); }
    return vec3<f32>(1.0, (d.z / a.x + 1.0) * 0.5, (-d.y / a.x + 1.0) * 0.5);
  }
  if (a.y >= a.z) {
    if (d.y > 0.0) { return vec3<f32>(2.0, (d.x / a.y + 1.0) * 0.5, (d.z / a.y + 1.0) * 0.5); }
    return vec3<f32>(3.0, (d.x / a.y + 1.0) * 0.5, (-d.z / a.y + 1.0) * 0.5);
  }
  if (d.z > 0.0) { return vec3<f32>(4.0, (d.x / a.z + 1.0) * 0.5, (-d.y / a.z + 1.0) * 0.5); }
  return vec3<f32>(5.0, (-d.x / a.z + 1.0) * 0.5, (-d.y / a.z + 1.0) * 0.5);
}
// Cube layouts: a face's cell (column, row) and the grid size.
fn faceCell(lay : i32, f : i32) -> vec4<f32> {
  if (lay == 1) { return vec4<f32>(f32(f % 3), f32(f / 3), 3.0, 2.0); }
  if (lay == 2) { return vec4<f32>(f32(f), 0.0, 6.0, 1.0); }
  // 4 x 3 cross: +Y over +Z; -X +Z +X -Z across; -Y under +Z.
  switch (f) {
    case 0: { return vec4<f32>(2.0, 1.0, 4.0, 3.0); }
    case 1: { return vec4<f32>(0.0, 1.0, 4.0, 3.0); }
    case 2: { return vec4<f32>(1.0, 0.0, 4.0, 3.0); }
    case 3: { return vec4<f32>(1.0, 2.0, 4.0, 3.0); }
    case 4: { return vec4<f32>(1.0, 1.0, 4.0, 3.0); }
    default: { return vec4<f32>(3.0, 1.0, 4.0, 3.0); }
  }
}
fn cellFace(lay : i32, c : vec2<f32>) -> i32 {
  if (lay == 1) { return i32(c.x) + 3 * i32(c.y); }
  if (lay == 2) { return i32(c.x); }
  let x = i32(c.x);
  let y = i32(c.y);
  if (y == 1) {
    if (x == 0) { return 1; }
    if (x == 1) { return 4; }
    if (x == 2) { return 0; }
    return 5;
  }
  if (x == 1 && y == 0) { return 2; }
  if (x == 1 && y == 2) { return 3; }
  return -1;
}
fn viewScale(fov : f32) -> vec2<f32> {
  let t = tan(fov * 0.5);
  return vec2<f32>(t, t * lwh().y / lwh().x);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = i32(P(0).x);
  let dst = i32(P(0).y);
  let q = layerPx(uv) / lwh();
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { return vec4<f32>(0.0); }
  // Output uv -> direction.
  var d = vec3<f32>(0.0, 0.0, 1.0);
  if (dst == 0) {
    d = eqDir(q);
  } else if (dst == 4) {
    let s = viewScale(P(0).z);
    d = normalize(vec3<f32>((q.x * 2.0 - 1.0) * s.x, (1.0 - q.y * 2.0) * s.y, 1.0));
  } else {
    let g = faceCell(dst, 0).zw;
    let cell = floor(q * g);
    let f = cellFace(dst, cell);
    if (f < 0) { return vec4<f32>(0.0); }
    let fq = q * g - cell;
    d = faceDir(f, fq.x, fq.y);
  }
  d = rot3(d, 1);
  // Direction -> source uv.
  var s = vec2<f32>(0.0);
  let inset = 0.5 * pxPerOut() / lwh();
  if (src == 0) {
    s = dirEq(d);
    s.x = s.x - floor(s.x);
  } else if (src == 4) {
    if (d.z <= 0.0001) { return vec4<f32>(0.0); }
    let sc = viewScale(P(0).z);
    s = vec2<f32>((d.x / d.z / sc.x + 1.0) * 0.5, (1.0 - d.y / d.z / sc.y) * 0.5);
    if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) { return vec4<f32>(0.0); }
  } else {
    let fuv = dirFace(d);
    let cell = faceCell(src, i32(fuv.x));
    var fq = fuv.yz;
    if (P(0).w > 0.5) { fq = clamp(fq, inset * cell.zw, vec2<f32>(1.0) - inset * cell.zw); }
    s = (cell.xy + fq) / cell.zw;
  }
  s = clamp(s, inset, vec2<f32>(1.0) - inset);
  return at0(pxUv(s * lwh()));
}
