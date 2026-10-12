// Sample generator (SDK 1.2): Particles — a 3D emitter rendered through the
// comp camera. The emitter sits at the Emitter layer's origin
// (get_layer_transform), or at the comp's centre when no layer is picked;
// every particle is projected with the comp camera (get_comp_camera), so
// orbiting the camera orbits the burst. Lit by the comp's lights when there
// are any (get_comp_lights): each particle is tinted by the sum of their
// colours × intensities, After Effects' "Light Reflection" in miniature.
//
// SDK 1.2, what the sample proves:
//   · Trails: each particle is drawn again at the past `Trail Length` frames —
//     the camera, the lights, the emitter and the params AT THOSE TIMES
//     (checkout_time in SMART_PRE_RENDER, then checkout_param / get_comp_camera /
//     get_layer_transform at each time), so a moving camera or emitter, or a
//     keyed Velocity, bends the trail the way it really moved.
//   · Motion blur: with the comp's and the layer's motion-blur switches on, the
//     sample renders its own (PR_OUT_FLAG_USES_SHUTTER) over the comp's shutter
//     (shutter_angle / shutter_phase / motion_blur_samples).
//   · Comp space (PR_OUT_FLAG_COMP_SPACE): drawn with comp_to_world, so it works
//     on a solid of any size, anywhere.
//
// Deterministic: a particle's position is a pure function of its index, the
// seed and the time — no state carried from frame to frame, so any frame
// renders alone, in any order, identically in preview and export.
//
//   Emitter (layer) · Count · Speed · Spread · Lifetime · Size · Gravity · Color · Seed
//   · Trail Length · Motion Blur · Reseed From Playhead (a button)
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

#include "sample_util.hpp"

namespace {

enum : uint32_t {
  kEmitter = 1,
  kCount = 2,
  kSpeed = 3,
  kSpread = 4,
  kLife = 5,
  kSize = 6,
  kGravity = 7,
  kColor = 8,
  kSeed = 9,
  kTrail = 10,  // SDK 1.2
  kBlur = 11,   // SDK 1.2
  kReseed = 12,  // SDK 1.2: a button — Random Seed from the playhead, in the LAYER's frames
};

constexpr double kPi = 3.14159265358979323846;
constexpr int32_t kMaxTrail = 16;
constexpr int32_t kMaxShutter = 16;

/// SDK 1.1 callbacks exist on this host (the suite is appended to, never reordered).
bool has_scene_suite(const PrInData* in) {
  return in->host->struct_size >= offsetof(PrHostSuite, get_layer_transform) + sizeof(void*);
}
/// SDK 1.2: checkout_time / checkout_param, and the 1.2 PrInData fields.
bool has_times(const PrInData* in) {
  return in->host->struct_size >= offsetof(PrHostSuite, get_asset_sibling_bytes) + sizeof(void*) &&
         in->struct_size >= offsetof(PrInData, comp_to_world) + sizeof(in->comp_to_world);
}

uint32_t hash(uint32_t x) {
  x ^= x >> 16U;
  x *= 0x7FEB352DU;
  x ^= x >> 15U;
  x *= 0x846CA68BU;
  x ^= x >> 16U;
  return x;
}
double unit(uint32_t seed, uint32_t i, uint32_t k) { return static_cast<double>(hash(seed * 0x9E3779B9U + i * 0x85EBCA6BU + k)) / 4294967296.0; }

using V3 = std::array<double, 3>;

V3 mul_point(const double* m, const V3& p, double& w) {
  // Column-major 4×4 × (p, 1).
  const double x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];   // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];   // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];               // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return {x, y, z};
}

struct Dot {
  double x = 0, y = 0, radius = 0;  // world px
  float alpha = 0;
  double depth = 0;
  prs::Px color;
};

