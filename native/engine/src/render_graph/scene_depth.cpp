// Plugin SDK 1.2 (S6): the scene depth pass (scene_depth.hpp).
#include "scene_depth.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <span>
#include <string>

#include "threed.hpp"

namespace premation::rg {
namespace {

/// One draw's uniforms (the WGSL `Obj` below): 13 vec4s; one 256-byte slot per draw
/// (WebGPU's minUniformBufferOffsetAlignment).
constexpr std::size_t kObjFloats = 16 + 16 + 4 + 4 + 4 + 4 + 4;
constexpr std::uint64_t kSlotBytes = 256;
static_assert(kObjFloats * sizeof(float) <= kSlotBytes);
/// frag_depth = z / (z + K): monotonic in z over [0, ∞), so the depth test keeps the nearest
/// surface; the colour carries z itself. K ~ a comp's size keeps the test's precision where
/// layers usually are.
constexpr double kDepthKnee = 1000;
/// The engine's 3D depth discard (textured3d.wgsl / solid3d.wgsl): a texel under 1/255 writes none.
constexpr const char* kWgsl = R"(
struct Obj {
  mvp : mat4x4<f32>,
  model : mat4x4<f32>,
  viewZ : vec4<f32>,
  uvRect : vec4<f32>,
  shape : vec4<f32>,
  alpha : vec4<f32>,
  bits : vec4<u32>,
};
@group(0) @binding(0) var<uniform> obj : Obj;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var maskTex : texture_2d<f32>;
@group(0) @binding(3) var smp : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) local : vec2<f32>,
};

// z inside every clip volume while w > 0: the depth test runs on frag_depth, and a point
// behind the eye (w <= 0) is still clipped.
fn place(p : vec4<f32>) -> vec4<f32> {
  let c = obj.mvp * p;
  return vec4<f32>(c.xy, 0.5 * c.w, c.w);
}

@vertex
fn vs_quad(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = vec4<f32>(pos, 0.0, 1.0);
  o.pos = place(p);
  o.world = (obj.model * p).xyz;
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  o.local = pos;
  return o;
}

@vertex
fn vs_mesh(@location(0) pos : vec3<f32>) -> VOut {
  var o : VOut;
  let p = vec4<f32>(pos, 1.0);
  o.pos = place(p);
  o.world = (obj.model * p).xyz;
  o.uv = vec2<f32>(0.5);
  o.local = vec2<f32>(0.5);
  return o;
}

@vertex
fn vs_clear(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(xy * 2.0 - 1.0, 0.5, 1.0);
}

@fragment
fn fs_clear() -> @location(0) vec4<f32> {
  return vec4<f32>(bitcast<f32>(obj.bits.x), 0.0, 0.0, 1.0);
}

fn inside(local : vec2<f32>) -> bool {
  let kind = i32(obj.shape.x + 0.5);
  if (kind == 2) {
    let p = (local - vec2<f32>(0.5)) * 2.0;
    return length(p) <= 1.0;
  }
  if (kind == 1) {
    let r = obj.shape.y;
    let sz = obj.shape.zw;
    let p = (local - vec2<f32>(0.5)) * sz;
    let b = sz * 0.5 - r;
    let q = abs(p) - b;
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r <= 0.0;
  }
  return true;
}

struct FOut {
  @location(0) color : vec4<f32>,
  @builtin(frag_depth) depth : f32,
};

@fragment
fn fs(i : VOut) -> FOut {
  let t = textureSample(tex, smp, i.uv).a;
  let m = textureSample(maskTex, smp, i.uv).a;
  var a = obj.alpha.x;
  if (obj.alpha.y > 0.5) { a = a * t; }
  if (obj.alpha.z > 0.5) { a = a * m; }
  if (!inside(i.local)) { a = 0.0; }
  let z = dot(obj.viewZ.xyz, i.world) + obj.viewZ.w;
  if (a < 0.00392156862745098 || z <= 0.0) { discard; }
  var o : FOut;
  o.color = vec4<f32>(z, 0.0, 0.0, 1.0);
  o.depth = z / (z + obj.alpha.w);
  return o;
}
)";

using M4 = std::array<double, 16>;  // column-major

