// E8 (docs/PROGRAM_3D_PERF_UX.md): the engine-drawn ground grid — a viewport
// aid, never in an export, a thumbnail or the cache. One quad on the comp's
// ground plane (y = Ground Level), tested against the run's depth and never
// written to it, so the floor reads through the gaps between layers and is
// hidden where a layer stands in front of it. Two nested levels (major cells,
// minor cells inside them: the 1 / 2 / 5 step threed.cpp picks from the
// camera's distance), the X axis in the red axis colour, the Z axis in the
// blue one, a radial distance fade from the floor's centre. Lines are one
// screen pixel wide, anti-aliased from the world-space derivatives.
struct Object {
  mvp : mat4x4<f32>,
  model : mat4x4<f32>,
  // x = major step, y = minor step, z = half-extent (world px), w = fade start (fraction of extent)
  grid : vec4<f32>,
  // xyz = the floor's centre (cx, groundY, cz), w = overall opacity
  center : vec4<f32>,
  colorLine : vec4<f32>,
  colorX : vec4<f32>,
  colorZ : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 0.0, 1.0);
  o.world = (obj.model * vec4<f32>(pos, 0.0, 1.0)).xyz;
  return o;
}

// Coverage of the lines of a square lattice of `step`, one pixel wide: the
// distance to the nearest line in world units against the world size of a
// pixel (fw), per axis, the stronger axis winning.
fn latticeCoverage(p : vec2<f32>, step : f32, fw : vec2<f32>) -> f32 {
  let s = max(step, 0.000001);
  let g = abs(fract(p / s - vec2<f32>(0.5)) - vec2<f32>(0.5)) * s;
  let aa = max(fw, vec2<f32>(0.000001));
  let cov = vec2<f32>(1.0) - smoothstep(vec2<f32>(0.0), aa, g - 0.5 * aa);
  return max(cov.x, cov.y);
}

@fragment
fn fs(v : VOut) -> @location(0) vec4<f32> {
  let c = obj.center.xyz;
  let d = v.world.xz - c.xz;
  let extent = max(obj.grid.z, 1.0);
  let dist = length(d);
  // World units per screen pixel on the floor, per axis (perspective-correct).
  // Taken before any branch: derivatives need uniform control flow.
  let fw = vec2<f32>(fwidth(v.world.x), fwidth(v.world.z));
  let fade = 1.0 - smoothstep(extent * clamp(obj.grid.w, 0.0, 0.99), extent, dist);
  if (fade <= 0.0) { return vec4<f32>(0.0); }
  let major = latticeCoverage(d, obj.grid.x, fw);
  let minor = latticeCoverage(d, obj.grid.y, fw);
  // The two axes: a slightly heavier line (1.5 px) through the centre.
  let ax = 1.0 - smoothstep(0.0, fw.y * 1.5, abs(d.y) - 0.75 * fw.y);  // the X axis runs along x: z = cz
  let az = 1.0 - smoothstep(0.0, fw.x * 1.5, abs(d.x) - 0.75 * fw.x);  // the Z axis runs along z: x = cx
  var rgb = obj.colorLine.rgb;
  var a = max(major * 0.3, minor * 0.1);
  if (az > a) { rgb = obj.colorZ.rgb; a = az * 0.85; }
  if (ax > a) { rgb = obj.colorX.rgb; a = ax * 0.85; }
  a = a * fade * clamp(obj.center.w, 0.0, 1.0);
  return vec4<f32>(rgb * a, a);
}
