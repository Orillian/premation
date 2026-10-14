#include "mesh_displacement.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <map>
#include <mutex>

#include "image_decode.hpp"
#include "native_effects.hpp"
#include "raster/canvas.hpp"
#include "scene.hpp"
#include "scene_textures.hpp"

namespace premation::scene {
namespace {

constexpr std::uint32_t kFieldSamples = 256;  // FIELD_SAMPLES

struct FieldCache {
  std::mutex mu;
  /// key + file stamp → the field (null = the decode failed: not retried, as the TS `failed` set).
  std::map<std::string, std::shared_ptr<const HeightField>, std::less<>> fields;
  std::map<std::string, std::string, std::less<>> failed;
};

FieldCache& cache() {
  static FieldCache c;  // process-wide, like heightDisplacement.ts's module cache
  return c;
}

/// heightDisplacement.ts decode(): drawImage into a ≤256² canvas, getImageData, luma.
std::shared_ptr<const HeightField> field_of(const DecodedImage& img) {
  const std::uint32_t w = std::max(1U, std::min(kFieldSamples, img.width));
  const std::uint32_t h = std::max(1U, std::min(kFieldSamples, img.height));
  const raster::CanvasOptions opts;
  const auto src = raster::Canvas2D::make(img.width, img.height, opts);
  if (!src) return nullptr;
  src->putImageData(img.rgba, img.width, img.height, 0, 0);
  std::vector<std::uint8_t> px;
  if (w == img.width && h == img.height) {
    px = src->getImageData(0, 0, w, h);
  } else {
    const auto dst = raster::Canvas2D::make(w, h, opts);
    if (!dst) return nullptr;
    dst->set_will_read_frequently(true);  // `getContext('2d', { willReadFrequently: true })`
    dst->drawImage(*src, 0, 0, img.width, img.height, 0, 0, w, h);
    px = dst->getImageData(0, 0, w, h);
  }
  auto f = std::make_shared<HeightField>();
  f->width = w;
  f->height = h;
  f->data.resize(std::size_t{w} * h);
  for (std::size_t i = 0; i < f->data.size(); ++i) {
    // Rec.709 luma of the straight bytes; transparent pixels read as flat.
    const double a = px[i * 4 + 3] / 255.0;
    f->data[i] = static_cast<float>(((0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255) * a + 0.5 * (1 - a));
  }
  return f;
}

}  // namespace

std::shared_ptr<const HeightField> height_field_for(std::string_view key, std::string_view src, std::string& why) {
  if (src.empty()) {
    why = "height map has no source";
    return nullptr;
  }
  DecodedImage img;
  std::string error;
  std::string cacheKey(key);
  bool decoded = false;
  if (src.starts_with("data:")) {
    const auto comma = src.find(',');
    const std::string_view head = src.substr(0, comma == std::string_view::npos ? 0 : comma);
    if (comma == std::string_view::npos || head.find(";base64") == std::string_view::npos) {
      why = "height map data: URL is not base64";
      return nullptr;
    }
    {
      const std::scoped_lock lock(cache().mu);
      if (const auto it = cache().fields.find(cacheKey); it != cache().fields.end()) return it->second;
    }
    const auto bytes = doc::native_unbase64(src.substr(comma + 1));
    if (!bytes) {
      why = "height map data: URL does not decode";
      return nullptr;
    }
    decoded = decode_image_bytes(*bytes, img, error);
  } else if (src.starts_with("blob:") || src.starts_with("prime:") || src.starts_with("http:") || src.starts_with("https:")) {
    why = "height map source is not in the document (" + std::string(src.substr(0, src.find(':') + 1)) + " — a session / in-memory field)";
    return nullptr;
  } else {
    const std::filesystem::path p = file_url_path(src);
    if (p.is_relative()) {
      why = "height map is a relative path (no project folder to resolve it against)";
      return nullptr;
    }
    const FileStamp st = file_stamp(p);
    cacheKey += '|' + p.lexically_normal().string() + '|' + std::to_string(st.size) + '|' + std::to_string(st.modified);
    {
      const std::scoped_lock lock(cache().mu);
      if (const auto it = cache().fields.find(cacheKey); it != cache().fields.end()) return it->second;
      if (const auto it = cache().failed.find(cacheKey); it != cache().failed.end()) {
        why = it->second;
        return nullptr;
      }
    }
    decoded = decode_image_file(p, img, error);
  }
  std::shared_ptr<const HeightField> f = decoded ? field_of(img) : nullptr;
  const std::scoped_lock lock(cache().mu);
  if (!f) {
    why = "height map did not decode: " + (error.empty() ? std::string("no canvas") : error);
    cache().failed.emplace(cacheKey, why);
    return nullptr;
  }
  cache().fields.emplace(cacheKey, f);
  return f;
}

std::optional<DisplacedCarrier> displaced_carrier_for(const doc::Document& d, std::string_view meshKey, std::span<const float> vertices,
                                                      std::span<const std::uint32_t> indices, const Material& mat, std::string& why) {
  why.clear();
  if (!(std::abs(mat.displacement) > 1e-6)) return std::nullopt;
  const std::optional<std::string>& fieldKey = mat.heightMapAssetId ? mat.heightMapAssetId : mat.heightMapSrc;
  if (!fieldKey || fieldKey->empty()) return std::nullopt;
  std::string src;
  if (mat.heightMapAssetId) {
    if (const js::Json* a = doc::find_asset(d, *mat.heightMapAssetId); a != nullptr && a->at("src").is_string()) src = doc::asset_media_src(*a);
  } else {
    src = *fieldKey;  // heightMapSrc (no asset id)
  }
  const std::shared_ptr<const HeightField> field = height_field_for(*fieldKey, src, why);
  if (!field) return std::nullopt;
  DisplacedCarrier c;
  c.key = displaced_mesh_key(meshKey, *fieldKey, mat.displacement, mat.displacementSubdivisions);
  c.mesh = displace_mesh(vertices, indices, *field, mat.displacement, mat.displacementSubdivisions);
  return c;
}

void displaced_to_api(const DisplacedCarrier& c, api::RenderExtrudedMesh& out) {
  static_assert(std::endian::native == std::endian::little, "FrameScene mesh bytes are little-endian");
  out.key = c.key;
  out.vertices.resize(c.mesh.vertices.size() * sizeof(float));
  std::memcpy(out.vertices.data(), c.mesh.vertices.data(), out.vertices.size());
  out.index_format = api::RenderIndexFormat::uint32;
  out.indices.resize(c.mesh.indices.size() * sizeof(std::uint32_t));
  std::memcpy(out.indices.data(), c.mesh.indices.data(), out.indices.size());
  out.ranges.clear();
}

DisplacedMesh depth_parallax_mesh(const HeightField& depth, double layerW, double layerH, double scale, double edgeCut,
                                  std::uint32_t cols, std::uint32_t rows) {
  cols = std::clamp(cols, 2U, 256U);
  rows = std::clamp(rows, 2U, 256U);
  DisplacedMesh out;
  const std::size_t nx = std::size_t{cols} + 1;
  const std::size_t ny = std::size_t{rows} + 1;
  out.vertices.reserve(nx * ny * kDisplaceStride);
  std::vector<double> d(nx * ny);
  for (std::size_t j = 0; j < ny; ++j) {
    for (std::size_t i = 0; i < nx; ++i) {
      const double u = static_cast<double>(i) / cols;
      const double v = static_cast<double>(j) / rows;
      const double h = sample_height(depth, u, v);
      d[j * nx + i] = h;
      const std::array<float, kDisplaceStride> vert{static_cast<float>((u - 0.5) * layerW), static_cast<float>((v - 0.5) * layerH),
                                                    static_cast<float>(-(h - 0.5) * scale), 0.0F, 0.0F, -1.0F,
                                                    static_cast<float>(u), static_cast<float>(v)};
      out.vertices.insert(out.vertices.end(), vert.begin(), vert.end());
    }
  }
  const auto tri = [&](std::size_t a, std::size_t b, std::size_t c) {
    const double lo = std::min({d[a], d[b], d[c]});
    const double hi = std::max({d[a], d[b], d[c]});
    if (edgeCut > 0 && hi - lo > edgeCut) {
      // Edge fill: the triangle's corners copied, all textured from the farthest one.
      const std::size_t far = d[a] == lo ? a : d[b] == lo ? b : c;
      const float fu = out.vertices[far * kDisplaceStride + 6];
      const float fv = out.vertices[far * kDisplaceStride + 7];
      for (const std::size_t k : {a, b, c}) {
        const auto first = static_cast<std::ptrdiff_t>(k * kDisplaceStride);
        std::array<float, kDisplaceStride> vert{};
        std::copy(out.vertices.begin() + first, out.vertices.begin() + first + static_cast<std::ptrdiff_t>(kDisplaceStride), vert.begin());
        vert[6] = fu;
        vert[7] = fv;
        out.indices.push_back(static_cast<std::uint32_t>(out.vertices.size() / kDisplaceStride));
        out.vertices.insert(out.vertices.end(), vert.begin(), vert.end());
      }
      return;
    }
    out.indices.push_back(static_cast<std::uint32_t>(a));
    out.indices.push_back(static_cast<std::uint32_t>(b));
    out.indices.push_back(static_cast<std::uint32_t>(c));
  };
  for (std::size_t j = 0; j < rows; ++j) {
    for (std::size_t i = 0; i < cols; ++i) {
      const std::size_t p00 = j * nx + i;
      const std::size_t p10 = p00 + 1;
      const std::size_t p01 = p00 + nx;
      const std::size_t p11 = p01 + 1;
      tri(p00, p01, p10);
      tri(p10, p01, p11);
    }
  }
  recompute_normals(out.vertices, out.indices);
  return out;
}

void clear_height_fields() {
  const std::scoped_lock lock(cache().mu);
  cache().fields.clear();
  cache().failed.clear();
}

}  // namespace premation::scene