M4 m4_of(const std::vector<double>& v) {
  M4 m{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  if (v.size() == 16) std::copy(v.begin(), v.end(), m.begin());
  return m;
}

M4 mul(const M4& a, const M4& b) {
  M4 o{};
  for (std::size_t c = 0; c < 4; ++c) {
    for (std::size_t r = 0; r < 4; ++r) {
      double s = 0;
      for (std::size_t k = 0; k < 4; ++k) s += a.at(k * 4 + r) * b.at(c * 4 + k);
      o.at(c * 4 + r) = s;
    }
  }
  return o;
}

/// comp px (homogeneous x, y, w after the camera's projection) → the world's clip x, y:
/// NDC · compToWorld, lifted to act on x / y / w (z kept).
M4 comp_to_clip(const SceneDepth::Request& q) {
  const std::array<double, 9>& c = q.compToWorld;  // row-major
  const double sx = 2.0 / std::max(1U, q.width);
  const double sy = -2.0 / std::max(1U, q.height);
  // Rows of the 2D map: x' = sx·(c0 x + c1 y + c2 w) − w, y' = sy·(c3 x + c4 y + c5 w) + w.
  const double r00 = sx * c[0], r01 = sx * c[1], r02 = sx * c[2] - 1;
  const double r10 = sy * c[3], r11 = sy * c[4], r12 = sy * c[5] + 1;
  return {r00, r10, 0, 0, r01, r11, 0, 0, 0, 0, 1, 0, r02, r12, 0, 1};
}

void put(std::span<float> out, std::size_t at, const M4& m) {
  for (std::size_t i = 0; i < 16; ++i) out[at + i] = static_cast<float>(m.at(i));
}

void put4(std::span<float> out, std::size_t at, double a, double b, double c, double d) {
  out[at] = static_cast<float>(a);
  out[at + 1] = static_cast<float>(b);
  out[at + 2] = static_cast<float>(c);
  out[at + 3] = static_cast<float>(d);
}

}  // namespace

/// Pipelines, the layout, a white 1×1 texture and a sampler — per device.
struct SceneDepth::Gpu {
  wgpu::Device device;
  wgpu::BindGroupLayout layout;
  wgpu::RenderPipeline quad;
  wgpu::RenderPipeline mesh;
  wgpu::RenderPipeline clear;
  wgpu::Sampler sampler;
  wgpu::Texture white;
  wgpu::TextureView whiteView;
  wgpu::Buffer uniforms;
  std::uint64_t uniformBytes = 0;

