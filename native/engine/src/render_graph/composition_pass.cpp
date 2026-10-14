// CompositionPass — rendergraph/passes/CompositionPass.ts, ported branch by
// branch in the same order (the per-layer order of operations is documented at
// the top of the TS file and holds here unchanged):
//
//   renderList → processRenderable:
//     matte source (skipped) → quad-gain fold → isolated precomp → track matte
//     → adjustment layer → cull → backdrop blur / glass → advanced blend /
//     preserve transparency → direct draw | offscreen route (motion blur +
//     effect chain) → composite
//
// What is not ported yet is refused up front by support.cpp (the frame is
// reported `not-ported`), so every branch below is exercised by a golden scene.
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "effect_chain.hpp"
#include "effect_stats.hpp"
#include "fx_distance.hpp"
#include "fx_keys.hpp"
#include "passes.hpp"
#include "render_context.hpp"
#include "scene_depth.hpp"
#include "threed.hpp"

namespace premation::rg {
namespace {

bool is_solid_kind(api::RenderableKind k) {
  return k == api::RenderableKind::rect || k == api::RenderableKind::path || k == api::RenderableKind::group;
}
bool is_textured_kind(api::RenderableKind k) {
  return k == api::RenderableKind::image || k == api::RenderableKind::video || k == api::RenderableKind::text;
}

SolidShape to_solid_shape(const std::optional<api::RenderSdf>& sdf) {
  if (!sdf) return {};
  if (sdf->shape == api::RenderSdfShape::ellipse) return {2, 0, sdf->width, sdf->height};
  const double r = std::max(0.0, std::min(sdf->radius_px, std::min(sdf->width, sdf->height) / 2));
  return {1, r, sdf->width, sdf->height};
}

ColorTransform color_transform(const std::optional<api::RenderColorMatrix>& cm) {
  ColorTransform ct;
  if (!cm) return ct;
  for (std::size_t i = 0; i < 9 && i < cm->m.size(); ++i) ct.m.at(i) = cm->m[i];
  for (std::size_t i = 0; i < 3 && i < cm->offset.size(); ++i) ct.offset.at(i) = cm->offset[i];
  return ct;
}

Blend blend_of(api::RenderBlendMode b) { return static_cast<Blend>(static_cast<std::uint32_t>(b)); }

Color color_or_white(const api::Renderable& r) { return r.color ? color_of(*r.color) : Color::white(); }
Rect uv_or_full(const api::Renderable& r) { return r.uv_rect ? rect_of(*r.uv_rect) : Rect{0, 0, 1, 1}; }

}  // namespace

// fx_keys.hpp (KeyMix lives there: the 3D surface path keys its chains the same way).
std::uint64_t chain_content_key(const PassContext& ctx, const api::Renderable& r, double opacity, bool translationFree) {
  if (r.precomp || !r.precomp_children.empty() || r.deformed_mesh) return 0;
  KeyMix k;
  // P8b: a key without the layer's (whole-pixel) place on screen — the slot keeps where it was drawn.
  k.u64(translationFree ? 0x7038625ULL : 0);
  k.u64(static_cast<std::uint64_t>(r.kind));
  k.u64(static_cast<std::uint64_t>(r.blend));
  k.u64(static_cast<std::uint64_t>(r.sampling));
  for (const std::optional<std::string>* key : {&r.texture_key, &r.mask_texture_key, &r.lut_texture_key}) {
    if (!*key) {
      k.u64(0);
      continue;
    }
    const ResolvedBlob rb = ctx.textures.resolve(**key);
    if (rb.hash.empty()) return 0;
    k.str(rb.hash);
  }
  for (std::size_t i = 0; i < r.model_matrix.size(); ++i) {
    if (translationFree && (i == 6 || i == 7)) continue;
    k.f64(r.model_matrix[i]);
  }
  if (r.uv_rect) {
    k.f64(r.uv_rect->x);
    k.f64(r.uv_rect->y);
    k.f64(r.uv_rect->width);
    k.f64(r.uv_rect->height);
  }
  if (r.color) {
    k.f64(r.color->r);
    k.f64(r.color->g);
    k.f64(r.color->b);
    k.f64(r.color->a);
  }
  if (r.color_matrix) {
    for (const double v : r.color_matrix->m) k.f64(v);
    for (const double v : r.color_matrix->offset) k.f64(v);
  }
  if (r.sdf) {
    k.u64(static_cast<std::uint64_t>(r.sdf->shape));
    k.f64(r.sdf->width);
    k.f64(r.sdf->height);
    k.f64(r.sdf->radius_px);
  }
  k.f64(opacity);
  for (const auto& s : r.motion_samples) {
    for (const double v : s.model_matrix) k.f64(v);
    k.f64(s.opacity);
  }
  k.u64((std::uint64_t{ctx.viewport.pixelWidth} << 32U) | ctx.viewport.pixelHeight);
  for (std::size_t i = 0; i < 9; ++i) {
    if (translationFree && (i == 6 || i == 7)) continue;  // a pan is a translation too
    k.f64(ctx.viewport.viewProjection[i]);
  }
  return k.value();
}

namespace {

/// P8b: a 2D layer's chain run in a buffer placement of its own. The layer is
/// drawn with its origin on a WHOLE buffer pixel — and, when the chain's reach
/// would leave the buffer, moved inside it — under a view shifted by that
/// offset (ViewShift: every position the chain reads moves with it). The
/// result is then a function of the layer's content alone, not of where it is
/// on screen: a layer that only MOVES reuses it (AE runs effects in layer space
/// for the same reason), composited where the layer is — the fraction by a
/// bilinear shift.
struct PixelSnap {
  bool on = false;
  double px = 0;  // the layer origin on screen (viewport px, top-left origin)
  double py = 0;
  double bx = 0;  // where it is drawn in the chain's buffer (whole px)
  double by = 0;
};

PxBox unite_box(const PxBox& a, const PxBox& b) noexcept {
  return {std::min(a.x0, b.x0), std::min(a.y0, b.y0), std::max(a.x1, b.x1), std::max(a.y1, b.y1)};
}

/// Where `r`'s chain can draw (fx_bounds), from its drawn box: every pass and the result.
std::optional<PxBox> chain_reach(const PassContext& ctx, const api::Renderable& r) {
  const double pw = ctx.viewport.pixelWidth;
  const double ph = ctx.viewport.pixelHeight;
  const std::optional<PxBox> in = content_box(r, ctx.viewport.viewProjection, pw, ph);
  if (!in) return std::nullopt;
  const Rect world = ctx.viewport.visibleWorldRect;
  const FxBoundsView view{world.width > 0 ? pw / world.width : 1, world.height > 0 ? ph / world.height : 1};
  PxBox box = *in;
  PxBox all = *in;
  for (const api::RenderEffect& e : r.effects) {
    const std::optional<FxReach> reach = fx_reach(e, box, view);
    if (!reach) return std::nullopt;
    all = unite_box(unite_box(all, reach->passes), reach->out);
    box = reach->out;
  }
  return all;
}

PixelSnap pixel_snap(const PassContext& ctx, const api::Renderable& r) {
  PixelSnap s;
  if (r.precomp || !r.precomp_children.empty() || r.deformed_mesh || r.motion_samples.size() > 1) return s;
  const Mat3& vp = ctx.viewport.viewProjection;
  // A 2D view is scale + translate (Camera2D): anything else is not snapped.
  if (vp[1] != 0 || vp[3] != 0 || vp[0] == 0 || vp[4] == 0) return s;
  const double pw = ctx.viewport.pixelWidth;
  const double ph = ctx.viewport.pixelHeight;
  if (pw <= 0 || ph <= 0) return s;
  const Vec2 c = transform_point(mul(vp, mat3_of(r.model_matrix)), {0, 0});
  s.px = (c.x + 1) * 0.5 * pw;
  s.py = (1 - c.y) * 0.5 * ph;
  if (!std::isfinite(s.px) || !std::isfinite(s.py)) return s;
  s.bx = std::round(s.px);
  s.by = std::round(s.py);
  // A reach that would leave the buffer is moved inside it (when it fits), so
  // the kept result is whole and may be moved anywhere later. (Whatever the
  // grow-bounds switch: the result must not depend on it.)
  {
    if (const std::optional<PxBox> reach = chain_reach(ctx, r)) {
      const double ox = s.bx - s.px;
      const double oy = s.by - s.py;
      const PxBox b{reach->x0 + ox, reach->y0 + oy, reach->x1 + ox, reach->y1 + oy};
      if (b.x1 - b.x0 <= pw - 2) {
        if (b.x0 < 1) s.bx += std::ceil(1 - b.x0);
        else if (b.x1 > pw - 1) s.bx -= std::ceil(b.x1 - (pw - 1));
      }
      if (b.y1 - b.y0 <= ph - 2) {
        if (b.y0 < 1) s.by += std::ceil(1 - b.y0);
        else if (b.y1 > ph - 1) s.by -= std::ceil(b.y1 - (ph - 1));
      }
    }
  }
  s.on = true;
  return s;
}

/// P8b: the pass context's view moved by (dx, dy) viewport px — what the
/// layer's draw and its chain see — and put back when the scope ends.
class ViewShift {
 public:
  ViewShift(PassContext& ctx, double dx, double dy) : ctx_(&ctx), saved_(ctx.viewport) {
    if (dx == 0 && dy == 0) return;
    ViewportState& v = ctx.viewport;
    v.viewProjection = mul(translation(2 * dx / v.pixelWidth, -2 * dy / v.pixelHeight), v.viewProjection);
    const double wx = v.visibleWorldRect.width / v.pixelWidth;  // world units a pixel
    const double wy = v.visibleWorldRect.height / v.pixelHeight;
    v.visibleWorldRect.x -= dx * wx;
    v.visibleWorldRect.y -= dy * wy;
    v.centerX -= dx * wx;
    v.centerY -= dy * wy;
  }
  ~ViewShift() { ctx_->viewport = saved_; }
  ViewShift(const ViewShift&) = delete;
  ViewShift& operator=(const ViewShift&) = delete;
  ViewShift(ViewShift&&) = delete;
  ViewShift& operator=(ViewShift&&) = delete;

