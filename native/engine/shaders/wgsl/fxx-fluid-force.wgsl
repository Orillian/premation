// Fluid Ink: the forces on the velocity (tex0) — vorticity confinement from
// the curl (tex1), the source's push where it is (tex2), curl-noise
// turbulence (a divergence-free field from an evolving fractal stream
// function) and damping. p0 = (push x, y (px/s), emission, turbulence),
// p1 = (turbulence scale px, vorticity, damping, speed), p2 = (seed, 0, 0, 0).
fn psi(px : vec2<f32>, t : f32) -> f32 { return fbmT(px / P(1).x, t * 0.4, P(2).x, 3); }
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let dt = simRow().y * P(1).w;
  let st = simRow().x * P(1).w;
  let t = simTexel(tex1);
  let h = simCell();
  var v = atQ(tex0, uv).xy;
  // Vorticity confinement: push along N x w, N = the gradient of |curl|.
  let wr = abs(atQ(tex1, uv + vec2<f32>(t.x, 0.0)).y);
  let wl = abs(atQ(tex1, uv - vec2<f32>(t.x, 0.0)).y);
  let wt = abs(atQ(tex1, uv + vec2<f32>(0.0, t.y)).y);
  let wb = abs(atQ(tex1, uv - vec2<f32>(0.0, t.y)).y);
  let w = atQ(tex1, uv).y;
  var n = vec2<f32>((wr - wl) / (2.0 * h.x), (wt - wb) / (2.0 * h.y));
  n = n / max(length(n), 0.00001);
  v += P(1).y * h.x * vec2<f32>(n.y * w, -n.x * w) * dt * 2.0;
  // The source pushes where it is.
  let src = atQ(tex2, uv);
  v += P(0).xy * src.a * P(0).z * dt * 6.0;
  // Turbulence: the curl of a stream function, (d psi / dy, -d psi / dx).
  if (P(0).w > 0.0) {
    let px = uv * lwh();
    let e = 1.5;
    let dpy = (psi(px + vec2<f32>(0.0, e), st) - psi(px - vec2<f32>(0.0, e), st)) / (2.0 * e);
    let dpx = (psi(px + vec2<f32>(e, 0.0), st) - psi(px - vec2<f32>(e, 0.0), st)) / (2.0 * e);
    v += vec2<f32>(dpy, -dpx) * P(1).x * P(0).w * 120.0 * dt;
  }
  v *= exp(-P(1).z * 3.0 * dt);
  return vec4<f32>(v, 0.0, 0.0);
}
