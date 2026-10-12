#include "api_json.hpp"

#include <cmath>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <utility>

#include "native_effects.hpp"

namespace premation::plugins {
namespace {

// ── the schema, as data ────────────────────────────────────────────────────

constexpr std::string_view kSchemaChunks[] = {  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): generated initializer
#include "api_schema.inc"
};

enum class Cat : std::uint8_t { boolean, varint, svarint, f32, f64, string, bytes, enumeration, structure, unionn };

struct Field {
  std::string name;
  std::uint32_t num = 0;
  std::string type;
  bool list = false;
  bool optional = false;
};
struct Variant {
  std::string name;
  std::uint32_t num = 0;
  std::string type;  ///< "void" for a variant without a value
};
struct Union {
  bool flat = false;
  std::vector<Variant> variants;
};

struct Schema {
  std::map<std::string, std::string, std::less<>> aliases;
  std::map<std::string, std::vector<std::pair<std::string, std::uint32_t>>, std::less<>> enums;
  std::map<std::string, std::vector<Field>, std::less<>> structs;
  std::map<std::string, Union, std::less<>> unions;

  [[nodiscard]] std::string_view base(std::string_view t) const {
    const auto it = aliases.find(t);
    return it == aliases.end() ? t : std::string_view(it->second);
  }
  [[nodiscard]] std::optional<Cat> category(std::string_view type) const {
    const std::string_view t = base(type);
    if (t == "bool") return Cat::boolean;
    if (t == "u32" || t == "u64") return Cat::varint;
    if (t == "i32" || t == "i64") return Cat::svarint;
    if (t == "f32") return Cat::f32;
    if (t == "f64") return Cat::f64;
    if (t == "string") return Cat::string;
    if (t == "bytes") return Cat::bytes;
    if (enums.contains(t)) return Cat::enumeration;
    if (structs.contains(t)) return Cat::structure;
    if (unions.contains(t)) return Cat::unionn;
    return std::nullopt;
  }
};

const Schema& schema() {
  static const std::unique_ptr<const Schema> s = [] {
    auto out = std::make_unique<Schema>();
    std::string text;
    for (const std::string_view c : kSchemaChunks) text += c;
    const auto j = js::parse(text);
    if (!j) return std::unique_ptr<const Schema>(std::move(out));
    for (const auto& m : j->at("aliases").obj()) out->aliases.emplace(m.key, m.value.str());
    for (const auto& m : j->at("enums").obj()) {
      auto& e = out->enums[m.key];
      for (const js::Json& row : m.value.arr()) e.emplace_back(row.arr().at(0).str(), static_cast<std::uint32_t>(row.arr().at(1).num()));
    }
    for (const auto& m : j->at("structs").obj()) {
      auto& fs = out->structs[m.key];
      for (const js::Json& row : m.value.arr()) {
        const auto& a = row.arr();
        fs.push_back(Field{a.at(0).str(), static_cast<std::uint32_t>(a.at(1).num()), a.at(2).str(), a.at(3).num() != 0, a.at(4).num() != 0});
      }
    }
    for (const auto& m : j->at("unions").obj()) {
      Union u;
      u.flat = m.value.arr().at(0).num() != 0;
      for (const js::Json& row : m.value.arr().at(1).arr()) {
        const auto& a = row.arr();
        u.variants.push_back(Variant{a.at(0).str(), static_cast<std::uint32_t>(a.at(1).num()), a.at(2).str()});
      }
      out->unions.emplace(m.key, std::move(u));
    }
    return std::unique_ptr<const Schema>(std::move(out));
  }();
  return *s;
}

constexpr std::uint32_t wire_type(Cat c, bool packedList) {
  if (packedList) return wire::kWireLen;
  switch (c) {
    case Cat::f64: return wire::kWireFixed64;
    case Cat::f32: return wire::kWireFixed32;
    case Cat::string:
    case Cat::bytes:
    case Cat::structure:
    case Cat::unionn: return wire::kWireLen;
    default: return wire::kWireVarint;
  }
}
constexpr bool packable(Cat c) { return c != Cat::string && c != Cat::bytes && c != Cat::structure && c != Cat::unionn; }

// ── JSON → wire ────────────────────────────────────────────────────────────

class Encoder {
 public:
  explicit Encoder(const Schema& s) : s_(s) {}
  std::string error;