 private:
  PassContext* ctx_;
  ViewportState saved_;
};

std::optional<PxBox> shifted(const std::optional<PxBox>& b, double dx, double dy) {
  if (!b) return std::nullopt;
  // A fractional move spreads the box's edge texels by one pixel.
  const double gx = dx != std::floor(dx) ? 1 : 0;
  const double gy = dy != std::floor(dy) ? 1 : 0;
  return PxBox{b->x0 + dx - gx, b->y0 + dy - gy, b->x1 + dx + gx, b->y1 + dy + gy};
}

bool inside_view(const std::optional<PxBox>& b, double pw, double ph) {
  return b && b->x0 >= 0 && b->y0 >= 0 && b->x1 <= pw && b->y1 <= ph;
}

}  // namespace

// fx_keys.hpp: the key of a layer's whole effect-chain RESULT (P8).
std::uint64_t layer_fx_key(const PassContext& ctx, const api::Renderable& r, std::uint64_t contentKey, double opacity) {
  if (contentKey == 0) return 0;
  KeyMix k;
  k.u64(contentKey);
  k.f64(opacity);
  // The renderer's own switches choose the chain's passes (distance fields, grow bounds).
  k.u64((ctx.fxFields ? 1U : 0U) | (ctx.fxBounds ? 2U : 0U));
  // … and the project's working precision and space its intermediates run in.
  const api::RenderView& view = ctx.file.view;
  k.u64((std::uint64_t{view.bit_depth} << 8U) | (view.float16_textures ? 1U : 0U) | (view.float32_textures ? 2U : 0U));
  k.u64(static_cast<std::uint64_t>(view.working_space));
  for (const api::RenderEffect& e : r.effects) {
    if (e.type == "native-plugin") return 0;
    k.str(e.type);
    for (const api::RenderEffectParam& p : e.params) {
      if (!p.text.empty() || !p.texts.empty()) return 0;
      k.str(p.name);
      k.u64(static_cast<std::uint64_t>(p.kind));
      k.f64(p.number);
      k.u64(p.numbers.size());
      for (const double v : p.numbers) k.f64(v);
    }
  }
  return k.value();
}

namespace {

/// P8: finished effect-chain outputs of layers whose input and parameters did
/// not change, kept across frames in persistent device targets (`<prefix><i>`,
/// rgba16float at the chain buffer's size). A static glowing title or a textured
/// backdrop under moving layers pays its chain once, not every frame. A slot is
/// valid while its target lives: the device pool collects targets idle 120
/// frames, and a re-created one is reported `created` (as FxCache's distance
/// fields). E1: a second instance holds the 3D surfaces' chains (threed.cpp),
/// whose buffers are layer-sized.
class LayerFxCache {
 public:
  struct Slot {
    std::string name;
    std::uint64_t key = 0;
    std::uint32_t w = 0;
    std::uint32_t h = 0;
    std::uint64_t used = 0;
    std::optional<PxBox> covered;  // the chain result's reach (ChainResult::covered)
    /// P8b: where the layer's origin was drawn in the buffer (PixelSnap bx, by), for a translation-free key.
    std::optional<std::array<double, 2>> at;
    /// P8b: the whole result was on screen, so it may be moved (else reused in place only).
    bool movable = false;
    wgpu::TextureFormat format = wgpu::TextureFormat::RGBA16Float;  // the chain target's: a lossless copy
  };
  LayerFxCache(std::string_view prefix, std::size_t slots) : slots_(slots) {
    for (std::size_t i = 0; i < slots; ++i) slots_[i].name = std::string(prefix) + std::to_string(i);
  }
  [[nodiscard]] Slot* find(std::uint64_t key, std::uint32_t w, std::uint32_t h) noexcept {
    for (Slot& s : slots_) {
      if (s.key == key && s.w == w && s.h == h) return &s;
    }
    return nullptr;
  }
  /// The free or least recently used slot — never one this frame read or
  /// wrote (its texture may still be composited this frame); nullptr if all were.
  Slot* claim(std::uint64_t key, std::uint32_t w, std::uint32_t h, std::uint64_t frame) noexcept {
    Slot* pick = nullptr;
    for (Slot& s : slots_) {
      if (s.key == 0) { pick = &s; break; }
      if (s.used != frame && (pick == nullptr || s.used < pick->used)) pick = &s;
    }
    if (pick == nullptr) return nullptr;
    pick->key = key;
    pick->w = w;
    pick->h = h;
    pick->used = frame;
    pick->at.reset();
    pick->movable = false;
    return pick;
  }
  static void forget(Slot& s) noexcept { s.key = 0; }
  /// Whether `layer`'s chain key is the one it had last time (a layer whose
  /// chain changes every frame — animated — is never stored: the copy into a
  /// slot would be paid every frame and never read).
  bool steady(const std::string& layer, std::uint64_t key) {
    if (last_.size() > 4096) last_.clear();  // layers come and go over a session: bounded
    auto [it, fresh] = last_.try_emplace(layer, key);
    if (fresh) return false;
    const bool same = it->second == key;
    it->second = key;
    return same;
  }

 private:
  std::vector<Slot> slots_;
  std::unordered_map<std::string, std::uint64_t> last_;
};

/// Grow bounds: where a chain input drawn from `r` (renderable_cmds) can be non-zero.
std::optional<PxBox> drawn_box(const PassContext& ctx, const api::Renderable& r) {
  return content_box(r, ctx.viewport.viewProjection, ctx.viewport.pixelWidth, ctx.viewport.pixelHeight);
}

/// The blends (device.cpp blend_state) under which a transparent source texel
/// leaves the destination exactly as it was.
bool transparent_is_noop(Blend b) {
  return b == Blend::normal || b == Blend::add || b == Blend::screen || b == Blend::subtract || b == Blend::overlay ||
         b == Blend::lighter || b == Blend::atop;
}

}  // namespace

// ── emit helpers (passUtils.ts) ─────────────────────────────────────────────

void emit_solid(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& c, double opacity, Blend blend,
                const SolidShape& shape) {
  cmds.add(Mat::SOLID_MATERIAL, blend, pack_solid(ctx.packer(), mvp, c, opacity, shape));
}

void emit_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                   const TexRef& tex, const SamplerRef& smp, const Rect& uv, const ColorTransform& ct, bool sampleLinear) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::TEXTURED_LINEAR_MATERIAL : Mat::TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear));
  it.texture = tex;
  it.sampler = smp;
}

void emit_silhouette(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& c, double opacity, Blend blend,
                     const TexRef& tex, const SamplerRef& smp, const Rect& uv) {
  DrawItem& it = cmds.add(Mat::TEXTURED_SILHOUETTE_MATERIAL, blend, pack_textured(ctx.packer(), mvp, uv, c, opacity));
  it.texture = tex;
  it.sampler = smp;
}