PrErr params_setup(const PrInData* in) {
  PrErr e = prs::add_simple(in, PR_PARAM_LAYER, kEmitter, "Emitter", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kCount, "Particles", 200, 0, 5000, 0, 1000, 0);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSpeed, "Velocity", 180, 0, 5000, 0, 1000, 1);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSpread, "Spread", 60, 0, 180, 0, 180, 1);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kLife, "Life (sec)", 2, 0.05, 30, 0.1, 10, 2);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSize, "Size", 6, 0, 200, 0, 50, 1);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kGravity, "Gravity", 0, -2000, 2000, -500, 500, 1);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_COLOR, kColor, "Color", {1, 0.85, 0.4, 1});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSeed, "Random Seed", 1, 0, 100000, 0, 1000, 0);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kTrail, "Trail Length (frames)", 0, 0, kMaxTrail, 0, kMaxTrail, 0);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_CHECKBOX, kBlur, "Motion Blur", {1, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_BUTTON, kReseed, "Reseed From Playhead", {0, 0, 0, 0});
  return e;
}

uint32_t index_of(const PrInData* in, PrParamDef* const* params, uint32_t id) {
  for (uint32_t i = 1; i < in->num_params; ++i) {
    if (params[i] != nullptr && params[i]->id == id) return i;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return 0;
}

/// One time the frame is drawn at: the frame itself, a shutter sample or a trail step.
struct Pass {
  int64_t time = 0;
  float weight = 1;
};

/// The passes: the shutter's samples (or the frame time) and, behind them, the trail.
std::vector<Pass> passes_of(const PrInData* in, PrParamDef* const* params) {
  std::vector<Pass> out;
  const bool v12 = has_times(in);
  const bool blur = v12 && in->motion_blur != 0 && prs::num(params, in, kBlur) != 0 && in->shutter_angle > 0;
  if (blur) {
    const int32_t n = std::clamp(static_cast<int32_t>(in->motion_blur_samples), 2, kMaxShutter);
    for (int32_t i = 0; i < n; ++i) {
      const double deg = in->shutter_phase + in->shutter_angle * static_cast<double>(i) / static_cast<double>(n - 1);
      out.push_back({in->current_time + static_cast<int64_t>(std::llround(deg / 360.0 * static_cast<double>(in->time_step))),
                     1.0F / static_cast<float>(n)});
    }
  } else {
    out.push_back({in->current_time, 1.0F});
  }
  const auto trail = v12 ? static_cast<int32_t>(std::clamp(prs::num(params, in, kTrail), 0.0, static_cast<double>(kMaxTrail))) : 0;
  for (int32_t k = 1; k <= trail; ++k) {
    const float fade = 0.6F * (1.0F - static_cast<float>(k) / static_cast<float>(trail + 1));
    out.push_back({in->current_time - k * in->time_step, fade});
  }
  return out;
}

PrErr pre_render(const PrInData* in, PrParamDef* const* params) {
  if (!has_times(in)) return PR_ERR_NONE;  // a generator checks nothing out
  for (const Pass& p : passes_of(in, params)) {
    if (p.time == in->current_time) continue;
    if (PrErr e = in->host->checkout_time(in->host_ref, p.time, PR_SAMPLE_ALL); e != PR_ERR_NONE) return e;
  }
  return PR_ERR_NONE;
}

/// The particles of one pass, projected and placed in world px.
PrErr dots_at(const PrInData* in, PrParamDef* const* params, const Pass& pass, std::vector<Dot>& dots) {
  const bool now = pass.time == in->current_time;
  // The params at this time: the frame's, or checkout_param at a sampled time.
  std::array<PrParamDef, 16> at{};
  const auto value = [&](uint32_t id, std::size_t k) -> double {
    if (now) return prs::num(params, in, id, k);
    const uint32_t idx = index_of(in, params, id);
    return idx == 0 ? 0 : at.at(idx).value[k];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  };
  // A time the host did not evaluate (a renderer that runs no frame hook): that pass is skipped.
  if (!now) {
    for (uint32_t i = 1; i < in->num_params && i < at.size(); ++i) {
      at.at(i).struct_size = sizeof(PrParamDef);
      const PrErr e = in->host->checkout_param(in->host_ref, i, pass.time, &at.at(i));
      if (e == PR_ERR_NOT_FOUND) return PR_ERR_NONE;
      if (e != PR_ERR_NONE) return e;
    }
  }

  PrCamera cam{};
  cam.struct_size = sizeof(cam);
  if (PrErr e = in->host->get_comp_camera(in->host_ref, pass.time, &cam); e != PR_ERR_NONE) return e == PR_ERR_NOT_FOUND ? PR_ERR_NONE : e;

  std::array<PrLight, PR_MAX_LIGHTS> lights{};
  for (PrLight& l : lights) l.struct_size = sizeof(PrLight);
  uint32_t nLights = 0;
  if (PrErr e = in->host->get_comp_lights(in->host_ref, pass.time, lights.data(), PR_MAX_LIGHTS, &nLights); e != PR_ERR_NONE) {
    return e == PR_ERR_NOT_FOUND ? PR_ERR_NONE : e;
  }
  std::array<double, 3> tint{1, 1, 1};
  if (nLights > 0) {
    tint = {0, 0, 0};
    for (uint32_t i = 0; i < std::min<uint32_t>(nLights, PR_MAX_LIGHTS); ++i) {
      for (std::size_t c = 0; c < 3; ++c) tint.at(c) += lights.at(i).color[c] * lights.at(i).intensity;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    }
  }

  // The emitter: the Emitter layer's origin in world space, else the comp's centre.
  V3 origin{cam.film_width / 2, cam.film_height / 2, 0};
  std::array<double, 16> lm{};
  const uint32_t emitterIndex = index_of(in, params, kEmitter);
  if (emitterIndex != 0 && in->host->get_layer_transform(in->host_ref, emitterIndex, pass.time, lm.data()) == PR_ERR_NONE) {
    origin = {lm[12], lm[13], lm[14]};
  }

  const auto count = static_cast<uint32_t>(std::clamp(value(kCount, 0), 0.0, 5000.0));
  const double speed = value(kSpeed, 0);
  const double spread = value(kSpread, 0) * kPi / 180;
  const double life = std::max(0.05, value(kLife, 0));
  const double size = value(kSize, 0);
  const double gravity = value(kGravity, 0);
  const auto seed = static_cast<uint32_t>(prs::num(params, in, kSeed));
  const double t = static_cast<double>(pass.time) / PR_TIME_SCALE;
  // Comp px → world px: comp_to_world on an SDK 1.2 host (PR_OUT_FLAG_COMP_SPACE), else the layer's
  // own placement (a comp-sized layer at the comp's origin).
  const double* m = has_times(in) ? in->comp_to_world : in->layer_to_world;
  const double scale = std::max(1e-6, 0.5 * (std::hypot(m[0], m[3]) + std::hypot(m[1], m[4])));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const prs::Px color{static_cast<float>(value(kColor, 0) * tint[0]), static_cast<float>(value(kColor, 1) * tint[1]),
                      static_cast<float>(value(kColor, 2) * tint[2]), 1};

  for (uint32_t i = 0; i < count; ++i) {
    // Born uniformly over one lifetime and reborn every lifetime: a steady stream.
    const double age = std::fmod(t + unit(seed, i, 0) * life, life);
    const double a = unit(seed, i, 1) * 2 * kPi;
    const double cone = std::acos(1 - unit(seed, i, 2) * (1 - std::cos(spread)));
    const double v = speed * (0.6 + 0.4 * unit(seed, i, 3));
    // Emitted along -y (up the screen) inside a cone of half-angle `spread`.
    const V3 dir{std::sin(cone) * std::cos(a), -std::cos(cone), std::sin(cone) * std::sin(a)};
    const V3 p{origin[0] + dir[0] * v * age, origin[1] + dir[1] * v * age + 0.5 * gravity * age * age, origin[2] + dir[2] * v * age};
    double w = 1;
    const V3 vc = mul_point(cam.view, p, w);
    if (vc[2] <= 1) continue;  // behind (or at) the eye
    double cw = 1;
    const V3 clip = mul_point(cam.projection, vc, cw);
    if (cw <= 0) continue;
    const double cx = clip[0] / cw;
    const double cy = clip[1] / cw;
    Dot d;
    d.x = m[0] * cx + m[1] * cy + m[2];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    d.y = m[3] * cx + m[4] * cy + m[5];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    d.depth = vc[2];
    d.radius = std::max(0.5, size * cam.zoom / vc[2] / 2) * scale;
    d.alpha = static_cast<float>(1 - age / life) * pass.weight;
    d.color = color;
    dots.push_back(d);
  }
  return PR_ERR_NONE;
}

PrErr smart_render(const PrInData* in, PrParamDef* const* params) {
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  if (!has_scene_suite(in)) return PR_ERR_BAD_VERSION;  // needs a 1.1 host (the manifest says so too)

  std::vector<Dot> dots;
  for (const Pass& pass : passes_of(in, params)) {
    if (PrErr e = dots_at(in, params, pass, dots); e != PR_ERR_NONE) return e;
  }
  // Far to near, so nearer particles cover farther ones.
  std::ranges::stable_sort(dots, [](const Dot& x, const Dot& y) { return x.depth > y.depth; });

  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) prs::write(*dst, x, y, {});
    for (const Dot& d : dots) {
      if (y + 0.5 < d.y - d.radius - 1 || y + 0.5 > d.y + d.radius + 1) continue;
      const auto x0 = static_cast<int32_t>(std::max(0.0, std::floor(d.x - d.radius - 1)));
      const auto x1 = static_cast<int32_t>(std::min(static_cast<double>(dst->width - 1), std::ceil(d.x + d.radius + 1)));
      for (int32_t x = x0; x <= x1; ++x) {
        const double r = std::hypot(x + 0.5 - d.x, y + 0.5 - d.y);
        const auto cov = static_cast<float>(std::clamp(d.radius + 0.5 - r, 0.0, 1.0)) * d.alpha;
        if (cov <= 0) continue;
        // Premultiplied "over".
        const prs::Px under = prs::read(*dst, x, y);
        prs::write(*dst, x, y, d.color * cov + under * (1 - cov));
      }
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL particles_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                             void* extra) {
  switch (cmd) {
    case PR_CMD_ABOUT:
      prs::message(out, "Particles 1.2 — Premation SDK sample (comp camera, lights, layer transforms; trails and motion blur "
                        "from other times).");
      return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 2, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_GENERATOR |
                       PR_OUT_FLAG_NON_PARAM_VARY | PR_OUT_FLAG_THREADED_RENDER | PR_OUT_FLAG_USES_CAMERA | PR_OUT_FLAG_USES_LIGHTS |
                       PR_OUT_FLAG_USES_LAYER_TRANSFORMS | PR_OUT_FLAG_SAMPLES_TIME | PR_OUT_FLAG_USES_SHUTTER | PR_OUT_FLAG_COMP_SPACE;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SMART_PRE_RENDER: return pre_render(in, params);
    case PR_CMD_SMART_RENDER: return smart_render(in, params);
    case PR_CMD_USER_CHANGED_PARAM: {
      // Reseed From Playhead: the seed is the playhead's frame in the LAYER's own time (SDK 1.2:
      // current_time is layer time — start offset, stretch, remap), so the same layer frame
      // always gives the same variation wherever the layer sits in the comp.
      const auto* x = static_cast<const PrUserChangedParamExtra*>(extra);
      if (x == nullptr || x->param_index >= in->num_params || params[x->param_index] == nullptr || params[x->param_index]->id != kReseed) return PR_ERR_NONE;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const uint32_t seedIndex = index_of(in, params, kSeed);
      const double frame = std::floor(static_cast<double>(in->current_time) * in->frame_rate / in->time_scale + 1e-6);
      const std::array<double, 4> v{std::clamp(frame + 1, 0.0, 100000.0), 0, 0, 0};
      return seedIndex == 0 ? PR_ERR_NONE : in->host->set_param_value(in->host_ref, seedIndex, v.data(), 1);
    }
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.particles", &particles_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
PrPluginInfo make_info() {
  PrPluginInfo i{};  // fields past these (later SDKs) stay zero
  i.struct_size = sizeof(PrPluginInfo);
  i.sdk_version = PR_SDK_VERSION;
  i.plugin_id = "com.premation.samples.particles";
  i.effect_count = 1;
  i.effects = kEffects;
  return i;
}
const PrPluginInfo kInfo = make_info();

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
