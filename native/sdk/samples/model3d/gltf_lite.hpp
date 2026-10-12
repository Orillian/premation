// A small glTF 2.0 reader for the model3d sample (not part of the SDK): .glb
// and .gltf (+ its .bin through a callback — the plugin's
// get_asset_sibling_bytes — or a data: URI), triangle primitives, the node
// hierarchy (matrix or TRS), POSITION / NORMAL / TEXCOORD_0, indices, and the
// first material's baseColorFactor. No textures are decoded here (the effect
// reads its maps through the host: get_asset_image(_gpu), a LAYER param).
//
// Self-contained on purpose: a plugin links only the SDK, so it brings its own
// loader. Never throws; malformed input fails with a message. Header-only,
// C++20. Released with the SDK samples (docs/PLUGIN_SDK.md).
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace gltf_lite {

// ── JSON ───────────────────────────────────────────────────────────────────

struct Json {
  enum class Kind : std::uint8_t { null, boolean, number, string, array, object };
  Kind kind = Kind::null;
  double num = 0;
  bool b = false;
  std::string str;
  std::vector<Json> arr;
  std::vector<std::pair<std::string, Json>> obj;

  [[nodiscard]] const Json& operator[](std::string_view key) const {
    static const Json none;
    for (const auto& [k, v] : obj) {
      if (k == key) return v;
    }
    return none;
  }
  [[nodiscard]] const Json& at(std::size_t i) const {
    static const Json none;
    return i < arr.size() ? arr[i] : none;
  }
  [[nodiscard]] bool is_num() const { return kind == Kind::number; }
  [[nodiscard]] double number(double def) const { return kind == Kind::number ? num : def; }
  [[nodiscard]] int64_t integer(int64_t def) const { return kind == Kind::number ? static_cast<int64_t>(num) : def; }
};

class Parser {
 public:
  explicit Parser(std::string_view s) : s_(s) {}
  bool parse(Json& out) {
    if (!value(out, 0)) return false;
    ws();
    return i_ == s_.size();
  }

 private:
  void ws() {
    while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\n' || s_[i_] == '\r' || s_[i_] == '\t')) ++i_;
  }
  bool lit(std::string_view w) {
    if (s_.substr(i_, w.size()) != w) return false;
    i_ += w.size();
    return true;
  }
  static void utf8(std::string& o, std::uint32_t c) {
    if (c < 0x80) {
      o += static_cast<char>(c);
    } else if (c < 0x800) {
      o += static_cast<char>(0xC0 | (c >> 6));
      o += static_cast<char>(0x80 | (c & 0x3F));
    } else {
      o += static_cast<char>(0xE0 | (c >> 12));
      o += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
      o += static_cast<char>(0x80 | (c & 0x3F));
    }
  }
  bool string(std::string& o) {
    if (i_ >= s_.size() || s_[i_] != '"') return false;
    ++i_;
    while (i_ < s_.size() && s_[i_] != '"') {
      char c = s_[i_++];
      if (c != '\\') {
        o += c;
        continue;
      }
      if (i_ >= s_.size()) return false;
      c = s_[i_++];
      switch (c) {
        case 'n': o += '\n'; break;
        case 't': o += '\t'; break;
        case 'r': o += '\r'; break;
        case 'b': o += '\b'; break;
        case 'f': o += '\f'; break;
        case 'u': {
          if (i_ + 4 > s_.size()) return false;
          std::uint32_t v = 0;
          for (int k = 0; k < 4; ++k) {
            const char h = s_[i_++];
            v <<= 4U;
            if (h >= '0' && h <= '9') v |= static_cast<std::uint32_t>(h - '0');
            else if (h >= 'a' && h <= 'f') v |= static_cast<std::uint32_t>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') v |= static_cast<std::uint32_t>(h - 'A' + 10);
            else return false;
          }
          utf8(o, v);
          break;
        }
        default: o += c;
      }
    }
    if (i_ >= s_.size()) return false;
    ++i_;
    return true;
  }
  bool value(Json& o, int depth) {
    if (depth > 64) return false;
    ws();
    if (i_ >= s_.size()) return false;
    const char c = s_[i_];
    if (c == '{') {
      ++i_;
      o.kind = Json::Kind::object;
      ws();
      if (i_ < s_.size() && s_[i_] == '}') {
        ++i_;
        return true;
      }
      for (;;) {
        ws();
        std::string k;
        if (!string(k)) return false;
        ws();
        if (i_ >= s_.size() || s_[i_] != ':') return false;
        ++i_;
        Json v;
        if (!value(v, depth + 1)) return false;
        o.obj.emplace_back(std::move(k), std::move(v));
        ws();
        if (i_ < s_.size() && s_[i_] == ',') {
          ++i_;
          continue;
        }
        if (i_ < s_.size() && s_[i_] == '}') {
          ++i_;
          return true;
        }
        return false;
      }
    }
    if (c == '[') {
      ++i_;
      o.kind = Json::Kind::array;
      ws();
      if (i_ < s_.size() && s_[i_] == ']') {
        ++i_;
        return true;
      }
      for (;;) {
        Json v;
        if (!value(v, depth + 1)) return false;
        o.arr.push_back(std::move(v));
        ws();
        if (i_ < s_.size() && s_[i_] == ',') {
          ++i_;
          continue;
        }
        if (i_ < s_.size() && s_[i_] == ']') {
          ++i_;
          return true;
        }
        return false;
      }
    }
    if (c == '"') {
      o.kind = Json::Kind::string;
      return string(o.str);
    }
    if (lit("true")) {
      o.kind = Json::Kind::boolean;
      o.b = true;
      return true;
    }
    if (lit("false")) {
      o.kind = Json::Kind::boolean;
      return true;
    }
    if (lit("null")) return true;
    const std::size_t start = i_;
    while (i_ < s_.size() && (std::strchr("+-.eE0123456789", s_[i_]) != nullptr)) ++i_;
    if (i_ == start) return false;
    const std::string n(s_.substr(start, i_ - start));
    char* end = nullptr;
    o.num = std::strtod(n.c_str(), &end);
    o.kind = Json::Kind::number;
    return end != nullptr && *end == '\0' && std::isfinite(o.num);
  }
  std::string_view s_;
  std::size_t i_ = 0;
};

// ── the model ────────────────────────────────────────────────────────────────

/// One vertex as the effect's GPU path uploads it (32 bytes: position, normal, uv).
struct Vertex {
  std::array<float, 3> p{};
  std::array<float, 3> n{};
  std::array<float, 2> uv{};
};
static_assert(sizeof(Vertex) == 32);

/// Every triangle of the default scene, flattened into model space (glTF's: metres, +y up).
struct Model {
  std::vector<Vertex> vertices;
  std::vector<std::uint32_t> indices;
  std::array<float, 4> baseColor{1, 1, 1, 1};  ///< the first material's baseColorFactor (linear)
  std::array<float, 3> lo{0, 0, 0};
  std::array<float, 3> hi{0, 0, 0};
};

/// Reads a file beside the model (`uri` relative to it): the .gltf's buffers.
using SiblingFn = std::function<bool(const std::string& uri, std::vector<std::uint8_t>& out)>;

namespace detail {

using M4 = std::array<double, 16>;  // column-major

inline M4 identity() { return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}; }

inline M4 mul(const M4& a, const M4& b) {
  M4 o{};
  for (std::size_t c = 0; c < 4; ++c) {
    for (std::size_t r = 0; r < 4; ++r) {
      double s = 0;
      for (std::size_t k = 0; k < 4; ++k) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

inline M4 node_matrix(const Json& n) {
  const Json& m = n["matrix"];
  if (m.arr.size() == 16) {
    M4 o{};
    for (std::size_t i = 0; i < 16; ++i) o[i] = m.at(i).number(i % 5 == 0 ? 1 : 0);
    return o;
  }
  const Json& t = n["translation"];
  const Json& r = n["rotation"];
  const Json& s = n["scale"];
  const double tx = t.at(0).number(0), ty = t.at(1).number(0), tz = t.at(2).number(0);
  const double qx = r.at(0).number(0), qy = r.at(1).number(0), qz = r.at(2).number(0), qw = r.at(3).number(1);
  const double sx = s.at(0).number(1), sy = s.at(1).number(1), sz = s.at(2).number(1);
  M4 o = identity();
  o[0] = (1 - 2 * (qy * qy + qz * qz)) * sx;
  o[1] = (2 * (qx * qy + qz * qw)) * sx;
  o[2] = (2 * (qx * qz - qy * qw)) * sx;
  o[4] = (2 * (qx * qy - qz * qw)) * sy;
  o[5] = (1 - 2 * (qx * qx + qz * qz)) * sy;
  o[6] = (2 * (qy * qz + qx * qw)) * sy;
  o[8] = (2 * (qx * qz + qy * qw)) * sz;
  o[9] = (2 * (qy * qz - qx * qw)) * sz;
  o[10] = (1 - 2 * (qx * qx + qy * qy)) * sz;
  o[12] = tx;
  o[13] = ty;
  o[14] = tz;
  return o;
}

inline bool base64(std::string_view s, std::vector<std::uint8_t>& out) {
  std::uint32_t acc = 0;
  int bits = 0;
  for (const char c : s) {
    int v = -1;
    if (c >= 'A' && c <= 'Z') v = c - 'A';
    else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
    else if (c >= '0' && c <= '9') v = c - '0' + 52;
    else if (c == '+') v = 62;
    else if (c == '/') v = 63;
    else if (c == '=') break;
    else continue;
    acc = (acc << 6U) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((acc >> static_cast<unsigned>(bits)) & 0xFFU));
    }
  }
  return true;
}

class Reader {
 public:
  Reader(const Json& doc, std::vector<std::vector<std::uint8_t>> buffers) : doc_(doc), buffers_(std::move(buffers)) {}

  /// Accessor `index` read as `comps` floats per element (normalised integers scaled).
  bool floats(int64_t index, int comps, std::vector<float>& out, std::string& why) const {
    const Json& a = doc_["accessors"].at(static_cast<std::size_t>(index));
    if (a.kind != Json::Kind::object) return fail(why, "accessor missing");
    const auto count = static_cast<std::size_t>(a["count"].integer(0));
    const int64_t ct = a["componentType"].integer(0);
    const bool norm = a["normalized"].b;
    std::span<const std::uint8_t> bytes;
    std::size_t stride = 0;
    const std::size_t csize = ct == 5126 || ct == 5125 ? 4 : ct == 5123 || ct == 5122 ? 2 : 1;
    if (!view(a, static_cast<std::size_t>(comps) * csize, count, bytes, stride, why)) return false;
    out.assign(count * static_cast<std::size_t>(comps), 0.0F);
    for (std::size_t i = 0; i < count; ++i) {
      for (int k = 0; k < comps; ++k) {
        const std::size_t o = i * stride + static_cast<std::size_t>(k) * csize;
        double v = 0;
        if (ct == 5126) {
          float f = 0;
          std::memcpy(&f, bytes.subspan(o, 4).data(), 4);
          v = f;
        } else if (ct == 5123) {
          std::uint16_t u = 0;
          std::memcpy(&u, bytes.subspan(o, 2).data(), 2);
          v = norm ? u / 65535.0 : u;
        } else if (ct == 5121) {
          v = norm ? bytes[o] / 255.0 : bytes[o];
        } else if (ct == 5122) {
          std::int16_t u = 0;
          std::memcpy(&u, bytes.subspan(o, 2).data(), 2);
          v = norm ? std::max(-1.0, u / 32767.0) : u;
        } else if (ct == 5120) {
          const auto u = static_cast<std::int8_t>(bytes[o]);
          v = norm ? std::max(-1.0, u / 127.0) : u;
        } else {
          return fail(why, "unsupported component type");
        }
        out[i * static_cast<std::size_t>(comps) + static_cast<std::size_t>(k)] = static_cast<float>(v);
      }
    }
    return true;
  }

  bool indices(int64_t index, std::vector<std::uint32_t>& out, std::string& why) const {
    const Json& a = doc_["accessors"].at(static_cast<std::size_t>(index));
    if (a.kind != Json::Kind::object) return fail(why, "index accessor missing");
    const auto count = static_cast<std::size_t>(a["count"].integer(0));
    const int64_t ct = a["componentType"].integer(0);
    const std::size_t csize = ct == 5125 ? 4 : ct == 5123 ? 2 : ct == 5121 ? 1 : 0;
    if (csize == 0) return fail(why, "unsupported index type");
    std::span<const std::uint8_t> bytes;
    std::size_t stride = 0;
    if (!view(a, csize, count, bytes, stride, why)) return false;
    out.resize(count);
    for (std::size_t i = 0; i < count; ++i) {
      std::uint32_t v = 0;
      if (csize == 4) std::memcpy(&v, bytes.subspan(i * stride, 4).data(), 4);
      else if (csize == 2) {
        std::uint16_t u = 0;
        std::memcpy(&u, bytes.subspan(i * stride, 2).data(), 2);
        v = u;
      } else {
        v = bytes[i * stride];
      }
      out[i] = v;
    }
    return true;
  }

 private:
  static bool fail(std::string& why, const char* w) {
    why = w;
    return false;
  }
  bool view(const Json& a, std::size_t elem, std::size_t count, std::span<const std::uint8_t>& out, std::size_t& stride,
            std::string& why) const {
    const int64_t bvi = a["bufferView"].integer(-1);
    if (bvi < 0) return fail(why, "sparse / empty accessors are not supported");
    const Json& bv = doc_["bufferViews"].at(static_cast<std::size_t>(bvi));
    const int64_t bi = bv["buffer"].integer(-1);
    if (bi < 0 || static_cast<std::size_t>(bi) >= buffers_.size()) return fail(why, "buffer missing");
    const std::vector<std::uint8_t>& buf = buffers_[static_cast<std::size_t>(bi)];
    const auto off = static_cast<std::size_t>(bv["byteOffset"].integer(0) + a["byteOffset"].integer(0));
    stride = static_cast<std::size_t>(bv["byteStride"].integer(0));
    if (stride == 0) stride = elem;
    if (count == 0) {
      out = {};
      return true;
    }
    const std::size_t need = (count - 1) * stride + elem;
    if (off > buf.size() || need > buf.size() - off) return fail(why, "accessor outside its buffer");
    out = std::span<const std::uint8_t>(buf).subspan(off, need);
    return true;
  }
  const Json& doc_;
  std::vector<std::vector<std::uint8_t>> buffers_;
};

}  // namespace detail

/// Parse a .glb or .gltf (by its first bytes). False + `why` on anything it cannot read.
inline bool load(std::span<const std::uint8_t> file, const SiblingFn& sibling, Model& model, std::string& why) {
  using detail::M4;
  Json doc;
  std::vector<std::uint8_t> glbBin;
  bool hasGlbBin = false;
  constexpr std::uint32_t kMagic = 0x46546C67;  // 'glTF'
  std::uint32_t magic = 0;
  if (file.size() >= 4) std::memcpy(&magic, file.data(), 4);
  if (magic == kMagic) {
    if (file.size() < 20) {
      why = "truncated .glb";
      return false;
    }
    std::size_t o = 12;
    bool json = false;
    while (o + 8 <= file.size()) {
      std::uint32_t len = 0;
      std::uint32_t type = 0;
      std::memcpy(&len, file.subspan(o, 4).data(), 4);
      std::memcpy(&type, file.subspan(o + 4, 4).data(), 4);
      o += 8;
      if (len > file.size() - o) {
        why = "truncated .glb chunk";
        return false;
      }
      const auto chunk = file.subspan(o, len);
      if (type == 0x4E4F534A) {  // JSON
        const std::string_view text(reinterpret_cast<const char*>(chunk.data()), chunk.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
        if (!Parser(text).parse(doc)) {
          why = "the .glb's JSON does not parse";
          return false;
        }
        json = true;
      } else if (type == 0x004E4942) {  // BIN
        glbBin.assign(chunk.begin(), chunk.end());
        hasGlbBin = true;
      }
      o += (len + 3U) & ~std::size_t{3};
    }
    if (!json) {
      why = ".glb without JSON";
      return false;
    }
  } else {
    const std::string_view text(reinterpret_cast<const char*>(file.data()), file.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    if (!Parser(text).parse(doc)) {
      why = "not a glTF file (neither .glb nor JSON)";
      return false;
    }
  }
  if (doc["asset"]["version"].str.empty() || doc["asset"]["version"].str[0] != '2') {
    why = "not glTF 2.0";
    return false;
  }

  std::vector<std::vector<std::uint8_t>> buffers;
  for (const Json& b : doc["buffers"].arr) {
    std::vector<std::uint8_t> bytes;
    const std::string& uri = b["uri"].str;
    if (uri.empty()) {
      if (!hasGlbBin) {
        why = "buffer without data";
        return false;
      }
      bytes = glbBin;
    } else if (uri.starts_with("data:")) {
      const std::size_t comma = uri.find(',');
      if (comma == std::string::npos || !detail::base64(std::string_view(uri).substr(comma + 1), bytes)) {
        why = "bad data: URI";
        return false;
      }
    } else if (!sibling || !sibling(uri, bytes)) {
      why = "cannot read buffer '" + uri + "' beside the model";
      return false;
    }
    buffers.push_back(std::move(bytes));
  }
  const detail::Reader reader(doc, std::move(buffers));

  bool colorSet = false;
  std::string err;
  const std::function<bool(int64_t, const M4&, int)> walk = [&](int64_t ni, const M4& parent, int depth) -> bool {
    if (depth > 32) return true;
    const Json& n = doc["nodes"].at(static_cast<std::size_t>(ni));
    if (n.kind != Json::Kind::object) return true;
    const M4 m = detail::mul(parent, detail::node_matrix(n));
    const int64_t mi = n["mesh"].integer(-1);
    if (mi >= 0) {
      for (const Json& prim : doc["meshes"].at(static_cast<std::size_t>(mi))["primitives"].arr) {
        if (prim["mode"].integer(4) != 4) continue;  // triangles only
        const int64_t pa = prim["attributes"]["POSITION"].integer(-1);
        if (pa < 0) continue;
        std::vector<float> pos;
        std::vector<float> nrm;
        std::vector<float> uv;
        if (!reader.floats(pa, 3, pos, err)) return false;
        const int64_t na = prim["attributes"]["NORMAL"].integer(-1);
        if (na >= 0 && !reader.floats(na, 3, nrm, err)) return false;
        const int64_t ua = prim["attributes"]["TEXCOORD_0"].integer(-1);
        if (ua >= 0 && !reader.floats(ua, 2, uv, err)) return false;
        const std::size_t count = pos.size() / 3;
        std::vector<std::uint32_t> idx;
        if (prim["indices"].is_num()) {
          if (!reader.indices(prim["indices"].integer(-1), idx, err)) return false;
        } else {
          idx.resize(count);
          for (std::size_t i = 0; i < count; ++i) idx[i] = static_cast<std::uint32_t>(i);
        }
        const auto base = static_cast<std::uint32_t>(model.vertices.size());
        for (std::size_t i = 0; i < count; ++i) {
          Vertex v;
          const double x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          for (std::size_t r = 0; r < 3; ++r) v.p[r] = static_cast<float>(m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
          if (nrm.size() >= (i + 1) * 3) {
            // The upper 3×3 is enough for rigid / uniformly scaled nodes; renormalised.
            double nn[3];  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
            for (std::size_t r = 0; r < 3; ++r) nn[r] = m[r] * nrm[i * 3] + m[4 + r] * nrm[i * 3 + 1] + m[8 + r] * nrm[i * 3 + 2];
            const double l = std::max(1e-12, std::sqrt(nn[0] * nn[0] + nn[1] * nn[1] + nn[2] * nn[2]));
            for (std::size_t r = 0; r < 3; ++r) v.n[r] = static_cast<float>(nn[r] / l);
          }
          if (uv.size() >= (i + 1) * 2) v.uv = {uv[i * 2], uv[i * 2 + 1]};
          model.vertices.push_back(v);
        }
        for (std::size_t i = 0; i + 2 < idx.size(); i += 3) {
          if (idx[i] >= count || idx[i + 1] >= count || idx[i + 2] >= count) {
            err = "index out of range";
            return false;
          }
          model.indices.push_back(base + idx[i]);
          model.indices.push_back(base + idx[i + 1]);
          model.indices.push_back(base + idx[i + 2]);
        }
        if (nrm.empty()) {
          // Flat normals from the triangles (a model without NORMAL).
          for (std::size_t i = model.indices.size() - (idx.size() / 3) * 3; i + 2 < model.indices.size(); i += 3) {
            Vertex& a = model.vertices[model.indices[i]];
            const Vertex& b = model.vertices[model.indices[i + 1]];
            const Vertex& c = model.vertices[model.indices[i + 2]];
            const std::array<double, 3> e1{b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]};
            const std::array<double, 3> e2{c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]};
            std::array<double, 3> cr{e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]};
            const double l = std::max(1e-12, std::sqrt(cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]));
            for (std::uint32_t k : {model.indices[i], model.indices[i + 1], model.indices[i + 2]}) {
              for (std::size_t r = 0; r < 3; ++r) model.vertices[k].n[r] = static_cast<float>(cr[r] / l);
            }
          }
        }
        if (!colorSet) {
          const int64_t mat = prim["material"].integer(-1);
          const Json& f = doc["materials"].at(static_cast<std::size_t>(std::max<int64_t>(0, mat)))["pbrMetallicRoughness"]["baseColorFactor"];
          if (mat >= 0 && f.arr.size() == 4) {
            for (std::size_t k = 0; k < 4; ++k) model.baseColor[k] = static_cast<float>(f.at(k).number(1));
          }
          colorSet = true;
        }
      }
    }
    for (const Json& c : n["children"].arr) {
      if (!walk(c.integer(-1), m, depth + 1)) return false;
    }
    return true;
  };
  const Json& scenes = doc["scenes"];
  const Json& scene = scenes.at(static_cast<std::size_t>(std::max<int64_t>(0, doc["scene"].integer(0))));
  if (scene.kind == Json::Kind::object) {
    for (const Json& r : scene["nodes"].arr) {
      if (!walk(r.integer(-1), detail::identity(), 0)) {
        why = err;
        return false;
      }
    }
  } else {
    for (std::size_t i = 0; i < doc["nodes"].arr.size(); ++i) {
      if (!walk(static_cast<int64_t>(i), detail::identity(), 0)) {
        why = err;
        return false;
      }
    }
  }
  if (model.vertices.empty() || model.indices.empty()) {
    why = "the model has no triangles";
    return false;
  }
  model.lo = model.vertices[0].p;
  model.hi = model.vertices[0].p;
  for (const Vertex& v : model.vertices) {
    for (std::size_t k = 0; k < 3; ++k) {
      model.lo[k] = std::min(model.lo[k], v.p[k]);
      model.hi[k] = std::max(model.hi[k], v.p[k]);
    }
  }
  return true;
}

}  // namespace gltf_lite