  bool value(wire::Writer& w, std::string_view type, const js::Json& v, const std::string& at) {
    const auto cat = s_.category(type);
    if (!cat) return fail(at, "unknown type " + std::string(type));
    if (*cat == Cat::structure || *cat == Cat::unionn) {
      const std::size_t start = w.begin_ld();
      const bool ok = *cat == Cat::structure ? structure(w, s_.base(type), v, at) : unionn(w, s_.base(type), v, at);
      w.end_ld(start);
      return ok;
    }
    return scalar(w, *cat, s_.base(type), v, at);
  }

  bool structure(wire::Writer& w, std::string_view name, const js::Json& v, const std::string& at) {
    if (!v.is_undefined() && !v.is_null() && !v.is_object()) return fail(at, "expected an object");
    const auto& fields = s_.structs.find(name)->second;
    for (const Field& f : fields) {
      const js::Json& x = v.at(f.name);  // undefined for a missing key or a non-object
      const std::string path = at.empty() ? f.name : at + "." + f.name;
      const auto cat = s_.category(f.type);
      if (!cat) return fail(path, "unknown type " + f.type);
      if (f.list) {
        if (x.is_undefined() || x.is_null()) continue;
        if (!x.is_array()) return fail(path, "expected an array");
        if (x.arr().empty()) continue;
        if (packable(*cat)) {
          w.varint((std::uint64_t{f.num} << 3U) | wire::kWireLen);
          const std::size_t start = w.begin_ld();
          for (std::size_t i = 0; i < x.arr().size(); ++i) {
            if (!scalar(w, *cat, s_.base(f.type), x.arr()[i], path + "[" + std::to_string(i) + "]")) return false;
          }
          w.end_ld(start);
        } else {
          for (std::size_t i = 0; i < x.arr().size(); ++i) {
            w.varint((std::uint64_t{f.num} << 3U) | wire_type(*cat, false));
            if (!value(w, f.type, x.arr()[i], path + "[" + std::to_string(i) + "]")) return false;
          }
        }
        continue;
      }
      if (x.is_undefined() || x.is_null()) {
        if (f.optional) continue;
        if (*cat == Cat::unionn) return fail(path, "is required");
        // A required field left out: its zero value (the TypeScript decoder's default shape).
        w.varint((std::uint64_t{f.num} << 3U) | wire_type(*cat, false));
        if (!value(w, f.type, js::Json(), path)) return false;
        continue;
      }
      w.varint((std::uint64_t{f.num} << 3U) | wire_type(*cat, false));
      if (!value(w, f.type, x, path)) return false;
    }
    return true;
  }

  bool unionn(wire::Writer& w, std::string_view name, const js::Json& v, const std::string& at) {
    const Union& u = s_.unions.find(name)->second;
    if (!v.is_object()) return fail(at, "expected an object with '" + std::string(u.flat ? "type" : "kind") + "'");
    const js::Json& tag = v.at(u.flat ? "type" : "kind");
    if (!tag.is_string()) return fail(at, std::string("missing '") + (u.flat ? "type" : "kind") + "'");
    for (const Variant& var : u.variants) {
      if (var.name != tag.str()) continue;
      const std::string path = at.empty() ? var.name : at + "(" + var.name + ")";
      if (var.type == "void") {
        w.varint((std::uint64_t{var.num} << 3U) | wire::kWireLen);
        w.varint(0);
        return true;
      }
      const auto cat = s_.category(var.type);
      if (!cat) return fail(path, "unknown type " + var.type);
      w.varint((std::uint64_t{var.num} << 3U) | wire_type(*cat, false));
      return value(w, var.type, u.flat ? v : v.at("value"), path);
    }
    return fail(at, "unknown " + std::string(name) + " '" + tag.str() + "'");
  }