void emit_masked_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity,
                          Blend blend, const TexRef& tex, const SamplerRef& smp, const TexRef& mask, const Rect& uv,
                          const ColorTransform& ct, bool sampleLinear) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::MASKED_TEXTURED_LINEAR_MATERIAL : Mat::MASKED_TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear));
  it.texture = tex;
  it.sampler = smp;
  it.mask = mask;
}

void emit_lut_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                       const TexRef& tex, const SamplerRef& smp, const TexRef& lut, const Rect& uv,
                       const ColorTransform& ct, bool sampleLinear) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::LUT_TEXTURED_LINEAR_MATERIAL : Mat::LUT_TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear));
  it.texture = tex;
  it.sampler = smp;
  it.mask = lut;
}

void emit_matte_combine(PassContext& ctx, Commands& cmds, const Mat3& mvp, Blend blend, const TexRef& tex,
                        const SamplerRef& smp, const TexRef& matte, const ColorTransform& mode, const Rect& uv) {
  DrawItem& it = cmds.add(Mat::MATTE_COMBINE_MATERIAL, blend, pack_textured(ctx.packer(), mvp, uv, Color::white(), 1, mode));
  it.texture = tex;
  it.sampler = smp;
  it.mask = matte;
}

void emit_blend_combine(PassContext& ctx, Commands& cmds, const Mat3& mvp, Blend blend, const TexRef& tex,
                        const SamplerRef& smp, const TexRef& backdrop, const ColorTransform& mode, const Rect& uv) {
  DrawItem& it = cmds.add(Mat::BLEND_COMBINE_MATERIAL, blend, pack_textured(ctx.packer(), mvp, uv, Color::white(), 1, mode));
  it.texture = tex;
  it.sampler = smp;
  it.mask = backdrop;
}

/// emitLayerTexture: a deformed mesh if present, else a textured quad.
void emit_layer_texture(PassContext& ctx, Commands& cmds, const api::Renderable& r, const TexRef& tex,
                        const SamplerRef& smp, const Rect& uv, double opacity, const Mat3* modelOverride,
                        const Blend* blendOverride, bool sampleLinear) {
  const Blend blend = blendOverride != nullptr ? *blendOverride : blend_of(r.blend);
  const Mat3 mvp = mvp_for(ctx.viewport, modelOverride != nullptr ? *modelOverride : mat3_of(r.model_matrix));
  if (r.deformed_mesh) {
    const auto& dm = *r.deformed_mesh;
    const std::size_t vertexFloats = dm.vertices.size() / 4;
    const std::size_t indexCount = dm.triangles.size() / 2;
    std::string vkey = "geometry:mesh-vertex:" + r.id + ":" + std::to_string(vertexFloats);
    std::string ikey = "geometry:mesh-index:" + r.id + ":" + std::to_string(indexCount);
    const wgpu::Buffer vb = ctx.dev.geometry(vkey, dm.vertices, false, true);
    const wgpu::Buffer ib = ctx.dev.geometry(ikey, dm.triangles, true, true);
    // packDeformedMesh: mat3 mvp + tint + 3 colour rows + srcSpace (no uvRect).
    Packer p = ctx.packer();
    p.mat3(mvp).color(color_or_white(r), opacity).color_rows(color_transform(r.color_matrix)).src_space(sampleLinear);
    DrawItem& it = cmds.add(sampleLinear ? Mat::DEFORMED_MESH_LINEAR_MATERIAL : Mat::DEFORMED_MESH_MATERIAL, blend, p.span());
    it.texture = tex;
    it.sampler = smp;
    it.vertexBuffer = vb;
    it.indexBuffer = ib;
    it.indexCount = static_cast<std::uint32_t>(indexCount);
    it.indexFormat = wgpu::IndexFormat::Uint16;
    return;
  }
  emit_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, smp, r.uv_rect ? rect_of(*r.uv_rect) : uv,
                color_transform(r.color_matrix), sampleLinear);
}

namespace {

struct ListState {
  std::string out;
  std::size_t depth = 0;
  Commands main;
  ById byId;
};

class CompositionPass final : public RenderPass, public MapLayerSource {
 public:
  [[nodiscard]] std::string_view name() const override { return "composition"; }
  [[nodiscard]] std::vector<std::string> writes() const override {
    std::vector<std::string> w = {std::string(kSceneColor), std::string(kLayerTarget), std::string(kBlur1),
                                  std::string(kBlur2),      std::string(kBlur3),       std::string(kMatteTarget),
                                  std::string(kDofTarget),  std::string(kFxHist),     std::string(kFxLut),
                                  std::string(kGeneratorTarget), std::string(kFxSilhouette), std::string(kFxScopeMask),
                                  std::string(kFxBlendInput)};
    for (const auto n : kPrecompTargets) w.emplace_back(n);
    for (const auto n : kFxAux) w.emplace_back(n);
    return w;
  }
  [[nodiscard]] std::vector<std::string> after() const override { return {"background"}; }

  bool execute(PassContext& ctx, std::string& /*error*/) override {
    precompTex_.clear();
    owned_.clear();  // last frame's synthesized renderables
    std::vector<const api::Renderable*> list;
    list.reserve(ctx.file.scene.renderables.size());
    for (const auto& r : ctx.file.scene.renderables) list.push_back(&r);
    // AE parity 4.4: a visible environment is the backdrop under every layer.
    if (ctx.target(ctx.activeColorTarget) != nullptr) {
      render_sky(ctx, ctx.activeColorTarget, [this, &ctx](const std::optional<std::string>& k) { return tex_for(ctx, k); });
    }
    // E8: the viewport's ground grid rides the frame's last 3D run (threed.cpp);
    // with no 3D run it is drawn here over the finished frame.
    ctx.groundGridPending = ctx.file.scene.ground_grid.has_value() && ctx.scope.camera3d != nullptr;
    ctx.groundGridRun = false;
    render_list(ctx, list, ctx.activeColorTarget, 0);
    if (ctx.groundGridPending) render_ground_grid(ctx, ctx.activeColorTarget);
    return true;
  }

 private:
  /// Offscreen textures of isolated precomps rendered this frame, by `precomp:<id>` key.
  std::unordered_map<std::string, TexRef> precompTex_;
  /// AE parity 4.2: images of 3D-run layers drawn by render_3d_group, during composite_special_3d.
  const std::unordered_map<std::string, TexRef>* predrawn_ = nullptr;
  /// P8: finished layer chains kept across frames (render thread only).
  LayerFxCache layerFx_{"fx-layer-", 8};
  /// E1: finished 3D surface chains (threed.cpp resolve_surface), layer-sized
  /// buffers — a 3D comp holds more effect layers at once than a 2D one.
  LayerFxCache surfaceFx_{"fx-surface-", 16};
  /// Kill switch (PREMATION_LAYER_FX_CACHE=0): every chain runs, as before P8.
  bool layerFxEnabled_ = [] {
#ifdef _WIN32
    char* v = nullptr;
    std::size_t len = 0;
    if (_dupenv_s(&v, &len, "PREMATION_LAYER_FX_CACHE") != 0 || v == nullptr) return true;
    const bool on = std::string_view(v) != "0";
    std::free(v);  // NOLINT(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory): _dupenv_s allocates with malloc
    return on;
#else
    const char* v = std::getenv("PREMATION_LAYER_FX_CACHE");  // NOLINT(concurrency-mt-unsafe): read once, at construction
    return v == nullptr || std::string_view(v) != "0";
#endif
  }();
  /// Renderables synthesized this frame (reparented precomp children, prepared containers).
  std::vector<std::unique_ptr<std::vector<api::Renderable>>> owned_;

  TexRef tex_for(PassContext& ctx, const std::optional<std::string>& key) {
    if (!key) return {};
    const auto it = precompTex_.find(*key);
    if (it != precompTex_.end()) return it->second;
    return ctx.texture(*key);
  }

  void flush(PassContext& ctx, ListState& st) {
    if (st.main.empty()) return;
    ctx.draw_into(st.out, st.main, false);
    st.main.clear();
  }

  SamplerRef sampler_for(PassContext& ctx, const api::Renderable& r) {
    return r.sampling == api::RenderSampling::nearest ? ctx.nearest_clamp() : ctx.linear_clamp();
  }