  explicit Gpu(Device& dev) : device(dev.device()) {
    wgpu::ShaderSourceWGSL src{};
    src.code = kWgsl;
    wgpu::ShaderModuleDescriptor md{};
    md.nextInChain = &src;
    md.label = "plugin-scene-depth";
    const wgpu::ShaderModule module = device.CreateShaderModule(&md);

    std::array<wgpu::BindGroupLayoutEntry, 4> e{};
    e[0].binding = 0;
    e[0].visibility = wgpu::ShaderStage::Vertex | wgpu::ShaderStage::Fragment;
    e[0].buffer.type = wgpu::BufferBindingType::Uniform;
    e[0].buffer.hasDynamicOffset = true;
    e[0].buffer.minBindingSize = kObjFloats * sizeof(float);
    for (std::uint32_t b = 1; b <= 2; ++b) {
      e.at(b).binding = b;
      e.at(b).visibility = wgpu::ShaderStage::Fragment;
      e.at(b).texture.sampleType = wgpu::TextureSampleType::Float;
      e.at(b).texture.viewDimension = wgpu::TextureViewDimension::e2D;
    }
    e[3].binding = 3;
    e[3].visibility = wgpu::ShaderStage::Fragment;
    e[3].sampler.type = wgpu::SamplerBindingType::Filtering;
    wgpu::BindGroupLayoutDescriptor bld{};
    bld.entryCount = e.size();
    bld.entries = e.data();
    layout = device.CreateBindGroupLayout(&bld);
    wgpu::PipelineLayoutDescriptor pld{};
    pld.bindGroupLayoutCount = 1;
    pld.bindGroupLayouts = &layout;
    const wgpu::PipelineLayout pl = device.CreatePipelineLayout(&pld);

    const auto make = [&](const char* vs, const char* fs, const wgpu::VertexBufferLayout* vbl, bool test) {
      wgpu::ColorTargetState target{};
      target.format = wgpu::TextureFormat::R32Float;
      wgpu::FragmentState frag{};
      frag.module = module;
      frag.entryPoint = fs;
      frag.targetCount = 1;
      frag.targets = &target;
      wgpu::DepthStencilState ds{};
      ds.format = wgpu::TextureFormat::Depth32Float;
      ds.depthWriteEnabled = test ? wgpu::OptionalBool::True : wgpu::OptionalBool::False;
      ds.depthCompare = test ? wgpu::CompareFunction::Less : wgpu::CompareFunction::Always;
      wgpu::RenderPipelineDescriptor pd{};
      pd.label = "plugin-scene-depth";
      pd.layout = pl;
      pd.vertex.module = module;
      pd.vertex.entryPoint = vs;
      pd.vertex.bufferCount = vbl != nullptr ? 1 : 0;
      pd.vertex.buffers = vbl;
      pd.primitive.topology = wgpu::PrimitiveTopology::TriangleList;
      pd.primitive.cullMode = wgpu::CullMode::None;
      pd.depthStencil = &ds;
      pd.fragment = &frag;
      return device.CreateRenderPipeline(&pd);
    };
    wgpu::VertexAttribute qa{};
    qa.format = wgpu::VertexFormat::Float32x2;
    qa.shaderLocation = 0;
    wgpu::VertexBufferLayout qv{};
    qv.arrayStride = 8;  // Device::quad(): the unit quad, two floats per vertex
    qv.attributeCount = 1;
    qv.attributes = &qa;
    wgpu::VertexAttribute ma{};
    ma.format = wgpu::VertexFormat::Float32x3;
    ma.shaderLocation = 0;
    wgpu::VertexBufferLayout mv{};
    mv.arrayStride = 32;  // extruded / model meshes: position, normal, uv (shadow-depth-mesh's layout)
    mv.attributeCount = 1;
    mv.attributes = &ma;
    quad = make("vs_quad", "fs", &qv, true);
    mesh = make("vs_mesh", "fs", &mv, true);
    clear = make("vs_clear", "fs_clear", nullptr, false);

    wgpu::SamplerDescriptor sd{};
    sd.magFilter = wgpu::FilterMode::Linear;
    sd.minFilter = wgpu::FilterMode::Linear;
    sd.addressModeU = wgpu::AddressMode::ClampToEdge;
    sd.addressModeV = wgpu::AddressMode::ClampToEdge;
    sampler = device.CreateSampler(&sd);

    wgpu::TextureDescriptor td{};
    td.size = {1, 1, 1};
    td.format = wgpu::TextureFormat::RGBA8Unorm;
    td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst;
    td.label = "plugin-scene-depth-white";
    white = device.CreateTexture(&td);
    whiteView = white.CreateView();
    const std::array<std::uint8_t, 4> px{255, 255, 255, 255};
    wgpu::TexelCopyTextureInfo dst{};
    dst.texture = white;
    wgpu::TexelCopyBufferLayout bl{};
    bl.bytesPerRow = 4;
    bl.rowsPerImage = 1;
    const wgpu::Extent3D one{1, 1, 1};
    dev.queue().WriteTexture(&dst, px.data(), px.size(), &bl, &one);
  }
};

/// One depth of this frame (or a stale one whose textures the next request of its size reuses).
struct SceneDepth::Entry {
  std::uint64_t frame = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::array<double, 9> compToWorld{};
  std::vector<const api::Renderable*> drawn;
  const api::RenderCamera3D* camera = nullptr;
  Result result;
  wgpu::Texture depth;
  wgpu::TextureView depthView;
  std::vector<float> cpu;
  bool cpuRead = false;
};

SceneDepth::SceneDepth() = default;
SceneDepth::~SceneDepth() = default;