  bool scalar(wire::Writer& w, Cat cat, std::string_view type, const js::Json& v, const std::string& at) {
    const bool absent = v.is_undefined() || v.is_null();
    switch (cat) {
      case Cat::boolean:
        if (!absent && !v.is_bool()) return fail(at, "expected a boolean");
        w.varint(v.b() ? 1 : 0);
        return true;
      case Cat::varint: {
        if (!absent && !v.is_number()) return fail(at, "expected a number");
        const double d = v.num();
        if (!std::isfinite(d) || d < 0 || d != std::floor(d) || d > 18446744073709549568.0) return fail(at, "expected an unsigned integer");
        w.varint(static_cast<std::uint64_t>(d));
        return true;
      }
      case Cat::svarint: {
        if (!absent && !v.is_number()) return fail(at, "expected a number");
        const double d = v.num();
        if (!std::isfinite(d) || d != std::floor(d) || std::fabs(d) > 9223372036854774784.0) return fail(at, "expected an integer");
        w.svarint(static_cast<std::int64_t>(d));
        return true;
      }
      case Cat::f32:
        if (!absent && !v.is_number()) return fail(at, "expected a number");
        w.f32(static_cast<float>(v.num()));
        return true;
      case Cat::f64:
        if (!absent && !v.is_number()) return fail(at, "expected a number");
        w.f64(v.num());
        return true;
      case Cat::string:
        if (!absent && !v.is_string()) return fail(at, "expected a string");
        w.str(absent ? std::string_view() : std::string_view(v.str()));
        return true;
      case Cat::bytes: {
        if (!absent && !v.is_string()) return fail(at, "expected base64");
        const auto b = absent ? std::optional<std::vector<std::uint8_t>>(std::vector<std::uint8_t>{}) : doc::native_unbase64(v.str());
        if (!b) return fail(at, "expected base64");
        w.bytes(*b);
        return true;
      }
      case Cat::enumeration: {
        const auto& members = s_.enums.find(type)->second;
        if (absent) {
          w.varint(0);
          return true;
        }
        if (!v.is_string()) return fail(at, "expected one of " + std::string(type) + "'s names");
        for (const auto& [n, num] : members) {
          if (n == v.str()) {
            w.varint(num);
            return true;
          }
        }
        return fail(at, "'" + v.str() + "' is not a " + std::string(type));
      }
      case Cat::structure: return structure(w, type, js::Json::object(), at);
      default: return fail(at, "unexpected type");
    }
  }

 private:
  bool fail(const std::string& at, const std::string& why) {
    if (error.empty()) error = (at.empty() ? std::string() : at + ": ") + why;
    return false;
  }
  const Schema& s_;
};

// ── wire → JSON ────────────────────────────────────────────────────────────

class Decoder {
 public:
  explicit Decoder(const Schema& s) : s_(s) {}
  std::string error;

