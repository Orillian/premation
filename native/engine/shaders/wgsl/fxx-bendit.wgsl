// CC Bend It (docs/PROGRAM_DEEP_EFFECTS.md #55): the part of the layer from
// the start to the end point laid onto an arc of the bend angle (same length,
// radius L / angle), the part past the end carried on along the arc's end
// tangent; before the start: removed, static or bent on. Exact inverse
// mapping: output point -> arc coordinates -> source point.
// p0 = (start px, end px), p1 = (bend (rad), prestart 0 none 1 static 2 bend, 0, 0).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let p = layerPx(uv);
  let s0 = P(0).xy;
  let s1 = P(0).zw;
  let ax = s1 - s0;
  let len = max(length(ax), 0.001);
  let t = ax / len;
  let nrm = vec2<f32>(-t.y, t.x);
  let th = P(1).x;
  // Output point in the axis frame (u along, v across).
  let rel = p - s0;
  let u = dot(rel, t);
  let v = dot(rel, nrm);
  let pre = i32(P(1).y);
  if (u < 0.0 && pre != 2) {
    if (pre == 0) { return vec4<f32>(0.0); }
    return at0(uv);
  }
  if (abs(th) < 0.0001) { return at0(uv); }
  let r = len / th;
  // The arc's centre sits at v = r (on the normal side for a positive bend).
  let cc = vec2<f32>(0.0, r);
  let d = vec2<f32>(u, v) - cc;
  var ang = atan2(d.x, -d.y * sign(r));
  let rr = length(d);
  var su = 0.0;
  var sv = 0.0;
  if ((ang >= 0.0 && ang <= abs(th)) || (pre == 2 && ang < 0.0)) {
    su = ang * abs(r);
    sv = (abs(r) - rr) * sign(r);
  } else {
    // Past the end: along the end tangent.
    let ea = abs(th);
    let ep = cc + vec2<f32>(sin(ea), -cos(ea) * sign(r)) * abs(r);
    let et = vec2<f32>(cos(ea), sin(ea) * sign(r));
    let en = vec2<f32>(-et.y, et.x);
    let q = vec2<f32>(u, v) - ep;
    su = len + dot(q, et);
    sv = dot(q, en);
  }
  let src = s0 + t * su + nrm * sv;
  if (src.x < 0.0 || src.y < 0.0 || src.x > lwh().x || src.y > lwh().y) { return vec4<f32>(0.0); }
  return at0(pxUv(src));
}