SceneDepth::Entry* SceneDepth::entry_for(PassContext& ctx, const Request& req) {
  Device& dev = ctx.dev;
  if (req.width == 0 || req.height == 0) return nullptr;
  const std::uint32_t most = dev.max_texture_dimension();
  if (req.width > most || req.height > most) return nullptr;
  if (!gpu_ || gpu_->device.Get() != dev.device().Get()) {
    gpu_ = std::make_unique<Gpu>(dev);
    entries_.clear();
  }

  // The 3D layers of the scope the effect renders in (the comp's, or a sealed precomp's own).
  const api::RenderCamera3D* cam = ctx.scope.camera3d != nullptr ? ctx.scope.camera3d
                                   : ctx.file.scene.camera3d     ? &*ctx.file.scene.camera3d
                                                                 : nullptr;
  const std::vector<api::Renderable>* all = ctx.scope.all != nullptr ? ctx.scope.all : &ctx.file.scene.renderables;
  std::vector<const api::Renderable*> drawn;
  if (cam != nullptr && cam->view.size() == 16 && cam->projection.size() == 16) {
    for (const api::Renderable& r : *all) {
      if (r.id == req.selfId || r.matte_source || r.light_wash || !(r.opacity > 0)) continue;
      if (!depth_eligible_3d(r) || r.three_d->model.size() != 16) continue;
      drawn.push_back(&r);
    }
  }

  const std::uint64_t frame = dev.frame();
  if (frame != frame_) {
    frame_ = frame;
    for (auto& e : entries_) e->frame = ~std::uint64_t{0};  // stale: textures kept for reuse
  }
  for (auto& e : entries_) {
    if (e->frame == frame && e->width == req.width && e->height == req.height && e->compToWorld == req.compToWorld &&
        e->drawn == drawn && e->camera == cam) {
      return e.get();
    }
  }
  // A stale entry of this size (its textures), else a new one; at most 8 kept.
  Entry* e = nullptr;
  for (auto& s : entries_) {
    if (s->frame != frame && s->width == req.width && s->height == req.height) {
      e = s.get();
      break;
    }
  }
  if (e == nullptr) {
    if (entries_.size() >= 8) {
      std::erase_if(entries_, [frame](const std::unique_ptr<Entry>& s) { return s->frame != frame; });
    }
    entries_.push_back(std::make_unique<Entry>());
    e = entries_.back().get();
    e->width = req.width;
    e->height = req.height;
    wgpu::TextureDescriptor td{};
    td.size = {req.width, req.height, 1};
    td.format = wgpu::TextureFormat::R32Float;
    td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopySrc;
    td.label = "plugin-scene-depth";
    e->result.texture = dev.device().CreateTexture(&td);
    e->result.view = e->result.texture.CreateView();
    e->result.width = req.width;
    e->result.height = req.height;
    wgpu::TextureDescriptor dd{};
    dd.size = {req.width, req.height, 1};
    dd.format = wgpu::TextureFormat::Depth32Float;
    dd.usage = wgpu::TextureUsage::RenderAttachment;
    dd.label = "plugin-scene-depth-z";
    e->depth = dev.device().CreateTexture(&dd);
    e->depthView = e->depth.CreateView();
  }
  e->frame = frame;
  e->compToWorld = req.compToWorld;
  e->drawn = std::move(drawn);
  e->camera = cam;
  e->cpu.clear();
  e->cpuRead = false;
  e->result.layers = static_cast<std::uint32_t>(e->drawn.size());

  // ── the uniforms: slot 0 = the +inf clear, then one per draw ──
  struct Draw {
    const api::Renderable* r = nullptr;
    wgpu::TextureView tex;
    wgpu::TextureView mask;
    std::uint32_t slot = 0;
  };
  std::vector<Draw> draws;
  draws.reserve(e->drawn.size());
  std::vector<float> floats(kSlotBytes / sizeof(float), 0.0F);
  {
    constexpr std::uint32_t kInfBits = 0x7f800000U;
    float inf = 0;
    std::memcpy(&inf, &kInfBits, sizeof(inf));
    floats[kObjFloats - 4] = inf;  // bits.x (a u32 in the shader; written through its float bit pattern)
  }
  if (cam != nullptr) {
    const M4 view = m4_of(cam->view);
    const M4 pv = mul(comp_to_clip(req), mul(m4_of(cam->projection), view));
    for (const api::Renderable* r : e->drawn) {
      Draw d;
      d.r = r;
      bool textured = false;
      bool masked = false;
      if (!r->extruded_mesh && r->texture_key) {
        const TexRef t = ctx.texture(*r->texture_key);
        if (!t) continue;  // the 3D pass skips a quad whose texture is not there: so does its depth
        d.tex = t.view;
        textured = true;
      }
      if (!r->extruded_mesh && r->mask_texture_key) {
        if (const TexRef m = ctx.texture(*r->mask_texture_key)) {
          d.mask = m.view;
          masked = true;
        }
      }
      const M4 model = m4_of(r->three_d->model);
      const std::size_t at = floats.size();
      floats.resize(at + kSlotBytes / sizeof(float), 0.0F);
      const std::span<float> u(floats);
      put(u, at, mul(pv, model));
      put(u, at + 16, model);
      put4(u, at + 32, view[2], view[6], view[10], view[14]);  // the view matrix's z row
      const api::Rect uv = r->uv_rect ? *r->uv_rect : api::Rect{0, 0, 1, 1};
      put4(u, at + 36, uv.x, uv.y, uv.width, uv.height);
      double kind = 0, radius = 0, sw = 0, sh = 0;
      if (!r->extruded_mesh && !r->texture_key && r->sdf) {
        kind = r->sdf->shape == api::RenderSdfShape::ellipse ? 2 : 1;
        sw = r->sdf->width;
        sh = r->sdf->height;
        radius = kind == 1 ? std::max(0.0, std::min(r->sdf->radius_px, std::min(sw, sh) / 2)) : 0;
      }
      put4(u, at + 40, kind, radius, sw, sh);
      const double alpha = std::max(0.0, r->opacity) * (r->color ? r->color->a : 1.0);
      put4(u, at + 44, alpha, textured ? 1 : 0, masked ? 1 : 0, kDepthKnee);
      d.slot = static_cast<std::uint32_t>(at * sizeof(float) / kSlotBytes);
      draws.push_back(std::move(d));
    }
  }
  const std::uint64_t bytes = floats.size() * sizeof(float);
  if (gpu_->uniformBytes < bytes) {
    wgpu::BufferDescriptor bd{};
    bd.size = std::max<std::uint64_t>(bytes, kSlotBytes * 16);
    bd.usage = wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst;
    bd.label = "plugin-scene-depth-uniforms";
    gpu_->uniforms = dev.device().CreateBuffer(&bd);
    gpu_->uniformBytes = bd.size;
  }
  // Queue-ordered: written, then the pass below is submitted, before any later request writes again.
  dev.queue().WriteBuffer(gpu_->uniforms, 0, floats.data(), bytes);

  const auto bind = [&](const wgpu::TextureView& tex, const wgpu::TextureView& mask) {
    std::array<wgpu::BindGroupEntry, 4> be{};
    be[0].binding = 0;
    be[0].buffer = gpu_->uniforms;
    be[0].size = kObjFloats * sizeof(float);
    be[1].binding = 1;
    be[1].textureView = tex != nullptr ? tex : gpu_->whiteView;
    be[2].binding = 2;
    be[2].textureView = mask != nullptr ? mask : gpu_->whiteView;
    be[3].binding = 3;
    be[3].sampler = gpu_->sampler;
    wgpu::BindGroupDescriptor bgd{};
    bgd.layout = gpu_->layout;
    bgd.entryCount = be.size();
    bgd.entries = be.data();
    // Per draw, per pass: only effects that ask for scene depth pay (once a frame).
    return dev.device().CreateBindGroup(&bgd);
  };

  wgpu::RenderPassColorAttachment ca{};
  ca.view = e->result.view;
  ca.loadOp = wgpu::LoadOp::Clear;
  ca.storeOp = wgpu::StoreOp::Store;
  ca.clearValue = {0, 0, 0, 1};
  wgpu::RenderPassDepthStencilAttachment da{};
  da.view = e->depthView;
  da.depthClearValue = 1.0F;
  da.depthLoadOp = wgpu::LoadOp::Clear;
  da.depthStoreOp = wgpu::StoreOp::Discard;
  wgpu::RenderPassDescriptor rp{};
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &ca;
  rp.depthStencilAttachment = &da;
  wgpu::CommandEncoder enc = dev.device().CreateCommandEncoder();
  {
    wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rp);
    const wgpu::BindGroup clearGroup = bind(nullptr, nullptr);
    const std::uint32_t zero = 0;
    pass.SetPipeline(gpu_->clear);
    pass.SetBindGroup(0, clearGroup, 1, &zero);
    pass.Draw(3);
    for (const Draw& d : draws) {
      const wgpu::BindGroup g = bind(d.tex, d.mask);
      const std::uint32_t offset = d.slot * static_cast<std::uint32_t>(kSlotBytes);
      if (d.r->extruded_mesh) {
        const api::RenderExtrudedMesh& mesh = *d.r->extruded_mesh;
        // The 3D group's own cached buffers (threed.cpp's keys): uploaded once per geometry.
        const wgpu::Buffer vb = dev.geometry("geometry:ext-vertex:" + mesh.key, mesh.vertices, false);
        const wgpu::Buffer ib = dev.geometry("geometry:ext-index:" + mesh.key, mesh.indices, true);
        pass.SetPipeline(gpu_->mesh);
        pass.SetBindGroup(0, g, 1, &offset);
        pass.SetVertexBuffer(0, vb);
        pass.SetIndexBuffer(ib, mesh.index_format == api::RenderIndexFormat::uint32 ? wgpu::IndexFormat::Uint32 : wgpu::IndexFormat::Uint16);
        for (const api::RenderMeshRange& range : mesh.ranges) {
          if (range.count > 0) pass.DrawIndexed(range.count, 1, range.first);
        }
        continue;
      }
      pass.SetPipeline(gpu_->quad);
      pass.SetBindGroup(0, g, 1, &offset);
      pass.SetVertexBuffer(0, dev.quad());
      pass.Draw(6);
    }
    pass.End();
  }
  const wgpu::CommandBuffer cb = enc.Finish();
  dev.queue().Submit(1, &cb);
  ++passes_;
  return e;
}