  /// renderableCmds: one renderable (solid / textured / masked / LUT) at `opacity`.
  void renderable_cmds(PassContext& ctx, const api::Renderable& r, double opacity, Commands& cmds,
                       const Mat3* modelOverride = nullptr, const Blend* blendOverride = nullptr) {
    const Blend blend = blendOverride != nullptr ? *blendOverride : Blend::normal;
    const SamplerRef smp = sampler_for(ctx, r);
    const Rect uv = uv_or_full(r);
    const Mat3 mvp = mvp_for(ctx.viewport, modelOverride != nullptr ? *modelOverride : mat3_of(r.model_matrix));
    const bool solid = is_solid_kind(r.kind);
    const bool textured = is_textured_kind(r.kind);
    if (r.mask_texture_key) {
      const TexRef mask = ctx.texture(*r.mask_texture_key);
      TexRef tex = textured && r.texture_key ? tex_for(ctx, r.texture_key) : TexRef{};
      if (solid && !tex) tex = ctx.texture("texture:white");
      if (mask && tex) {
        emit_masked_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, smp, mask, uv,
                             color_transform(r.color_matrix), tex.sampleLinear);
      }
    } else if (solid && r.color) {
      emit_solid(ctx, cmds, mvp, color_of(*r.color), opacity, blend, to_solid_shape(r.sdf));
    } else if (textured && r.texture_key) {
      const TexRef tex = tex_for(ctx, r.texture_key);
      const TexRef lut = r.lut_texture_key ? ctx.texture(*r.lut_texture_key) : TexRef{};
      if (tex && lut) {
        emit_lut_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, smp, lut, uv,
                          color_transform(r.color_matrix), tex.sampleLinear);
      } else if (tex) {
        emit_layer_texture(ctx, cmds, r, tex, smp, uv, opacity, modelOverride, blendOverride, tex.sampleLinear);
      }
    }
  }

  /// layerIntoTarget: content (+ motion-blur accumulation) into `dest`, then its effect chain, settled in `dest`.
  TexRef layer_into_target(PassContext& ctx, const api::Renderable& r, double opacity, std::string_view dest,
                           const ListState& st) {
    // AE parity 4.2: a 3D-run layer arrives already drawn in 3D (perspective,
    // its effects, its motion samples, occluded by the run).
    if (predrawn_ != nullptr) {
      if (const auto it = predrawn_->find(r.id); it != predrawn_->end()) return it->second;
    }
    Commands cmds;
    if (r.motion_samples.size() > 1) {
      const auto n = static_cast<double>(r.motion_samples.size());
      const Blend add = Blend::add;
      for (const auto& s : r.motion_samples) {
        const Mat3 m = mat3_of(s.model_matrix);
        renderable_cmds(ctx, r, s.opacity / n, cmds, &m, &add);
      }
    } else {
      renderable_cmds(ctx, r, opacity, cmds);
    }
    if (cmds.empty()) return {};
    ctx.draw_into(dest, cmds, true);
    RenderTarget* t = ctx.target(dest);
    if (t == nullptr) return {};
    return apply_layer_effects(ctx, r, t->tex(), dest, st, opacity);
  }

  TexRef apply_layer_effects(PassContext& ctx, const api::Renderable& r, const TexRef& src, std::string_view dest,
                             const ListState& st, double opacity) {
    if (r.effects.empty()) return src;
    const std::uint64_t contentKey = chain_content_key(ctx, r, opacity);
    const std::uint64_t fxKey = layerFxEnabled_ ? layer_fx_key(ctx, r, contentKey, opacity) : 0;
    if (const std::optional<ChainResult> kept = reuse_layer_fx(ctx, fxKey, dest)) return kept->tex;
    const std::array<std::string_view, 4> pool = {dest, kBlur1, kBlur2, kBlur3};
    const ChainResult res = run_effects_chain(ctx, r.effects, src, pool, st.byId, r.id, *this, nullptr, contentKey,
                                              drawn_box(ctx, r));
    TexRef out = res.tex;
    if (res.name != dest) {
      Commands copy;
      emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::none, res.tex, ctx.linear_clamp(), {0, 0, 1, 1},
                    kIdentityColor, true);
      ctx.draw_into(dest, copy, true);
      out = ctx.target(dest)->tex();
    }
    keep_layer_fx(ctx, r.id, fxKey, out, dest, res.covered);
    return out;
  }

  /// P8: an earlier frame's chain result under `fxKey` (0 = not cacheable) —
  /// the same input and parameters draw the same result. Copied into `dest`
  /// when one is named; otherwise the kept texture itself (it outlives the frame).
  std::optional<ChainResult> reuse_layer_fx(PassContext& ctx, std::uint64_t fxKey, std::string_view dest) {
    if (fxKey == 0) return std::nullopt;
    const std::uint32_t w = ctx.viewport.pixelWidth;
    const std::uint32_t h = ctx.viewport.pixelHeight;
    LayerFxCache::Slot* s = layerFx_.find(fxKey, w, h);
    if (s == nullptr) return std::nullopt;
    bool created = false;
    RenderTarget& t = ctx.dev.target(s->name, w, h, s->format, 1, false, &created);
    if (created) {
      LayerFxCache::forget(*s);  // the pool collected it: the chain runs again
      return std::nullopt;
    }
    s->used = ctx.dev.frame();
    if (ctx.effectStats != nullptr) ++ctx.effectStats->layerChainsReused;
    if (dest.empty()) return ChainResult{t.tex(), s->name, s->covered};
    // Exact: a texture copy. The textured shader's storage decode darkened every
    // reused result's midtones in a linear working space, and even raw its
    // unpremultiply round trip moved half-float texels by an ulp (P8b, 2026-10-10).
    RenderTarget* d = ctx.target(dest);
    if (d != nullptr && d->format == t.format && d->width == t.width && d->height == t.height) {
      copy_texels(ctx, t, *d);
    } else {
      Commands copy;
      emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::none, t.tex(), ctx.nearest_clamp(), {0, 0, 1, 1},
                    kIdentityColor, true);
      ctx.draw_into(dest, copy, true);
    }
    return ChainResult{ctx.target(dest)->tex(), dest, s->covered};
  }

  /// P8b: a kept chain result for a snapped layer (PixelSnap), and the move
  /// from where its origin sits in the kept buffer to where the layer is now.
  struct KeptFx {
    TexRef tex;
    std::optional<PxBox> covered;  // at the kept place
    double dx = 0;
    double dy = 0;
  };

  /// P8b: an earlier frame's chain result under the translation-free `fxKey`,
  /// moved to where the layer is now. A result the buffer's edge cut (not
  /// `movable`) is reused only where it was drawn.
  std::optional<KeptFx> reuse_layer_fx_moved(PassContext& ctx, std::uint64_t fxKey, const PixelSnap& snap) {
    if (fxKey == 0 || !snap.on) return std::nullopt;
    const std::uint32_t w = ctx.viewport.pixelWidth;
    const std::uint32_t h = ctx.viewport.pixelHeight;
    LayerFxCache::Slot* s = layerFx_.find(fxKey, w, h);
    if (s == nullptr || !s->at) return std::nullopt;
    if (!s->movable && ((*s->at)[0] != snap.bx || (*s->at)[1] != snap.by)) return std::nullopt;
    const double dx = snap.px - (*s->at)[0];
    const double dy = snap.py - (*s->at)[1];
    bool created = false;
    RenderTarget& t = ctx.dev.target(s->name, w, h, s->format, 1, false, &created);
    if (created) {
      LayerFxCache::forget(*s);  // the pool collected it: the chain runs again
      return std::nullopt;
    }
    s->used = ctx.dev.frame();
    if (ctx.effectStats != nullptr) ++ctx.effectStats->layerChainsReused;
    return KeptFx{t.tex(), s->covered, dx, dy};
  }

  /// P8: keep `out` (the chain result of layer `id` under `fxKey`) for later
  /// frames — once the layer's key held for two frames in a row. P8b: a snapped
  /// layer's result is kept with where it was drawn; it may be MOVED only when
  /// its whole reach was on screen (a result cut by the viewport's edge cannot).
  void keep_layer_fx(PassContext& ctx, const std::string& id, std::uint64_t fxKey, const TexRef& out, std::string_view outName,
                     const std::optional<PxBox>& covered, const PixelSnap* snap = nullptr) {
    if (fxKey == 0 || !layerFx_.steady(id, fxKey)) return;
    const RenderTarget* src = ctx.target(outName);
    if (src == nullptr) return;
    const std::uint32_t w = ctx.viewport.pixelWidth;
    const std::uint32_t h = ctx.viewport.pixelHeight;
    const bool snapped = snap != nullptr && snap->on;
    LayerFxCache::Slot* slot = layerFx_.claim(fxKey, w, h, ctx.dev.frame());
    if (slot == nullptr) return;  // every slot is in use this frame
    slot->covered = covered;
    if (snapped) {
      slot->at = std::array<double, 2>{snap->bx, snap->by};
      slot->movable = inside_view(covered, w, h);
    }
    slot->format = src->format;
    RenderTarget& t = ctx.dev.target(slot->name, w, h, slot->format, 1, false);
    if (src->width == t.width && src->height == t.height) {
      copy_texels(ctx, *src, t);  // exact, as reuse_layer_fx copies it back
      return;
    }
    Commands keep;
    emit_textured(ctx, keep, screen_mvp(), Color::white(), 1, Blend::none, out, ctx.nearest_clamp(), {0, 0, 1, 1},
                  kIdentityColor, true);  // raw: the chain's working-space texels as they are
    draw_to_target(ctx, t, keep);
  }

  /// P8: `from` into `to` texel for texel (same format and size), in encode order.
  static void copy_texels(PassContext& ctx, const RenderTarget& from, const RenderTarget& to) {
    wgpu::TexelCopyTextureInfo a{};
    a.texture = from.texture;
    wgpu::TexelCopyTextureInfo b{};
    b.texture = to.texture;
    const wgpu::Extent3D size{from.width, from.height, 1};
    ctx.dev.encoder().CopyTextureToTexture(&a, &b, &size);
  }

 public:
  /// E1: an earlier frame's chain result for a 3D surface under `key` at w × h
  /// (threed.cpp resolve_surface). The slot's own texture: it outlives the
  /// frame, and no slot read or written this frame is claimed again in it.
  TexRef reuse_surface_fx(PassContext& ctx, std::uint64_t key, std::uint32_t w, std::uint32_t h) override {
    if (key == 0 || !layerFxEnabled_) return {};
    LayerFxCache::Slot* s = surfaceFx_.find(key, w, h);
    if (s == nullptr) return {};
    bool created = false;
    RenderTarget& t = ctx.dev.target(s->name, w, h, s->format, 1, false, &created);
    if (created) {
      LayerFxCache::forget(*s);  // the pool collected it: the chain runs again
      return {};
    }
    s->used = ctx.dev.frame();
    if (ctx.effectStats != nullptr) ++ctx.effectStats->layerChainsReused;
    return t.tex();
  }

  /// E1: keep `result` (layer `id`'s surface chain under `key`) once the key
  /// held two frames in a row; the kept copy's texture, which the surface's
  /// draw samples directly (empty = not kept this frame).
  TexRef keep_surface_fx(PassContext& ctx, const std::string& id, std::uint64_t key, const RenderTarget& result) override {
    if (key == 0 || !layerFxEnabled_ || !surfaceFx_.steady(id, key)) return {};
    LayerFxCache::Slot* slot = surfaceFx_.claim(key, result.width, result.height, ctx.dev.frame());
    if (slot == nullptr) return {};  // every slot is in use this frame
    slot->covered.reset();
    slot->format = result.format;
    RenderTarget& t = ctx.dev.target(slot->name, result.width, result.height, result.format, 1, false);
    copy_texels(ctx, result, t);
    return t.tex();
  }

  bool composite_special_3d(PassContext& ctx, const api::Renderable& r, const std::unordered_map<std::string, TexRef>& predrawn,
                            std::string_view out, const ById& byId) override {
    ListState st;
    st.out = std::string(out);
    st.byId = byId;
    predrawn_ = &predrawn;
    process(ctx, r, st);
    flush(ctx, st);
    predrawn_ = nullptr;
    return true;
  }

  /// Camera program D1: the comp's scene depth for a depth-reading effect
  /// (one pass per frame and placement, shared — scene_depth.cpp).
  TexRef scene_depth(PassContext& ctx, std::uint32_t w, std::uint32_t h, const std::array<double, 9>& compToWorld,
                     std::string_view selfId) override {
    SceneDepth::Request req;
    req.width = w;
    req.height = h;
    req.compToWorld = compToWorld;
    req.selfId = selfId;
    const SceneDepth::Result* r = sceneDepth_.render(ctx, req);
    if (r == nullptr || !r->view) return {};
    // External identity (high bit): stable per texture object, never a Device id.
    const auto id = (std::uint64_t{1} << 63U) | static_cast<std::uint64_t>(std::bit_cast<std::uintptr_t>(r->texture.Get()));
    return TexRef{r->view, id, r->width, r->height, false};
  }

  /// displacementMapTexture: render a referenced layer into MATTE_TARGET.
  TexRef map_layer(PassContext& ctx, const ById& byId, std::string_view mapLayerId, std::string_view selfId) override {
    if (mapLayerId.empty() || mapLayerId == selfId) return {};
    const auto it = byId.find(mapLayerId);
    if (it == byId.end()) return {};
    Commands cmds;
    renderable_cmds(ctx, *it->second, 1, cmds);
    if (cmds.empty()) return {};
    ctx.draw_into(kMatteTarget, cmds, true);
    return ctx.target(kMatteTarget)->tex();
  }

 private:
  /// D1: the scene depth depth-reading effects sample (render thread only).
  SceneDepth sceneDepth_;
  /// Mat3 reparent of a renderable list (prepareIsolatedPrecomp `reparent`).
  static std::vector<api::Renderable> reparent(const std::vector<const api::Renderable*>& list, const Mat3& P) {
    std::vector<api::Renderable> out;
    out.reserve(list.size());
    for (const api::Renderable* c : list) {
      api::Renderable x = *c;
      const Mat3 m = mul(P, mat3_of(c->model_matrix));
      x.model_matrix.assign(m.m.begin(), m.m.end());
      const Rect b = rect_of(c->bounds);
      const std::array<Vec2, 4> pts = {transform_point(P, {b.x, b.y}), transform_point(P, {b.x + b.width, b.y}),
                                       transform_point(P, {b.x, b.y + b.height}),
                                       transform_point(P, {b.x + b.width, b.y + b.height})};
      double minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
      for (const Vec2& p : pts) {
        minX = std::min(minX, p.x);
        maxX = std::max(maxX, p.x);
        minY = std::min(minY, p.y);
        maxY = std::max(maxY, p.y);
      }
      x.bounds = {minX, minY, maxX - minX, maxY - minY};
      for (auto& s : x.motion_samples) {
        const Mat3 sm = mul(P, mat3_of(s.model_matrix));
        s.model_matrix.assign(sm.m.begin(), sm.m.end());
      }
      if (c->precomp && !c->precomp->flat_width) {
        std::vector<const api::Renderable*> kids;
        kids.reserve(c->precomp_children.size());
        for (const auto& k : c->precomp_children) kids.push_back(&k);
        x.precomp_children = reparent(kids, P);
      }
      out.push_back(std::move(x));
    }
    return out;
  }

  /// prepareIsolatedPrecomp: render the subtree offscreen and return the container as a textured renderable.
  bool prepare_isolated_precomp(PassContext& ctx, const api::Renderable& r, ListState& st, std::size_t slot,
                                bool inlineFallback, api::Renderable& prepared) {
    if (!r.precomp) return false;
    const auto& pre = *r.precomp;
    const bool flat = pre.flat_width.has_value();
    const Mat3 fullModel = model_from_rect(ctx.viewport.visibleWorldRect);
    const Mat3 cardToUnit = flat ? scaling(1 / std::max(1.0, *pre.flat_width), 1 / std::max(1.0, pre.flat_height.value_or(1)))
                                 : Mat3{};
    std::vector<const api::Renderable*> kids;
    kids.reserve(r.precomp_children.size());
    for (const auto& k : r.precomp_children) kids.push_back(&k);

    if (slot >= kPrecompTargets.size()) {
      if (!inlineFallback) return false;
      flush(ctx, st);
      std::vector<api::Renderable> direct;
      if (flat) {
        direct = reparent(kids, mul(mat3_of(r.model_matrix), cardToUnit));
      } else {
        for (const auto* k : kids) direct.push_back(*k);
      }
      for (auto& c : direct) c.opacity *= r.opacity;
      auto& keep = owned_.emplace_back(std::make_unique<std::vector<api::Renderable>>(std::move(direct)));
      std::vector<const api::Renderable*> ptrs;
      for (const auto& c : *keep) ptrs.push_back(&c);
      render_list(ctx, ptrs, st.out, st.depth);
      return false;
    }
    flush(ctx, st);
    const std::string_view targetName = kPrecompTargets.at(slot);
    std::vector<const api::Renderable*> children = kids;
    if (flat) {
      auto& keep = owned_.emplace_back(
          std::make_unique<std::vector<api::Renderable>>(reparent(kids, mul(fullModel, cardToUnit))));
      children.clear();
      for (const auto& c : *keep) children.push_back(&c);
    }
    {
      const Commands none;
      ctx.draw_into(targetName, none, true);
    }
    // precompScope: a sealed comp instance with its own 3D frame replaces the
    // camera, lights and environment wholesale (SSAO off) for its subtree.
    const Scope3D saved = ctx.scope;
    if (pre.camera3d) {
      ctx.scope = Scope3D{&*pre.camera3d, &pre.lights3d, pre.env_map ? &*pre.env_map : nullptr, false,
                          pre.fog ? &*pre.fog : nullptr, nullptr, &r.precomp_children};
    }
    render_list(ctx, children, std::string(targetName), slot + 1);
    ctx.scope = saved;
    RenderTarget* pt = ctx.target(targetName);
    if (pt == nullptr) return false;
    TexRef tex = pt->tex();

    if (r.mask_texture_key) {
      const TexRef maskRes = ctx.texture(*r.mask_texture_key);
      if (maskRes) {
        Commands maskCmds;
        emit_textured(ctx, maskCmds, mvp_for(ctx.viewport, flat ? fullModel : mat3_of(r.model_matrix)), Color::white(), 1,
                      Blend::normal, maskRes, ctx.linear_clamp(), {0, 0, 1, 1}, kIdentityColor, maskRes.sampleLinear);
        ctx.draw_into(kBlur1, maskCmds, true);
        const TexRef maskTex = ctx.target(kBlur1)->tex();
        Commands combine;
        ColorTransform alphaMode;
        alphaMode.m = {0, 0, 0, 0, 0, 0, 0, 0, 0};
        emit_matte_combine(ctx, combine, screen_mvp(), Blend::none, tex, ctx.linear_clamp(), maskTex, alphaMode, {0, 0, 1, 1});
        ctx.draw_into(kBlur2, combine, true);
        const TexRef masked = ctx.target(kBlur2)->tex();
        Commands copy;
        emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::none, masked, ctx.linear_clamp(), {0, 0, 1, 1},
                      kIdentityColor, true);
        ctx.draw_into(targetName, copy, true);
        tex = pt->tex();
      }
    }
    if (r.texture_key) precompTex_[*r.texture_key] = tex;

    prepared = r;
    prepared.mask_texture_key.reset();
    prepared.precomp.reset();
    prepared.precomp_children.clear();
    prepared.sdf.reset();
    prepared.deformed_mesh.reset();
    prepared.kind = api::RenderableKind::image;
    const Mat3 model = flat ? mat3_of(r.model_matrix) : fullModel;
    prepared.model_matrix.assign(model.m.begin(), model.m.end());
    if (!flat) {
      const Rect v = ctx.viewport.visibleWorldRect;
      prepared.bounds = {v.x, v.y, v.width, v.height};
    }
    prepared.uv_rect = api::Rect{0, 0, 1, 1};
    prepared.color = r.color ? *r.color : api::Color{1, 1, 1, 1};
    prepared.motion_samples.clear();
    if (r.motion_samples.size() > 1) {
      Mat3 inv;
      if (!flat && invert(mat3_of(r.model_matrix), inv)) {
        for (const auto& s : r.motion_samples) {
          const Mat3 m = mul(mat3_of(s.model_matrix), mul(inv, fullModel));
          prepared.motion_samples.push_back({std::vector<double>(m.m.begin(), m.m.end()), s.opacity, {}});
        }
      } else if (flat) {
        prepared.motion_samples = r.motion_samples;
      }
    }
    return true;
  }

  /// renderGeneratorField: draw a plugin generator's instances into
  /// GENERATOR_TARGET and hand the layer on as a plain textured renderable.
  bool render_generator_field(PassContext& ctx, const api::Renderable& r, api::Renderable& prepared) {
    if (!r.generator) return false;
    const auto& gen = *r.generator;
    Commands cmds;
    if (gen.count > 0) {
      std::size_t cap = 64;
      while (cap < gen.count) cap *= 2;
      const std::size_t floats = cap * gen.stride;
      std::vector<std::uint8_t> bytes(floats * 4, 0);
      const std::size_t used = std::min<std::size_t>(gen.instances.size(), std::size_t{gen.count} * gen.stride * 4);
      std::copy_n(gen.instances.begin(), used, bytes.begin());
      const wgpu::Buffer instances =
          ctx.dev.geometry("generator:instances:" + r.id + ":" + std::to_string(floats), bytes, false, true);
      const double w = gen.width > 0 ? gen.width : 1;
      const double h = gen.height > 0 ? gen.height : 1;
      const Mat3 fieldToWorld = mul(mat3_of(r.model_matrix), mul(translation(0.5, 0.5), scaling(1 / w, 1 / h)));
      const Mat3 mvp = mvp_for(ctx.viewport, fieldToWorld);
      const TexRef texture = gen.texture_key && ctx.texture_ready(*gen.texture_key) ? ctx.texture(*gen.texture_key) : TexRef{};
      const double kind = gen.primitive == api::RenderGeneratorPrimitive::point  ? 0
                          : gen.primitive == api::RenderGeneratorPrimitive::quad ? 1
                                                                                 : 2;
      const double focal = gen.perspective.value_or(0);
      const double cw = gen.cell_size.size() > 1 ? gen.cell_size[0] : 1;
      const double chh = gen.cell_size.size() > 1 ? gen.cell_size[1] : 1;
      const Blend blend = gen.blend == api::RenderGeneratorBlend::add ? Blend::add : Blend::normal;
      const bool wide = gen.stride == 11;
      // packGenerator: mat3 mvp + (kind, focal, cell). Copied out of the scratch
      // packer so two calls cannot alias.
      const auto uniforms = [&](double k) {
        Packer p = ctx.packer();
        const std::span<const float> u = p.mat3(mvp).vec4(k, focal, cw, chh).span();
        return std::vector<float>(u.begin(), u.end());
      };
      if (gen.primitive == api::RenderGeneratorPrimitive::mesh) {
        const TexRef meshTex = texture ? texture : ctx.texture("texture:white");
        if (gen.mesh_vertices && gen.mesh_indices && meshTex) {
          const std::string rev = std::to_string(static_cast<std::int64_t>(gen.revision));
          const bool u32 = gen.mesh_index_format == api::RenderIndexFormat::uint32;
          DrawItem& it = cmds.add(wide ? Mat::GENERATOR_MESH_WIDE_MATERIAL : Mat::GENERATOR_MESH_MATERIAL, blend, uniforms(kind));
          it.texture = meshTex;
          it.sampler = ctx.linear_clamp();
          it.vertexBuffer = ctx.dev.geometry("generator:mesh-v:" + r.id + ":" + rev, *gen.mesh_vertices, false);
          it.indexBuffer = ctx.dev.geometry("generator:mesh-i:" + r.id + ":" + rev, *gen.mesh_indices, true);
          it.indexCount = static_cast<std::uint32_t>(gen.mesh_indices->size() / (u32 ? 4 : 2));
          it.indexFormat = u32 ? wgpu::IndexFormat::Uint32 : wgpu::IndexFormat::Uint16;
          it.instanceBuffer = instances;
          it.instanceCount = gen.count;
        }
      } else if (gen.primitive == api::RenderGeneratorPrimitive::sprite && texture && wide) {
        DrawItem& it = cmds.add(Mat::GENERATOR_SPRITE_MATERIAL, blend, uniforms(kind));
        it.texture = texture;
        it.sampler = ctx.linear_clamp();
        it.instanceBuffer = instances;
        it.instanceCount = gen.count;
      } else {
        DrawItem& it = cmds.add(wide ? Mat::GENERATOR_POINT_WIDE_MATERIAL : Mat::GENERATOR_POINT_MATERIAL, blend,
                                uniforms(gen.primitive == api::RenderGeneratorPrimitive::sprite ? 0 : kind));
        it.instanceBuffer = instances;
        it.instanceCount = gen.count;
      }
    }
    if (ctx.target(kGeneratorTarget) == nullptr) return false;
    ctx.draw_into(kGeneratorTarget, cmds, true);
    if (!r.texture_key) return false;
    precompTex_[*r.texture_key] = ctx.target(kGeneratorTarget)->tex();
    prepared = r;
    prepared.generator.reset();
    prepared.kind = api::RenderableKind::image;
    const Mat3 full = model_from_rect(ctx.viewport.visibleWorldRect);
    prepared.model_matrix.assign(full.m.begin(), full.m.end());
    const Rect v = ctx.viewport.visibleWorldRect;
    prepared.bounds = {v.x, v.y, v.width, v.height};
    prepared.uv_rect = api::Rect{0, 0, 1, 1};
    prepared.color = api::Color{1, 1, 1, 1};
    return true;
  }

  void render_list(PassContext& ctx, const std::vector<const api::Renderable*>& list, const std::string& out,
                   std::size_t depth) {
    ListState st;
    st.out = out;
    st.depth = depth;
    for (const api::Renderable* r : list) st.byId.emplace(r->id, r);
    // A contiguous run of depth-eligible 3D renderables → one depth-tested group
    // (renderList). Shadow-mapped light washes are never hoisted here: a frame
    // with a mapped light is refused until shadow maps are ported.
    const bool canDepthGroup = ctx.scope.camera3d != nullptr && ctx.target(out) != nullptr;
    const Rect visible = ctx.viewport.visibleWorldRect;
    // E8: the index past the frame's last depth-eligible renderable (root list only).
    const bool rootList = depth == 0 && ctx.scope.all == &ctx.file.scene.renderables;
    std::size_t lastEligibleEnd = 0;
    if (rootList && ctx.groundGridPending) {
      for (std::size_t k = 0; k < list.size(); ++k) {
        if (depth_eligible_3d(*list[k])) lastEligibleEnd = k + 1;
      }
    }
    std::size_t i = 0;
    while (i < list.size()) {
      if (canDepthGroup && depth_eligible_3d(*list[i])) {
        std::vector<const api::Renderable*> group;
        while (i < list.size() && depth_eligible_3d(*list[i])) {
          const api::Renderable* g = list[i];
          if (rects_intersect(visible, rect_of(g->bounds)) && g->opacity > 0) group.push_back(g);
          ++i;
        }
        if (!group.empty()) {
          flush(ctx, st);
          ctx.groundGridRun = rootList && ctx.groundGridPending && i >= lastEligibleEnd;
          // 3D quads sample their content mipmapped (anisotropic in threed.cpp):
          // a layer at a steep angle no longer drops a thin stroke into dots.
          render_3d_group(ctx, group, out, st.byId, [this, &ctx](const std::optional<std::string>& k) {
            if (k && precompTex_.find(*k) == precompTex_.end()) return ctx.texture_mipmapped(*k);
            return tex_for(ctx, k);
          },
                          *this);
        }
        continue;
      }
      process(ctx, *list[i], st);
      ++i;
    }
    flush(ctx, st);
  }

  void process(PassContext& ctx, const api::Renderable& r0, ListState& st) {
    const Rect visible = ctx.viewport.visibleWorldRect;
    const Rect targetUv{0, 0, 1, 1};  // WebGPU writes targets top-down: identity UV
    if (r0.matte_source) return;

    api::Renderable folded;
    const api::Renderable* rp = &r0;
    if (r0.three_d && r0.three_d->shade && r0.three_d->shade->quad_gain.size() >= 3 && r0.color) {
      folded = r0;
      const auto& g = r0.three_d->shade->quad_gain;
      folded.color = api::Color{r0.color->r * g[0], r0.color->g * g[1], r0.color->b * g[2], r0.color->a};
      rp = &folded;
    }

    api::Renderable prepared;
    if (r0.precomp) {
      if (!rects_intersect(visible, rect_of(r0.bounds)) || r0.opacity <= 0) return;
      if (!prepare_isolated_precomp(ctx, r0, st, st.depth, true, prepared)) return;
      rp = &prepared;
    }
    if (r0.generator) {
      if (r0.opacity <= 0) return;
      flush(ctx, st);
      if (!render_generator_field(ctx, *rp, prepared)) return;
      rp = &prepared;
    }
    const api::Renderable& r = *rp;

    if (r.matte) {
      const auto it = st.byId.find(r.matte->source_id);
      if (it != st.byId.end()) {
        flush(ctx, st);
        const TexRef matted = layer_into_target(ctx, r, r.opacity, kLayerTarget, st);
        const api::Renderable* source = it->second;
        api::Renderable preparedSource;
        if (source->precomp) {
          source = prepare_isolated_precomp(ctx, *source, st, st.depth + 1, false, preparedSource) ? &preparedSource : nullptr;
        }
        const TexRef matte = source != nullptr ? layer_into_target(ctx, *source, 1, kMatteTarget, st) : TexRef{};
        if (matte && matted) {
          ColorTransform mode;
          mode.m = {r.matte->mode == api::RenderMatteMode::luma ? 1.0 : 0.0, r.matte->inverted ? 1.0 : 0.0, 0, 0, 0, 0, 0, 0, 0};
          emit_matte_combine(ctx, st.main, screen_mvp(), blend_of(r.blend), matted, ctx.linear_clamp(), matte, mode, targetUv);
        } else {
          ctx.diagnostics.push_back({"matte-source-unavailable", "Track matte on \"" + r.id + "\" could not be built"});
        }
        return;
      }
      ctx.diagnostics.push_back({"matte-source-unavailable", "Track matte on \"" + r.id + "\" references a missing source"});
    }

    if (r.adjustment) {
      flush(ctx, st);
      RenderTarget* scene = ctx.target(st.out);
      if (scene == nullptr) return;
      const TexRef sceneTex = scene->tex();
      Commands copy;
      const TexRef lut = r.adjustment->lut_texture_key ? ctx.texture(*r.adjustment->lut_texture_key) : TexRef{};
      const ColorTransform ct = color_transform(r.adjustment->color_matrix);
      if (lut) {
        emit_lut_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::normal, sceneTex, ctx.linear_clamp(), lut,
                          targetUv, ct, true);
      } else {
        emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::normal, sceneTex, ctx.linear_clamp(), targetUv, ct,
                      true);
      }
      ctx.draw_into(kLayerTarget, copy, true);
      TexRef finalTex = ctx.target(kLayerTarget)->tex();
      if (!r.effects.empty()) {
        const std::array<std::string_view, 4> pool = {kLayerTarget, kBlur1, kBlur2, kBlur3};
        finalTex = run_effects_chain(ctx, r.effects, finalTex, pool, st.byId, r.id, *this).tex;
      }
      Commands apply;
      emit_textured(ctx, apply, screen_mvp(), Color::white(), 1, Blend::normal, finalTex, ctx.linear_clamp(), targetUv,
                    kIdentityColor, true);
      ctx.draw_into(st.out, apply, true);
      return;
    }

    if (!rects_intersect(visible, rect_of(r.bounds)) || r.opacity <= 0) return;

    if ((r.backdrop_blur && *r.backdrop_blur > 0) || r.glass) {
      flush(ctx, st);
      RenderTarget* scene = ctx.target(st.out);
      if (scene != nullptr) {
        const TexRef sceneTex = scene->tex();
        const Mat3 fullMvp = screen_mvp();
        const TexRef layerTex = layer_into_target(ctx, r, r.opacity, kMatteTarget, st);
        const double blurRadius = r.backdrop_blur.value_or(0);
        const bool half = blurRadius > 0;
        const std::uint32_t bw = half ? std::max(1U, ctx.viewport.pixelWidth / kBackdropDownscale) : ctx.viewport.pixelWidth;
        const std::uint32_t bh = half ? std::max(1U, ctx.viewport.pixelHeight / kBackdropDownscale) : ctx.viewport.pixelHeight;
        const std::string_view t1 = half ? kBackdropHalf1 : kBlur1;
        const std::string_view t2 = half ? kBackdropHalf2 : kBlur2;
        Commands copy;
        emit_textured(ctx, copy, fullMvp, Color::white(), 1, Blend::normal, sceneTex, ctx.linear_clamp(), targetUv,
                      kIdentityColor, true);
        if (half) ctx.draw_into_sized(t1, copy, true, bw, bh);
        else ctx.draw_into(t1, copy, true);
        TexRef blurred = ctx.target(t1)->tex();
        if (blurRadius > 0) {
          const double scale = half ? kBackdropDownscale : 1;
          Commands h;
          DrawItem& hi = h.add(Mat::BLUR_MATERIAL, Blend::normal,
                               pack_blur(ctx.packer(), fullMvp, targetUv, 1.0 / bw, 0, blurRadius / scale));
          hi.texture = blurred;
          hi.sampler = ctx.linear_clamp();
          ctx.draw_into_sized(t2, h, true, bw, bh);
          Commands v;
          DrawItem& vi = v.add(Mat::BLUR_MATERIAL, Blend::normal,
                               pack_blur(ctx.packer(), fullMvp, targetUv, 0, 1.0 / bh, blurRadius / scale));
          vi.texture = ctx.target(t2)->tex();
          vi.sampler = ctx.linear_clamp();
          ctx.draw_into_sized(t1, v, true, bw, bh);
          blurred = ctx.target(t1)->tex();
        }
        if (blurred && layerTex) {
          if (r.glass) {
            const auto& g = *r.glass;
            Packer p = ctx.packer();
            p.mat3(fullMvp).rect(targetUv);
            p.vec4(g.refraction, g.edge_width, g.aberration, g.saturation);
            p.vec4(g.tint.r, g.tint.g, g.tint.b, g.tint.a * g.tint_opacity);
            p.vec4(g.rim.r, g.rim.g, g.rim.b, g.rim.a * g.rim_opacity);
            p.vec4(g.rim_width, g.rim_angle, g.specular_intensity, g.specular_falloff);
            p.vec4(g.specular_angle, g.grain, 1.0 / ctx.viewport.pixelWidth, 1.0 / ctx.viewport.pixelHeight);
            DrawItem& it = st.main.add(Mat::GLASS_MATERIAL, Blend::normal, p.span());
            it.texture = std::move(blurred);
            it.sampler = ctx.linear_clamp();
            it.mask = layerTex;
          } else {
            emit_masked_textured(ctx, st.main, fullMvp, Color::white(), 1, Blend::normal, blurred, ctx.linear_clamp(),
                                 layerTex, targetUv, kIdentityColor, true);
            emit_textured(ctx, st.main, fullMvp, Color::white(), 1, blend_of(r.blend), layerTex, ctx.linear_clamp(), targetUv,
                          kIdentityColor, true);
          }
        }
        return;
      }
    }

    if ((r.advanced_blend && *r.advanced_blend > 0) || r.preserve_transparency) {
      flush(ctx, st);
      RenderTarget* scene = ctx.target(st.out);
      if (scene != nullptr) {
        const TexRef sceneTex = scene->tex();
        const TexRef layerTex = layer_into_target(ctx, r, r.opacity, kLayerTarget, st);
        Commands copy;
        emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::normal, sceneTex, ctx.linear_clamp(), targetUv,
                      kIdentityColor, true);
        ctx.draw_into(kMatteTarget, copy, true);
        const TexRef backdrop = ctx.target(kMatteTarget)->tex();
        if (backdrop && layerTex) {
          const double ab = r.advanced_blend.value_or(0);
          ColorTransform mode;
          mode.m = {ab,
                    r.preserve_transparency ? 1.0 : 0.0,
                    ab == 36 ? ctx.file.scene.dissolve_frame.value_or(0) : 0.0,
                    ctx.file.scene.width,
                    ctx.file.scene.height,
                    0,
                    0,
                    0,
                    0};
          Commands combine;
          emit_blend_combine(ctx, combine, screen_mvp(), Blend::none, layerTex, ctx.linear_clamp(), backdrop, mode, targetUv);
          ctx.draw_into(st.out, combine, false);
        }
        return;
      }
    }

    const bool hasEffects = !r.effects.empty();
    const bool hasMotion = r.motion_samples.size() > 1;
    const bool solid = is_solid_kind(r.kind);
    const bool textured = is_textured_kind(r.kind);

    if (!hasEffects && !hasMotion) {
      const Mat3 mvp = mvp_for(ctx.viewport, mat3_of(r.model_matrix));
      if (r.mask_texture_key) {
        const TexRef mask = ctx.texture(*r.mask_texture_key);
        if (mask) {
          TexRef tex = textured && r.texture_key ? tex_for(ctx, r.texture_key) : TexRef{};
          if (solid && !tex) tex = ctx.texture("texture:white");
          if (tex) {
            emit_masked_textured(ctx, st.main, mvp, color_or_white(r), r.opacity, blend_of(r.blend), tex, ctx.linear_clamp(),
                                 mask, uv_or_full(r), color_transform(r.color_matrix), tex.sampleLinear);
          }
        }
      } else if (solid && r.color) {
        emit_solid(ctx, st.main, mvp, color_of(*r.color), r.opacity, blend_of(r.blend), to_solid_shape(r.sdf));
      } else if (textured && r.texture_key) {
        const TexRef tex = tex_for(ctx, r.texture_key);
        if (tex) {
          const Rect uv = uv_or_full(r);
          const TexRef lut = r.lut_texture_key ? ctx.texture(*r.lut_texture_key) : TexRef{};
          if (lut) {
            emit_lut_textured(ctx, st.main, mvp, color_or_white(r), r.opacity, blend_of(r.blend), tex, ctx.linear_clamp(), lut,
                              uv, color_transform(r.color_matrix), tex.sampleLinear);
          } else {
            emit_layer_texture(ctx, st.main, r, tex, ctx.linear_clamp(), uv, r.opacity, nullptr, nullptr, tex.sampleLinear);
          }
        }
      }
      return;
    }

    flush(ctx, st);
    // P8: a layer whose chain input and parameters match a kept result is a copy of it.
    // P8b: the input is drawn at a whole pixel and keyed without its place, so a
    // layer that only moves reuses its chain — the result composited where the
    // layer is (the fraction by a bilinear shift).
    const PixelSnap snap = hasEffects && layerFxEnabled_ ? pixel_snap(ctx, r) : PixelSnap{};
    // The layer's draw and its chain see the view moved to its buffer placement (restored at scope end).
    const ViewShift shiftView(ctx, snap.on ? snap.bx - snap.px : 0, snap.on ? snap.by - snap.py : 0);
    const std::uint64_t contentKey = hasEffects ? chain_content_key(ctx, r, 1, snap.on) : 0;
    const std::uint64_t fxKey = hasEffects && layerFxEnabled_ ? layer_fx_key(ctx, r, contentKey, 1) : 0;
    const double vw = ctx.viewport.pixelWidth;
    const double vh = ctx.viewport.pixelHeight;
    const auto composite = [&](const TexRef& tex, const std::optional<PxBox>& covered, double dx, double dy) {
      const Blend blend = blend_of(r.blend);
      const Mat3 mvp = dx == 0 && dy == 0 ? screen_mvp() : mul(translation(2 * dx / vw, -2 * dy / vh), screen_mvp());
      emit_textured(ctx, st.main, mvp, Color::white(), r.opacity, blend, tex, ctx.linear_clamp(), targetUv, kIdentityColor, true);
      const std::optional<PxBox> at = shifted(covered, dx, dy);
      if (at && transparent_is_noop(blend)) st.main.last().scissor = scissor_of(*at, ctx.viewport.pixelWidth, ctx.viewport.pixelHeight);
    };
    if (snap.on) {
      if (const std::optional<KeptFx> kept = reuse_layer_fx_moved(ctx, fxKey, snap)) {
        composite(kept->tex, kept->covered, kept->dx, kept->dy);
        return;
      }
    } else if (const std::optional<ChainResult> kept = reuse_layer_fx(ctx, fxKey, {})) {
      composite(kept->tex, kept->covered, 0, 0);
      return;
    }
    Commands layerCmds;
    if (hasMotion) {
      const auto n = static_cast<double>(r.motion_samples.size());
      const Blend add = Blend::add;
      for (const auto& s : r.motion_samples) {
        const Mat3 m = mat3_of(s.model_matrix);
        renderable_cmds(ctx, r, s.opacity / n, layerCmds, &m, &add);
      }
    } else {
      renderable_cmds(ctx, r, 1, layerCmds);
    }
    if (layerCmds.empty()) return;
    ctx.draw_into(kLayerTarget, layerCmds, true);
    const TexRef layerTex = ctx.target(kLayerTarget)->tex();
    if (!hasEffects) {
      emit_textured(ctx, st.main, screen_mvp(), Color::white(), 1, blend_of(r.blend), layerTex, ctx.linear_clamp(), targetUv,
                    kIdentityColor, true);
      return;
    }
    const std::array<std::string_view, 4> pool = {kLayerTarget, kBlur1, kBlur2, kBlur3};
    const ChainResult res = run_effects_chain(ctx, r.effects, layerTex, pool, st.byId, r.id, *this, nullptr, contentKey,
                                              drawn_box(ctx, r));
    keep_layer_fx(ctx, r.id, fxKey, res.tex, res.name, res.covered, &snap);
    // Outside the chain's reach its result is transparent: the composite covers the reach, not the frame.
    composite(res.tex, res.covered, snap.on ? snap.px - snap.bx : 0, snap.on ? snap.py - snap.by : 0);
  }

};

}  // namespace

std::unique_ptr<RenderPass> make_composition_pass() { return std::make_unique<CompositionPass>(); }

}  // namespace premation::rg