  std::optional<js::Json> structure(wire::Reader& r, std::string_view name) {
    const auto& fields = s_.structs.find(name)->second;
    js::Json out = js::Json::object();
    for (const Field& f : fields) {
      if (f.list) out.set(f.name, js::Json::array());
    }
    while (!r.at_end()) {
      std::uint64_t key = 0;
      if (!r.varint(key)) return fail("truncated");
      const auto num = static_cast<std::uint32_t>(key >> 3U);
      const auto wt = static_cast<std::uint32_t>(key & 7U);
      const Field* f = nullptr;
      for (const Field& c : fields) {
        if (c.num == num) f = &c;
      }
      const auto cat = f != nullptr ? s_.category(f->type) : std::nullopt;
      if (f == nullptr || !cat) {
        if (!r.skip(key)) return fail("malformed");
        continue;
      }
      if (f->list && packable(*cat) && wt == wire::kWireLen) {
        wire::Reader sub;
        if (!r.ld(sub)) return fail("truncated");
        js::Json::Array& arr = out.find_mut(f->name)->arr_mut();
        while (!sub.at_end()) {
          auto x = scalar(sub, *cat, s_.base(f->type));
          if (!x) return std::nullopt;
          arr.push_back(std::move(*x));
        }
        continue;
      }
      auto x = value(r, *cat, s_.base(f->type));
      if (!x) return std::nullopt;
      if (f->list) out.find_mut(f->name)->arr_mut().push_back(std::move(*x));
      else out.set(f->name, std::move(*x));
    }
    // Required scalars the canonical encoder left out (it never does) read as their zero.
    for (const Field& f : fields) {
      if (f.list || f.optional || out.has(f.name)) continue;
      const auto cat = s_.category(f.type);
      if (!cat || *cat == Cat::unionn) continue;
      wire::Writer w;
      Encoder enc(s_);
      if (*cat == Cat::structure) out.set(f.name, js::Json::object());
      else if (enc.scalar(w, *cat, s_.base(f.type), js::Json(), f.name)) {
        wire::Reader zr(w.bytes());
        if (auto z = scalar(zr, *cat, s_.base(f.type))) out.set(f.name, std::move(*z));
      }
    }
    return out;
  }

  std::optional<js::Json> unionn(wire::Reader& r, std::string_view name) {
    const Union& u = s_.unions.find(name)->second;
    std::optional<js::Json> out;
    while (!r.at_end()) {
      std::uint64_t key = 0;
      if (!r.varint(key)) return fail("truncated");
      const auto num = static_cast<std::uint32_t>(key >> 3U);
      const Variant* var = nullptr;
      for (const Variant& c : u.variants) {
        if (c.num == num) var = &c;
      }
      if (var == nullptr) {
        if (!r.skip(key)) return fail("malformed");
        continue;
      }
      if (var->type == "void") {
        wire::Reader sub;
        if (!r.ld(sub)) return fail("truncated");
        js::Json o = js::Json::object();
        o.set(u.flat ? "type" : "kind", js::Json::string(var->name));
        out = std::move(o);
        continue;
      }
      const auto cat = s_.category(var->type);
      if (!cat) return fail("unknown type " + var->type);
      auto x = value(r, *cat, s_.base(var->type));
      if (!x) return std::nullopt;
      js::Json o = js::Json::object();
      if (u.flat) {
        o.set("type", js::Json::string(var->name));
        for (auto& m : x->obj_mut()) o.set(m.key, std::move(m.value));
      } else {
        o.set("kind", js::Json::string(var->name));
        o.set("value", std::move(*x));
      }
      out = std::move(o);
    }
    if (!out) return fail(std::string(name) + " carried no variant");
    return out;
  }

  std::optional<js::Json> value(wire::Reader& r, Cat cat, std::string_view type) {
    if (cat == Cat::structure || cat == Cat::unionn) {
      wire::Reader sub;
      if (!r.ld(sub)) return fail("truncated");
      return cat == Cat::structure ? structure(sub, type) : unionn(sub, type);
    }
    return scalar(r, cat, type);
  }