const SceneDepth::Result* SceneDepth::render(PassContext& ctx, const Request& req) {
  Entry* e = entry_for(ctx, req);
  return e != nullptr ? &e->result : nullptr;
}

const std::vector<float>* SceneDepth::read_back(PassContext& ctx, const Request& req) {
  Entry* e = entry_for(ctx, req);
  if (e == nullptr) return nullptr;
  if (e->cpuRead) return &e->cpu;
  Device& dev = ctx.dev;
  const std::uint32_t w = e->width;
  const std::uint32_t h = e->height;
  const std::uint32_t rowBytes = w * 4;
  const std::uint32_t bytesPerRow = (rowBytes + 255) / 256 * 256;
  wgpu::BufferDescriptor bd{};
  bd.size = std::uint64_t{bytesPerRow} * h;
  bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
  bd.label = "plugin-scene-depth-readback";
  const wgpu::Buffer staging = dev.device().CreateBuffer(&bd);
  wgpu::CommandEncoder enc = dev.device().CreateCommandEncoder();
  wgpu::TexelCopyTextureInfo src{};
  src.texture = e->result.texture;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = staging;
  dst.layout.bytesPerRow = bytesPerRow;
  dst.layout.rowsPerImage = h;
  const wgpu::Extent3D size{w, h, 1};
  enc.CopyTextureToBuffer(&src, &dst, &size);
  const wgpu::CommandBuffer cb = enc.Finish();
  dev.queue().Submit(1, &cb);
  bool mapped = false;
  dev.instance().WaitAny(staging.MapAsync(wgpu::MapMode::Read, 0, staging.GetSize(), wgpu::CallbackMode::WaitAnyOnly,
                                          [&mapped](wgpu::MapAsyncStatus s, wgpu::StringView) { mapped = s == wgpu::MapAsyncStatus::Success; }),
                         UINT64_MAX);
  if (!mapped) return nullptr;
  const auto* bytes = static_cast<const std::uint8_t*>(staging.GetConstMappedRange(0, staging.GetSize()));
  const std::span<const std::uint8_t> all(bytes, staging.GetSize());
  e->cpu.assign(std::size_t{w} * h, std::numeric_limits<float>::infinity());
  for (std::uint32_t y = 0; y < h; ++y) {
    std::memcpy(e->cpu.data() + std::size_t{y} * w, all.subspan(std::size_t{y} * bytesPerRow, rowBytes).data(), rowBytes);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  staging.Unmap();
  e->cpuRead = true;
  return &e->cpu;
}

}  // namespace premation::rg
