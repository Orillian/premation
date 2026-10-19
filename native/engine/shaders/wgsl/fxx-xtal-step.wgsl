// Crystal Growth: one explicit step of Kobayashi's anisotropic phase field
// (phase phi, temperature T in tex0) with the anisotropy terms (tex1):
//   tau dphi/dt = d/dy(eps eps' phi_x) - d/dx(eps eps' phi_y) + div(eps^2 grad phi)
//                 + phi (1 - phi) (phi - 1/2 + m(T)) + noise
//   dT/dt = lap T + K dphi/dt,  m = alpha / pi atan(gamma (Teq - T)).
// p0 = (latent heat K, irregularity, seed, 0).
const DX : f32 = 0.03;
const DT : f32 = 0.0001;
const TAU_K : f32 = 0.0003;
const ALPHA : f32 = 0.9;
const GAMMA : f32 = 10.0;
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let t = simTexel(tex0);
  let ex = vec2<f32>(t.x, 0.0);
  let ey = vec2<f32>(0.0, t.y);
  let c = atQ(tex0, uv);
  let phi = c.x;
  let tt = c.y;
  let l = atQ(tex0, uv - ex);
  let r = atQ(tex0, uv + ex);
  let b = atQ(tex0, uv - ey);
  let u = atQ(tex0, uv + ey);
  let lapPhi = (l.x + r.x + b.x + u.x - 4.0 * phi) / (DX * DX);
  let lapT = (l.y + r.y + b.y + u.y - 4.0 * tt) / (DX * DX);
  let a0 = atQ(tex1, uv);
  let al = atQ(tex1, uv - ex);
  let ar = atQ(tex1, uv + ex);
  let ab = atQ(tex1, uv - ey);
  let au = atQ(tex1, uv + ey);
  let term1 = (au.y * au.z - ab.y * ab.z) / (2.0 * DX);
  let term2 = -(ar.y * ar.w - al.y * al.w) / (2.0 * DX);
  let gradE2 = vec2<f32>((ar.x - al.x) / (2.0 * DX), (au.x - ab.x) / (2.0 * DX));
  let divE = a0.x * lapPhi + dot(gradE2, a0.zw);
  let m = ALPHA / PI * atan(GAMMA * (1.0 - tt));
  let noise = P(0).y * 0.01 * phi * (1.0 - phi) * (hcell(floor(uv * 4096.0), P(0).z + simRow().z * 7.0 + simRow().w) - 0.5);
  let dphi = (term1 + term2 + divE + phi * (1.0 - phi) * (phi - 0.5 + m) + noise) / TAU_K;
  let nphi = clamp(phi + dphi * DT, 0.0, 1.0);
  let nt = tt + (lapT + P(0).x * dphi) * DT;
  return vec4<f32>(nphi, nt, 0.0, 1.0);
}
