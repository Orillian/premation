// A small JSON reader / writer for the SDK samples that talk to the engine API
// (pr_command.h's engine_query / engine_command answer JSON). Not part of the
// SDK: use any JSON library you like. Header-only, C++20, no exceptions.
#pragma once

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace prs::json {

struct Value {
  enum class Kind { null, boolean, number, string, array, object } kind = Kind::null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<Value> a;
  std::vector<std::pair<std::string, Value>> o;

  [[nodiscard]] const Value& operator[](std::string_view key) const {
    static const Value kNull;
    for (const auto& [k, v] : o) {
      if (k == key) return v;
    }
    return kNull;
  }
  [[nodiscard]] const Value& operator[](std::size_t i) const {
    static const Value kNull;
    return i < a.size() ? a[i] : kNull;
  }
  [[nodiscard]] bool is_null() const { return kind == Kind::null; }
  [[nodiscard]] double num(double def = 0) const { return kind == Kind::number ? n : def; }
  [[nodiscard]] const std::string& str() const { return s; }
};

class Parser {
 public:
  explicit Parser(std::string_view t) : t_(t) {}
  bool parse(Value& out) {
    ws();
    if (!value(out, 0)) return false;
    ws();
    return i_ == t_.size();
  }

 private:
  void ws() {
    while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\n' || t_[i_] == '\r' || t_[i_] == '\t')) ++i_;
  }
  bool lit(std::string_view w) {
    if (t_.substr(i_, w.size()) != w) return false;
    i_ += w.size();
    return true;
  }
  bool string(std::string& out) {
    if (i_ >= t_.size() || t_[i_] != '"') return false;
    ++i_;
    while (i_ < t_.size() && t_[i_] != '"') {
      char c = t_[i_++];
      if (c == '\\' && i_ < t_.size()) {
        const char e = t_[i_++];
        switch (e) {
          case 'n': c = '\n'; break;
          case 't': c = '\t'; break;
          case 'r': c = '\r'; break;
          case 'b': c = '\b'; break;
          case 'f': c = '\f'; break;
          case 'u': {  // BMP only, encoded as UTF-8
            if (i_ + 4 > t_.size()) return false;
            unsigned cp = 0;
            for (int k = 0; k < 4; ++k) {
              const char h = t_[i_++];
              const int d = h >= '0' && h <= '9' ? h - '0' : h >= 'a' && h <= 'f' ? h - 'a' + 10 : h >= 'A' && h <= 'F' ? h - 'A' + 10 : -1;
              if (d < 0) return false;
              cp = cp * 16U + static_cast<unsigned>(d);
            }
            if (cp < 0x80) {
              out.push_back(static_cast<char>(cp));
            } else if (cp < 0x800) {
              out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
              out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            } else {
              out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
              out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
              out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            }
            continue;
          }
          default: c = e; break;
        }
      }
      out.push_back(c);
    }
    if (i_ >= t_.size()) return false;
    ++i_;
    return true;
  }
  bool value(Value& v, int depth) {
    if (depth > 64 || i_ >= t_.size()) return false;
    const char c = t_[i_];
    if (c == '{') {
      v.kind = Value::Kind::object;
      ++i_;
      ws();
      if (i_ < t_.size() && t_[i_] == '}') return ++i_, true;
      for (;;) {
        ws();
        std::string k;
        if (!string(k)) return false;
        ws();
        if (i_ >= t_.size() || t_[i_++] != ':') return false;
        ws();
        Value x;
        if (!value(x, depth + 1)) return false;
        v.o.emplace_back(std::move(k), std::move(x));
        ws();
        if (i_ < t_.size() && t_[i_] == ',') {
          ++i_;
          continue;
        }
        return i_ < t_.size() && t_[i_++] == '}';
      }
    }
    if (c == '[') {
      v.kind = Value::Kind::array;
      ++i_;
      ws();
      if (i_ < t_.size() && t_[i_] == ']') return ++i_, true;
      for (;;) {
        ws();
        Value x;
        if (!value(x, depth + 1)) return false;
        v.a.push_back(std::move(x));
        ws();
        if (i_ < t_.size() && t_[i_] == ',') {
          ++i_;
          continue;
        }
        return i_ < t_.size() && t_[i_++] == ']';
      }
    }
    if (c == '"') {
      v.kind = Value::Kind::string;
      return string(v.s);
    }
    if (lit("true")) {
      v.kind = Value::Kind::boolean;
      v.b = true;
      return true;
    }
    if (lit("false")) {
      v.kind = Value::Kind::boolean;
      return true;
    }
    if (lit("null")) return true;
    std::size_t j = i_;
    while (j < t_.size() && (std::string_view("+-.eE0123456789").find(t_[j]) != std::string_view::npos)) ++j;
    if (j == i_) return false;
    v.kind = Value::Kind::number;
    v.n = std::strtod(std::string(t_.substr(i_, j - i_)).c_str(), nullptr);
    i_ = j;
    return true;
  }
  std::string_view t_;
  std::size_t i_ = 0;
};

inline bool parse(std::string_view text, Value& out) { return Parser(text).parse(out); }

/// A JSON string literal for `s` (quotes included).
inline std::string quote(std::string_view s) {
  std::string out = "\"";
  for (const char c : s) {
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back(c);
    } else if (static_cast<unsigned char>(c) < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
      out += buf;
    } else {
      out.push_back(c);
    }
  }
  return out + "\"";
}

/// A number as JSON (integers without a fraction; never NaN / Infinity).
inline std::string number(double v) {
  if (!std::isfinite(v)) return "0";
  char buf[40];
  if (v == std::floor(v) && std::fabs(v) < 9e15) std::snprintf(buf, sizeof buf, "%.0f", v);
  else std::snprintf(buf, sizeof buf, "%.17g", v);
  return buf;
}

}  // namespace prs::json