  std::optional<js::Json> scalar(wire::Reader& r, Cat cat, std::string_view type) {
    switch (cat) {
      case Cat::boolean: {
        bool b = false;
        if (!r.boolean(b)) return fail("bad bool");
        return js::Json::boolean(b);
      }
      case Cat::varint: {
        std::uint64_t v = 0;
        if (!r.varint(v)) return fail("truncated");
        return js::Json::number(static_cast<double>(v));
      }
      case Cat::svarint: {
        std::int64_t v = 0;
        if (!r.svarint(v)) return fail("truncated");
        return js::Json::number(static_cast<double>(v));
      }
      case Cat::f32: {
        float v = 0;
        if (!r.f32(v)) return fail("truncated");
        return js::Json::number(static_cast<double>(v));
      }
      case Cat::f64: {
        double v = 0;
        if (!r.f64(v)) return fail("truncated");
        return js::Json::number(v);
      }
      case Cat::string: {
        std::string s;
        if (!r.str(s)) return fail("truncated");
        return js::Json::string(std::move(s));
      }
      case Cat::bytes: {
        std::vector<std::uint8_t> b;
        if (!r.bytes(b)) return fail("truncated");
        return js::Json::string(doc::native_base64(b));
      }
      case Cat::enumeration: {
        std::uint64_t v = 0;
        if (!r.varint(v)) return fail("truncated");
        for (const auto& [n, num] : s_.enums.find(type)->second) {
          if (num == v) return js::Json::string(n);
        }
        return fail("unknown " + std::string(type) + " " + std::to_string(v));
      }
      default: return fail("unexpected type");
    }
  }

 private:
  std::optional<js::Json> fail(const std::string& why) {
    if (error.empty()) error = why;
    return std::nullopt;
  }
  const Schema& s_;
};

template <class T>
std::optional<T> from_json(std::string_view json, std::string_view type, std::string& error) {
  const auto j = js::parse(json);
  if (!j) {
    error = "not JSON";
    return std::nullopt;
  }
  auto bytes = json_to_wire(*j, type, error);
  if (!bytes) return std::nullopt;
  T out;
  wire::Reader r(*bytes);
  if (const wire::Status st = api::decode(r, out); st != wire::Status::ok) {
    error = std::string(type) + ": " + std::string(wire::to_string(st));
    return std::nullopt;
  }
  return out;
}

template <class T>
std::string encode_json(const T& v, std::string_view type) {
  wire::Writer w;
  api::encode(w, v);
  std::string err;
  const auto j = wire_to_json(w.bytes(), type, err);
  return j ? js::stringify(*j) : std::string("{}");
}

}  // namespace

std::optional<std::vector<std::uint8_t>> json_to_wire(const js::Json& v, std::string_view type, std::string& error) {
  const Schema& s = schema();
  const auto cat = s.category(type);
  if (!cat || (*cat != Cat::structure && *cat != Cat::unionn)) {
    error = "unknown message type " + std::string(type);
    return std::nullopt;
  }
  Encoder e(s);
  wire::Writer w;
  const bool ok = *cat == Cat::structure ? e.structure(w, s.base(type), v, "") : e.unionn(w, s.base(type), v, "");
  if (!ok) {
    error = e.error;
    return std::nullopt;
  }
  return w.take();
}

std::optional<js::Json> wire_to_json(std::span<const std::uint8_t> bytes, std::string_view type, std::string& error) {
  const Schema& s = schema();
  const auto cat = s.category(type);
  if (!cat || (*cat != Cat::structure && *cat != Cat::unionn)) {
    error = "unknown message type " + std::string(type);
    return std::nullopt;
  }
  Decoder d(s);
  wire::Reader r(bytes);
  auto out = *cat == Cat::structure ? d.structure(r, s.base(type)) : d.unionn(r, s.base(type));
  if (!out) error = d.error;
  return out;
}

std::optional<api::Command> command_from_json(std::string_view json, std::string& error) {
  return from_json<api::Command>(json, "Command", error);
}
std::optional<api::Query> query_from_json(std::string_view json, std::string& error) {
  return from_json<api::Query>(json, "Query", error);
}
std::string to_json(const api::CommandResult& r) { return encode_json(r, "CommandResult"); }
std::string to_json(const api::QueryResult& r) { return encode_json(r, "QueryResult"); }
std::string to_json(const api::EngineError& e) { return encode_json(e, "EngineError"); }

}  // namespace premation::plugins
