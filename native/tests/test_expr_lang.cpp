// motion_expr — the statement extension of the expression language
// (docs/EXPRESSION_LANGUAGE.md): statement lists, var/let/const and
// assignment, if/else, functions and arrows with closures, bounded loops,
// AE's vector arithmetic, and the AE layer bindings (effect("…")("…"),
// transform.*, inPoint/outPoint/index/parent) through a fake Host. Five real
// AE rigs close the file.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>
#include <map>
#include <numbers>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "expr.hpp"

namespace {

namespace ex = motion::expr;
using Catch::Approx;
using Str = std::u16string;

std::string narrow(std::u16string_view s) { return ex::utf16_to_utf8(s); }

/// A keyframed scalar track: linear between keys, held outside.
struct Track {
  std::vector<std::pair<double, double>> keys;
  [[nodiscard]] double at(double t) const {
    if (keys.empty()) return 0;
    if (t <= keys.front().first) return keys.front().second;
    if (t >= keys.back().first) return keys.back().second;
    for (std::size_t i = 1; i < keys.size(); ++i) {
      if (t <= keys[i].first) {
        const auto [t0, v0] = keys[i - 1];
        const auto [t1, v1] = keys[i];
        return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
      }
    }
    return keys.back().second;
  }
};

/// The engine's providers, in miniature: this layer's own track, other
/// layers' properties, layer facts, effects and controls.
class FakeHost final : public ex::Host {
 public:
  Track self;
  std::map<std::string, std::map<std::string, double>> layers;  // name → prop → value
  std::map<std::string, ex::LayerFacts> facts;                   // "" = this layer
  std::vector<std::string> stack;                                // index 1 = top
  std::map<std::string, std::map<std::string, ex::EffectParam>> effects;  // effect → param → value
  int effect_reads = 0;
  // 2026-10-21: keyed layer / effect properties ("Layer:prop", "Effect:Param"),
  // switched-off effects, other compositions ("Comp" → its layers by name).
  std::map<std::string, Track> tracks;
  std::map<std::string, Track> effect_tracks;
  std::map<std::string, bool> effect_on;
  std::map<std::string, std::pair<ex::CompInfo, std::vector<std::string>>> comps;

  [[nodiscard]] bool has_self_at() const override { return !self.keys.empty(); }
  double self_at(double t) override { return self.at(t); }

  [[nodiscard]] bool has_layer_at() const override { return true; }
  std::optional<double> layer_at(std::u16string_view name, std::u16string_view prop, double /*t*/) override {
    const auto l = layers.find(narrow(name));
    if (l == layers.end()) return std::nullopt;
    const auto p = l->second.find(narrow(prop));
    if (p == l->second.end()) return std::nullopt;
    return p->second;
  }
  std::optional<double> layer_prop_at(const Str* name, std::u16string_view prop, double t) override {
    const auto tr = tracks.find((name != nullptr ? narrow(*name) : std::string()) + ":" + narrow(prop));
    if (tr != tracks.end()) return tr->second.at(t);
    return layer_at(name != nullptr ? std::u16string_view(*name) : std::u16string_view(u""), prop, t);
  }
  std::vector<double> layer_key_times(const Str* name, std::u16string_view prop) override {
    const auto tr = tracks.find((name != nullptr ? narrow(*name) : std::string()) + ":" + narrow(prop));
    std::vector<double> out;
    if (tr != tracks.end()) {
      for (const auto& [t, v] : tr->second.keys) out.push_back(t);
    }
    return out;
  }
  bool effect_active(const Str* /*layer*/, std::u16string_view effect) override {
    const auto e = effect_on.find(narrow(effect));
    return e == effect_on.end() || e->second;
  }
  std::vector<double> effect_param_key_times(const Str* /*layer*/, std::u16string_view effect, const Str* param,
                                             double /*index*/) override {
    std::vector<double> out;
    if (param == nullptr) return out;
    const auto tr = effect_tracks.find(narrow(effect) + ":" + narrow(*param));
    if (tr != effect_tracks.end()) {
      for (const auto& [t, v] : tr->second.keys) out.push_back(t);
    }
    return out;
  }
  std::optional<ex::CompFacts> comp_facts(const Str* name) override {
    const std::string key = name != nullptr ? narrow(*name) : std::string("Main");
    const auto c = comps.find(key);
    if (c == comps.end()) return std::nullopt;
    return ex::CompFacts{.info = c->second.first, .name = ex::utf8_to_utf16(key)};
  }
  std::optional<Str> comp_layer_ref(const Str& comp, const Str* name, double index) override {
    const auto c = comps.find(narrow(comp));
    if (c == comps.end()) return std::nullopt;
    const auto& ls = c->second.second;
    if (name != nullptr) {
      for (const auto& l : ls) {
        if (l == narrow(*name)) return ex::utf8_to_utf16(l);
      }
      return std::nullopt;
    }
    if (index < 1 || index > static_cast<double>(ls.size())) return std::nullopt;
    return ex::utf8_to_utf16(ls[static_cast<std::size_t>(index) - 1]);
  }
  std::optional<ex::LayerFacts> layer_facts_at(const Str* name, double /*t*/) override {
    // This layer is "Self" by name too (thisComp.layer(index) resolves to it).
    const std::string key = name != nullptr && narrow(*name) != "Self" ? narrow(*name) : std::string();
    const auto f = facts.find(key);
    if (f == facts.end()) return std::nullopt;
    return f->second;
  }
  std::optional<Str> layer_ref_by_index(double index) override {
    if (index < 1 || index > static_cast<double>(stack.size()) || std::trunc(index) != index) return std::nullopt;
    return ex::utf8_to_utf16(stack[static_cast<std::size_t>(index) - 1]);
  }
  [[nodiscard]] bool has_effects() const override { return true; }
  bool effect_exists(const Str* layer, std::u16string_view effect) override {
    return layer == nullptr && effects.contains(narrow(effect));
  }
  std::optional<ex::EffectParam> effect_param_at(const Str* /*layer*/, std::u16string_view effect, const Str* param,
                                                 double index, double t) override {
    ++effect_reads;
    const auto e = effects.find(narrow(effect));
    if (e == effects.end()) return std::nullopt;
    if (param != nullptr) {
      const auto tr = effect_tracks.find(narrow(effect) + ":" + narrow(*param));
      if (tr != effect_tracks.end()) return ex::EffectParam{.v = {tr->second.at(t), 0, 0, 0}, .size = 1};
      const auto p = e->second.find(narrow(*param));
      return p == e->second.end() ? std::nullopt : std::optional(p->second);
    }
    std::size_t i = 1;
    for (const auto& [k, v] : e->second) {
      if (static_cast<double>(i) == index) return v;
      ++i;
    }
    return std::nullopt;
  }
};

struct Run {
  FakeHost host;
  ex::Context ctx;
  std::vector<double> key_times;
  Run() {
    ctx.comp = ex::CompInfo{.width = 1920, .height = 1080, .duration = 10, .fps = 30, .num_layers = 3};
    ctx.layer_info = ex::LayerInfo{.name = u"Self", .width = 200, .height = 100};
    ctx.host = &host;
  }
  void keys(std::vector<std::pair<double, double>> k) {
    host.self.keys = std::move(k);
    key_times.clear();
    for (const auto& [t, v] : host.self.keys) key_times.push_back(t);
    ctx.key_times = key_times;
    ctx.self_span = ex::KeySpan{host.self.keys.front().first, host.self.keys.back().first};
  }
  ex::Result run(std::string_view src, double time = 0, double value = 0) {
    ctx.time = time;
    ctx.value = value;
    return ex::Expression::compile(ex::utf8_to_utf16(src)).run(ctx);
  }
  double num(std::string_view src, double time = 0, double value = 0) {
    const ex::Result r = run(src, time, value);
    INFO("src: " << src << " error: " << (r.error ? narrow(*r.error) : std::string("<none>")));
    REQUIRE(r.kind == ex::Result::Kind::kNumber);
    return r.number;
  }
  std::vector<double> vec(std::string_view src, double time = 0) {
    const ex::Result r = run(src, time);
    INFO("src: " << src << " error: " << (r.error ? narrow(*r.error) : std::string("<none>")));
    REQUIRE(r.kind == ex::Result::Kind::kVector);
    return {r.vec.begin(), r.vec.begin() + static_cast<std::ptrdiff_t>(r.size)};
  }
  std::string error(std::string_view src, double time = 0) {
    const ex::Result r = run(src, time);
    INFO("src: " << src);
    REQUIRE(r.error.has_value());
    return narrow(*r.error);
  }
  std::string text(std::string_view src, double time = 0) {
    ctx.time = time;
    const ex::TextResult r = ex::Expression::compile(ex::utf8_to_utf16(src)).run_text(ctx);
    INFO("src: " << src << " error: " << (r.error ? narrow(*r.error) : std::string("<none>")));
    REQUIRE(r.result.has_value());
    return narrow(r.result->text);
  }
};

}  // namespace

// ── (1) statement lists, completion values, comments ────────────────────────

TEST_CASE("expr lang: a program is a statement list whose value is the last expression statement", "[expr][lang]") {
  Run r;
  CHECK(r.num("1; 2") == 2);
  CHECK(r.num("1;\n2;\n3") == 3);
  CHECK(r.num("var a = 2; a * 3") == 6);
  CHECK(r.num("var a = 2\na * 3") == 6);           // line breaks separate statements
  CHECK(r.num("var a = 2;\n\n   a\n  * 3") == 6);  // … but an operator continues one
  CHECK(r.num("// a comment\nvar a = 2 // trailing\n/* block\n comment */ a + 1") == 3);
  CHECK(r.num("var a = 1; a;") == 1);  // a trailing `;` keeps the value
  // A declaration has no value of its own: the last EXPRESSION statement counts.
  CHECK(r.num("5; var a = 1") == 5);
  CHECK(r.num("time * 2", 1.5) == 3);  // the single-expression path
  CHECK(r.num("value + 1", 0, 41) == 42);
  // Errors keep their text; a value-less program is a stated error.
  CHECK(r.error("1 +") == "Syntax error: Unexpected end of expression.");
  CHECK(r.error("1 2") == "Syntax error: Unexpected “2”. Separate statements with “;” or a line break.");
  CHECK(r.error("var a = 1") == "Expression must return a number (or a [x, y] array).");
  CHECK(r.error("/* open") == "Syntax error: Unterminated comment — missing a closing “*/”.");
}

// ── (2) declarations and assignment ─────────────────────────────────────────

TEST_CASE("expr lang: var/let/const, assignment, compound assignment, ++/--", "[expr][lang]") {
  Run r;
  CHECK(r.num("var x = 1; x = 5; x") == 5);
  CHECK(r.num("let x = 1, y = 2; x += y; x *= 3; x -= 1; x /= 2; x %= 3; x") == 1);
  CHECK(r.num("var i = 0; i++; ++i; i--; i") == 1);
  CHECK(r.num("var i = 5; i++") == 5);    // postfix yields the old value
  CHECK(r.num("var i = 5; ++i") == 6);
  CHECK(r.num("var a = b = 3; a + b") == 6);  // right-associative, `b` an implicit global
  CHECK(r.num("amp = 10; freq = 2; amp * freq") == 20);  // sloppy-mode implicit variables
  CHECK(r.num("var s = 0; s = s + time; s", 2) == 2);
  CHECK(r.num("const k = 4; k * k") == 16);
  CHECK(r.error("const k = 4; k = 5; k") == "Assignment to constant variable.");
  CHECK(r.error("const k;") == "Syntax error: Missing initializer in const declaration of “k”.");
  CHECK(r.error("value = 3") == "Syntax error: “value” is a built-in name — declare your own variable with var.");
  CHECK(r.error("1 = 2") == "Syntax error: Invalid left-hand side in assignment.");
  // A local may shadow a built-in once declared.
  CHECK(r.num("var time = 7; time", 3) == 7);
  // Arrays are mutable by index; `length` grows and shrinks.
  CHECK(r.vec("var a = [1, 2]; a[1] = 5; a[2] = 6; a") == std::vector<double>{1, 5, 6});
  CHECK(r.num("var a = [1, 2, 3]; a.length = 1; a.length") == 1);
  CHECK(r.num("var a = []; a[3] = 1; a.length") == 4);
  CHECK(r.error("var a = null; a.x = 1") == "Cannot set “x” of null.");
  CHECK(r.num("typeof nothing == \"undefined\" ? 1 : 0") == 1);
  CHECK(r.num("var f = 1; (typeof f == \"number\") + (typeof \"s\" == \"string\") * 2 + (typeof [] == \"object\") * 4") == 7);
  CHECK(r.num("2 ** 10") == 1024);
  CHECK(r.num("2 ** 3 ** 2") == 512);  // right-associative
  CHECK(r.num("----1") == 1);           // four negations, as before (not two decrements)
  CHECK(r.num("- -1") == 1);
}

// ── (3) if / else if / else ─────────────────────────────────────────────────

TEST_CASE("expr lang: if / else if / else, with and without braces, as the program's value", "[expr][lang]") {
  Run r;
  const std::string_view src = "if (time < 1) { 10 } else if (time < 2) { 20 } else { 30 }";
  CHECK(r.num(src, 0.5) == 10);
  CHECK(r.num(src, 1.5) == 20);
  CHECK(r.num(src, 9) == 30);
  CHECK(r.num("var v = 0; if (time > 1) v = 5; else v = 6; v", 2) == 5);
  CHECK(r.num("var v = 0;\nif (time > 1)\n  v = 5\nelse\n  v = 6\nv", 0) == 6);
  // An `if` whose branch is empty, or not taken, completes with undefined.
  CHECK(r.error("1; if (false) 2") == "Expression must return a number (or a [x, y] array).");
  CHECK(r.num("1; if (true) 2") == 2);
}

// ── (4) functions, arrows, closures ─────────────────────────────────────────

TEST_CASE("expr lang: function declarations hoist, closures capture, arrows work as callbacks", "[expr][lang]") {
  Run r;
  CHECK(r.num("function sq(x) { return x * x } sq(7)") == 49);
  CHECK(r.num("sq(7); function sq(x) { return x * x }") == 49);  // hoisted
  CHECK(r.num("function f() { return g() } function g() { return 3 } f()") == 3);
  CHECK(r.num("function fact(n) { if (n <= 1) return 1; return n * fact(n - 1) } fact(6)") == 720);
  CHECK(r.num("var k = 10; function add(x) { return x + k } k = 20; add(1)") == 21);  // by reference
  CHECK(r.num("function counter() { var n = 0; return function() { n++; return n } }"
              "var c = counter(); c(); c(); c()") == 3);
  CHECK(r.num("var sq = function (x) { return x * x }; sq(5)") == 25);
  CHECK(r.num("var sq = x => x * x; sq(5)") == 25);
  CHECK(r.num("var add = (a, b) => { return a + b }; add(2, 3)") == 5);
  CHECK(r.num("var one = () => 1; one()") == 1);
  CHECK(r.vec("[1, 2, 3].map(x => x * 10)") == std::vector<double>{10, 20, 30});
  CHECK(r.num("[1, 2, 3, 4].filter(function (x) { return x % 2 == 0 }).length") == 2);
  CHECK(r.num("[1, 2, 3].reduce((acc, x) => acc + x, 0)") == 6);
  CHECK(r.num("(function () { return 42 })()") == 42);  // IIFE
  CHECK(r.num("function noReturn() { 5 } typeof noReturn() == \"undefined\" ? 1 : 0") == 1);
  CHECK(r.num("function f(a, b) { return typeof b == \"undefined\" ? a : a + b } f(1) + f(1, 1)") == 3);
  CHECK(r.num("function named() {} named.name == \"named\" && named.length == 0 ? 1 : 0") == 1);
  CHECK(r.num("return 9; 10") == 9);  // a top-level return ends the program
  CHECK(r.num("function f(n) { var i = 0; while (true) { if (++i >= n) return i } } f(5)") == 5);
  CHECK(r.error("function f() { return f() } f()") == "This expression is nested too deeply.");
  CHECK(r.error("nope()") == "Unknown name “nope”. Try time, value, audio, wiggle, layer, loopOut, valueAtTime, clamp, "
                             "linear, ease, thisComp or Math.");
}

// ── (5) loops ───────────────────────────────────────────────────────────────

TEST_CASE("expr lang: for and while loops run bounded, with break and continue", "[expr][lang]") {
  Run r;
  CHECK(r.num("var s = 0; for (var i = 0; i < 10; i++) s += i; s") == 45);
  CHECK(r.num("var s = 0; for (let i = 1; i <= 3; i++) { s += i } s") == 6);
  CHECK(r.num("var s = 0, i = 0; while (i < 5) { i++; if (i == 2) continue; if (i == 4) break; s += i } s") == 4);
  CHECK(r.num("var n = 0; for (;;) { if (++n == 7) break } n") == 7);
  CHECK(r.num("var i = 0; for (; i < 3;) i++; i") == 3);
  // The loop's completion value is its body's last.
  CHECK(r.num("for (var i = 0; i < 3; i++) i * 10") == 20);
  CHECK(r.error("while (true) {}") == "This loop ran more than 50000 times — expressions must finish in bounded time.");
  CHECK(r.error("var s = 0; for (var i = 0; i < 1e9; i++) s += i") == "This expression is too expensive to evaluate.");
  CHECK(r.num("for (var x of [1]) x") == 1);  // for…of (2026-10-21)
  CHECK(r.error("break") == "Syntax error: Illegal break statement.");
  // Nested functions reset the loop context; a loop may call them.
  CHECK(r.num("function sq(x) { return x * x } var s = 0; for (var i = 1; i <= 3; i++) s += sq(i); s") == 14);
}

// ── vector arithmetic ───────────────────────────────────────────────────────

TEST_CASE("expr lang: AE's vector arithmetic on + - * /", "[expr][lang]") {
  Run r;
  CHECK(r.vec("[1, 2] + [3, 4]") == std::vector<double>{4, 6});
  CHECK(r.vec("[1, 2] - [1]") == std::vector<double>{0, 2});
  CHECK(r.vec("[10, 20] * 2") == std::vector<double>{20, 40});
  CHECK(r.vec("2 * [1, 2]") == std::vector<double>{2, 4});
  CHECK(r.vec("[4, 6] / 2") == std::vector<double>{2, 3});
  CHECK(r.vec("[1, 2] + 1") == std::vector<double>{2, 3});
  CHECK(r.vec("var p = [100, 200]; p += [1, 1]; p") == std::vector<double>{101, 201});
  // Strings stay JavaScript's: no vector maths.
  CHECK(r.error("[1, 2] + \"\"") == "Expression must return a number (or a [x, y] array).");
}

// ── (6) bindings ────────────────────────────────────────────────────────────

TEST_CASE("expr lang: effect(\"Name\")(\"Param\"), .param(), by index, and the errors", "[expr][lang][bind]") {
  Run r;
  r.host.effects["Slider Control"]["Slider"] = ex::EffectParam{.v = {42, 0, 0, 0}, .size = 1};
  r.host.effects["Tint"]["Map White To"] = ex::EffectParam{.v = {1, 0.5, 0, 1}, .size = 4};
  r.host.effects["Tint"]["Amount to Tint"] = ex::EffectParam{.v = {75, 0, 0, 0}, .size = 1};
  CHECK(r.num("effect(\"Slider Control\")(\"Slider\")") == 42);
  CHECK(r.num("effect(\"Slider Control\").param(\"Slider\") * 2") == 84);
  CHECK(r.num("thisLayer.effect(\"Slider Control\")(1)") == 42);
  CHECK(r.num("effect(\"Tint\")(1)") == 75);  // parameters by 1-based index
  CHECK(r.vec("effect(\"Tint\")(\"Map White To\")") == std::vector<double>{1, 0.5, 0, 1});
  CHECK(r.num("effect(\"Tint\").name == \"Tint\" ? 1 : 0") == 1);
  CHECK(r.num("var fx = effect(\"Slider Control\"); fx(\"Slider\") + fx(\"Slider\")") == 84);
  CHECK(r.error("effect(\"Nope\")(\"Slider\")") == "No effect named “Nope” on this layer.");
  CHECK(r.error("effect(\"Tint\")(\"Nope\")") == "Effect “Tint” has no parameter “Nope”.");
  CHECK(r.error("effect(3)") == "effect() needs the effect’s name, e.g. effect(\"Slider Control\").");
  // The fake host keeps effects on this layer only.
  CHECK(r.error("thisComp.layer(\"Other\").effect(\"Slider Control\")(\"Slider\")") ==
        "No effect named “Slider Control” on layer “Other”.");
}

TEST_CASE("expr lang: a layer object with no effect provider reads a stated error", "[expr][lang][bind]") {
  ex::Context ctx;
  const ex::Result r = ex::Expression::compile(u"effect(\"S\")(\"Slider\")").run(ctx);
  REQUIRE(r.error.has_value());
  CHECK(narrow(*r.error) == "effect() cannot see this layer’s effects here.");
}

TEST_CASE("expr lang: transform members on thisLayer and layer(), in AE units", "[expr][lang][bind]") {
  Run r;
  r.host.layers[""] = {{"x", 100}, {"y", 200}, {"z", 0},       {"anchorX", 5}, {"anchorY", 6}, {"scaleX", 0.5},
                       {"scaleY", 2}, {"rotation", 45},       {"rotationX", 10}, {"opacity", 80}};
  r.host.layers["Mover"] = {{"x", 300}, {"y", 400}, {"rotation", 90}, {"scaleX", 1}, {"scaleY", 1}};
  CHECK(r.vec("transform.position") == std::vector<double>{100, 200, 0});
  CHECK(r.vec("thisLayer.transform.position") == std::vector<double>{100, 200, 0});
  CHECK(r.vec("thisLayer.transform.anchorPoint") == std::vector<double>{5, 6, 0});
  CHECK(r.vec("thisLayer.transform.scale") == std::vector<double>{50, 200, 100});
  CHECK(r.vec("thisLayer.scale") == std::vector<double>{50, 200, 100});
  CHECK(r.num("thisLayer.transform.rotation") == 45);
  CHECK(r.num("thisLayer.transform.xRotation") == 10);
  CHECK(r.num("thisLayer.transform.opacity") == 80);
  CHECK(r.num("thisLayer.rotation + thisLayer.opacity") == 125);
  CHECK(r.num("thisComp.layer(\"Mover\").transform.rotation") == 90);
  CHECK(r.vec("thisComp.layer(\"Mover\").transform.position + [10, 0]") == std::vector<double>{310, 400, 0});
  CHECK(r.vec("thisComp.layer(\"Mover\").scale") == std::vector<double>{100, 100, 100});
  // Unset members read AE's defaults, not 0: opacity 100, scale 100 %.
  r.host.layers["Bare"] = {{"x", 1}, {"y", 2}};
  CHECK(r.num("thisComp.layer(\"Bare\").transform.opacity") == 100);
  CHECK(r.vec("thisComp.layer(\"Bare\").transform.scale") == std::vector<double>{100, 100, 100});
}

TEST_CASE("expr lang: inPoint, outPoint, index, parent, hasParent, thisComp.layer(index)", "[expr][lang][bind]") {
  Run r;
  r.host.facts[""] = ex::LayerFacts{.in_point = 1, .out_point = 4, .index = 2, .enabled = true, .parent = u"Mover"};
  r.host.facts["Mover"] = ex::LayerFacts{.in_point = 0, .out_point = 10, .index = 1, .enabled = true, .parent = std::nullopt};
  r.host.layers["Mover"] = {{"x", 300}, {"y", 400}};
  r.host.stack = {"Mover", "Self"};
  CHECK(r.num("inPoint") == 1);  // AE's bare names are thisLayer's members
  CHECK(r.num("outPoint - inPoint") == 3);
  CHECK(r.num("index") == 2);
  CHECK(r.num("hasParent && parent.index == 1 ? 1 : 0") == 1);
  CHECK(r.num("thisLayer.inPoint") == 1);
  CHECK(r.num("thisLayer.outPoint") == 4);
  CHECK(r.num("thisLayer.index") == 2);
  CHECK(r.num("thisLayer.hasParent ? 1 : 0") == 1);
  CHECK(r.num("thisLayer.parent.index") == 1);
  CHECK(r.num("thisLayer.parent.name == \"Mover\" ? 1 : 0") == 1);
  CHECK(r.vec("thisLayer.parent.transform.position") == std::vector<double>{300, 400, 0});
  CHECK(r.num("thisLayer.parent.parent == null ? 1 : 0") == 1);
  CHECK(r.num("thisComp.layer(\"Mover\").hasParent ? 1 : 0") == 0);
  CHECK(r.num("thisComp.layer(1).outPoint") == 10);
  CHECK(r.num("thisComp.layer(2).inPoint") == 1);
  CHECK(r.num("thisComp.layer(thisLayer.index - 1).index") == 1);
  CHECK(r.num("thisLayer.enabled && thisLayer.active ? 1 : 0") == 1);
  // No facts for a layer: AE's defaults (the comp's span, index 1, no parent).
  CHECK(r.num("thisComp.layer(\"Unknown\").outPoint") == 10);
  CHECK(r.num("thisComp.layer(\"Unknown\").parent == null ? 1 : 0") == 1);
}

// ── Real AE rigs ────────────────────────────────────────────────────────────

TEST_CASE("AE rig: bounce after the last keyframe, with var and if", "[expr][lang][rig]") {
  Run r;
  r.keys({{0, 0}, {1, 100}});
  // Dan Ebberts' bounce: after the last key, the arrival velocity rings down.
  const std::string_view src = R"(
    var amp = .1;
    var freq = 2.0;
    var decay = 2.0;
    var n = 0;
    if (numKeys > 0) {
      n = nearestKey(time).index;
      if (key(n).time > time) {
        n--;
      }
    }
    if (n == 0) {
      t = 0;
    } else {
      t = time - key(n).time;
    }
    if (n > 0 && t < 1) {
      var v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);
      value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);
    } else {
      value;
    }
  )";
  // Before the last key: the keyframed value passes through.
  CHECK(r.num(src, 0.5, 50) == 50);
  // Just after it: value + v·amp·sin(2π·freq·t)·e^(−decay·t), v ≈ 100/s.
  const double t = 0.125;
  const double want = 100 + 100 * 0.1 * std::sin(2.0 * t * 2 * std::numbers::pi) / std::exp(2.0 * t);
  CHECK(r.num(src, 1 + t, 100) == Approx(want).epsilon(1e-6));
  // Long after: the ring has died (t ≥ 1 reads the plain value).
  CHECK(r.num(src, 2.5, 100) == 100);
}

TEST_CASE("AE rig: loopOut through a helper function", "[expr][lang][rig]") {
  Run r;
  r.keys({{0, 0}, {1, 10}});
  const std::string_view src = R"(
    function loopIt(mode, keys) {
      // AE's loopOut(type, numKeyframes); the helper picks a mode per layer name.
      if (thisLayer.name == "Self") return loopOut(mode, keys);
      return value;
    }
    loopIt("pingpong", 0)
  )";
  CHECK(r.num("function f(m) { return m == \"pingpong\" ? 1 : 0 } f(\"pingpong\")") == 1);
  // pingpong: 0 → 10 over [0, 1], back 10 → 0 over [1, 2], out again over [2, 3].
  CHECK(r.num(src, 1.5, 10) == r.num("loopOut(\"pingpong\")", 1.5, 10));
  CHECK(r.num(src, 1.5, 10) == 5);
  CHECK(r.num(src, 1.75, 10) == 2.5);   // cycle would read 7.5 here
  CHECK(r.num(src, 2.25, 10) == 2.5);
  CHECK(r.num(src, 2.25, 10) == r.num("loopOut(\"pingpong\")", 2.25, 10));
}

TEST_CASE("AE rig: a text counter driven by a Slider Control", "[expr][lang][rig]") {
  Run r;
  r.host.effects["Counter"]["Slider"] = ex::EffectParam{.v = {1234.6, 0, 0, 0}, .size = 1};
  ex::SourceTextSample sample;
  sample.text = u"0";
  r.ctx.text_value = &sample;
  const std::string_view src = R"(
    var v = Math.round(effect("Counter")("Slider"));
    var s = v.toString();
    // thousands separators, the way the AE forums write them
    var out = "";
    var count = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      count++;
      if (count % 3 == 0 && i > 0) out = "," + out;
    }
    "$" + out
  )";
  CHECK(r.text(src) == "$1,235");
  r.host.effects["Counter"]["Slider"].v[0] = 7;
  CHECK(r.text(src) == "$7");
  r.host.effects["Counter"]["Slider"].v[0] = 1000000;
  CHECK(r.text(src) == "$1,000,000");
}

TEST_CASE("AE rig: a parent-relative offset", "[expr][lang][rig]") {
  Run r;
  r.host.facts[""] = ex::LayerFacts{.in_point = 0, .out_point = 10, .index = 2, .enabled = true, .parent = u"Anchor"};
  r.host.layers["Anchor"] = {{"x", 500}, {"y", 300}, {"rotation", 0}};
  const std::string_view src = R"(
    // Sit 40 px under the parent, in the parent's space; stand alone when there is none.
    var offset = [0, 40];
    if (hasParent) {
      var p = parent.transform.position;
      [p[0] + offset[0], p[1] + offset[1]];
    } else {
      value + offset;
    }
  )";
  CHECK(r.vec(src) == std::vector<double>{500, 340});
  r.host.facts[""].parent = std::nullopt;
  CHECK(r.vec(src) == std::vector<double>{0, 40});
  // Vector arithmetic makes the short form work too.
  CHECK(r.vec("parent ? parent.transform.position + [0, 40] : [0, 40]") == std::vector<double>{0, 40});
  r.host.facts[""].parent = u"Anchor";
  CHECK(r.vec("parent ? parent.transform.position + [0, 40] : [0, 40]") == std::vector<double>{500, 340, 0});
}

TEST_CASE("AE rig: fade in from the layer's in point, fade out to its out point", "[expr][lang][rig]") {
  Run r;
  r.host.facts[""] = ex::LayerFacts{.in_point = 1, .out_point = 5, .index = 1, .enabled = true, .parent = std::nullopt};
  const std::string_view src = R"(
    var fadeIn = 0.5;
    var fadeOut = 1;
    var inP = thisLayer.inPoint;
    var outP = thisLayer.outPoint;
    var t = time;
    if (t < inP + fadeIn) {
      linear(t, inP, inP + fadeIn, 0, 100);
    } else if (t > outP - fadeOut) {
      linear(t, outP - fadeOut, outP, 100, 0);
    } else {
      100;
    }
  )";
  CHECK(r.num(src, 1) == 0);
  CHECK(r.num(src, 1.25) == 50);
  CHECK(r.num(src, 3) == 100);
  CHECK(r.num(src, 4.5) == 50);
  CHECK(r.num(src, 5) == 0);
}

// ── (2026-10-21) error positions ────────────────────────────────────────────

TEST_CASE("expr lang: syntax and runtime errors carry the line and column, not in the text", "[expr][lang][pos]") {
  Run r;
  // A syntax error: the offending token.
  const ex::Expression bad = ex::Expression::compile(u"var a = 1;\nvar b = ;\n");
  REQUIRE(bad.compile_error().has_value());
  CHECK(narrow(*bad.compile_error()) == "Syntax error: Unexpected “;”.");
  CHECK(bad.compile_error_line() == 2);
  CHECK(bad.compile_error_column() == 9);
  // A lexer error, after leading whitespace and a CRLF (one break).
  const ex::Expression lexbad = ex::Expression::compile(u"  1 +\r\n  2 @ 3");
  CHECK(lexbad.compile_error_line() == 2);
  CHECK(lexbad.compile_error_column() == 5);
  const ex::Result lr = lexbad.run(r.ctx);
  CHECK(lr.line == 2);
  CHECK(lr.column == 5);
  // A runtime error: the innermost node that failed.
  ex::Result rr = r.run("var a = 1;\nvar b = a + 1;\nfoo(b)");
  REQUIRE(rr.error.has_value());
  CHECK(narrow(*rr.error).starts_with("Unknown name “foo”"));
  CHECK(rr.line == 3);
  CHECK(rr.column == 1);
  rr = r.run("const k = 1;\n  k = 2;\nk");
  CHECK(narrow(*rr.error) == "Assignment to constant variable.");
  CHECK(rr.line == 2);
  CHECK(rr.column == 5);  // the `=`
  // Inside a function: the line of the failing statement in its body.
  rr = r.run("function f(x) {\n  return x.y.z;\n}\nf({})");
  CHECK(narrow(*rr.error) == "Cannot read “z” of undefined.");
  CHECK(rr.line == 2);
  // No value: the last statement's line.
  rr = r.run("var a = 1;\nvar b = 2");
  CHECK(narrow(*rr.error) == "Expression must return a number (or a [x, y] array).");
  CHECK(rr.line == 2);
  // A single expression keeps its message and gets a position too.
  rr = r.run("thisComp.nope.x");
  CHECK(rr.line == 1);
  CHECK(rr.column == 15);
  // Success: no position.
  rr = r.run("1 + 1");
  CHECK(rr.line == 0);
  CHECK(rr.column == 0);
}

// ── (2026-10-21) AE globals ─────────────────────────────────────────────────

TEST_CASE("expr lang: degreesToRadians, radiansToDegrees, hslToRgb, rgbToHsl, timecode", "[expr][lang][ae]") {
  Run r;
  CHECK(r.num("degreesToRadians(180)") == Approx(std::numbers::pi));
  CHECK(r.num("radiansToDegrees(Math.PI / 2)") == Approx(90));
  const auto rgb = r.vec("hslToRgb([0, 1, 0.5, 1])");
  CHECK(rgb == std::vector<double>{1, 0, 0, 1});
  const auto hsl = r.vec("rgbToHsl([0, 0, 1, 0.5])");
  CHECK(hsl[0] == Approx(2.0 / 3));
  CHECK(hsl[1] == Approx(1));
  CHECK(hsl[2] == Approx(0.5));
  CHECK(hsl[3] == 0.5);
  CHECK(r.vec("hslToRgb(rgbToHsl([0.2, 0.4, 0.6, 1]))")[1] == Approx(0.4));
  CHECK(r.text("timeToTimecode()", 61.5) == "0:01:01:15");
  CHECK(r.text("timeToTimecode(3725, 25)") == "1:02:05:00");
  CHECK(r.text("timeToCurrentFormat(1.5)") == "0:00:01:15");  // the comp's 30 fps
  CHECK(r.text("timeToTimecode(-1)") == "-0:00:01:00");
  CHECK(r.num("thisComp.frameDuration") == Approx(1.0 / 30));
}

TEST_CASE("expr lang: smooth and temporalWiggle sample the property around the time", "[expr][lang][ae]") {
  Run r;
  r.keys({{0, 0}, {1, 100}});
  // Linear keys: the mean of a symmetric window is the value at its centre.
  CHECK(r.num("smooth()", 0.5) == Approx(50));
  CHECK(r.num("thisProperty.smooth(0.2, 5)", 0.5) == Approx(50));
  CHECK(r.num("smooth(0.4, 3, 0.5)") == Approx(50));
  CHECK(r.num("smooth(1, 3)", 0) == Approx((0 + 0 + 50) / 3.0));  // held before the first key
  CHECK(r.num("smooth(0.2, 1)", 0.25) == Approx(25));
  const double w = r.num("temporalWiggle(2, 0.1)", 0.5);
  CHECK(w >= 40);
  CHECK(w <= 60);
  CHECK(r.num("temporalWiggle(2, 0)", 0.5) == Approx(50));
  CHECK(r.num("thisProperty.numKeys") == 2);
}

TEST_CASE("expr lang: other layers' properties are property objects", "[expr][lang][ae]") {
  Run r;
  r.host.layers["A"] = {{"x", 10}, {"y", 20}, {"rotation", 45}, {"opacity", 80}, {"scaleX", 0.5}, {"scaleY", 2}};
  r.host.tracks["A:x"] = Track{{{0, 0}, {2, 200}}};
  r.host.tracks["A:rotation"] = Track{{{0, 0}, {1, 90}, {3, 90}}};
  // As values: unchanged.
  CHECK(r.vec("thisComp.layer(\"A\").transform.position", 1) == std::vector<double>{100, 20, 0});
  CHECK(r.num("thisComp.layer(\"A\").transform.rotation", 0.5) == 45);
  CHECK(r.num("thisComp.layer(\"A\").transform.opacity") == 80);
  CHECK(r.vec("thisComp.layer(\"A\").transform.scale") == std::vector<double>{50, 200, 100});
  CHECK(r.num("thisComp.layer(\"A\").transform.position[0]", 1) == 100);
  CHECK(r.num("thisComp.layer(\"A\").transform.rotation * 2", 0.5) == 90);
  CHECK(r.num("Math.round(thisComp.layer(\"A\").transform.rotation + 0.4)", 0.5) == 45);
  CHECK(r.text("\"r=\" + thisComp.layer(\"A\").rotation", 0.5) == "r=45");
  CHECK(r.num("thisComp.layer(\"A\").rotation.toFixed(1) == \"45.0\" ? 1 : 0", 0.5) == 1);
  CHECK(r.num("thisComp.layer(\"A\").rotation === 45 ? 1 : 0", 0.5) == 1);
  // valueAtTime / velocity / speed / value / numKeys / key(n).
  CHECK(r.vec("thisComp.layer(\"A\").transform.position.valueAtTime(0.5)", 1) == std::vector<double>{50, 20, 0});
  CHECK(r.num("thisComp.layer(\"A\").transform.rotation.valueAtTime(2)") == 90);
  CHECK(r.num("thisComp.layer(\"A\").transform.position.velocity[0]", 1) == Approx(100));
  CHECK(r.num("thisComp.layer(\"A\").transform.position.speed", 1) == Approx(100));
  CHECK(r.num("thisComp.layer(\"A\").transform.rotation.velocityAtTime(0.5)") == Approx(90));
  CHECK(r.num("thisComp.layer(\"A\").transform.rotation.value", 0.5) == 45);
  CHECK(r.num("thisComp.layer(\"A\").transform.rotation.numKeys") == 3);
  CHECK(r.num("thisComp.layer(\"A\").transform.position.numKeys") == 2);
  CHECK(r.num("thisComp.layer(\"A\").transform.rotation.key(2).time") == 1);
  CHECK(r.num("thisComp.layer(\"A\").transform.rotation.key(2).value") == 90);
  CHECK(r.num("thisComp.layer(\"A\").transform.opacity.numKeys") == 0);
  // A delayed follow: the classic rig.
  CHECK(r.vec("var L = thisComp.layer(\"A\");\nL.transform.position.valueAtTime(time - 0.5)", 1.5) ==
        std::vector<double>{100, 20, 0});
  // This layer's own properties too.
  r.host.tracks[":x"] = Track{{{0, 0}, {1, 10}}};
  CHECK(r.num("transform.position.valueAtTime(0.5)[0]") == 5);
}

TEST_CASE("expr lang: effect parameters are property objects; effect().active", "[expr][lang][ae]") {
  Run r;
  r.host.effects["Slider Control"]["Slider"] = ex::EffectParam{.v = {7, 0, 0, 0}, .size = 1};
  r.host.effects["Point Control"]["Point"] = ex::EffectParam{.v = {3, 4, 0, 0}, .size = 2};
  r.host.effect_tracks["Slider Control:Slider"] = Track{{{0, 0}, {1, 10}}};
  CHECK(r.num("effect(\"Slider Control\")(\"Slider\")", 0.5) == 5);
  CHECK(r.num("effect(\"Slider Control\")(\"Slider\").value", 0.5) == 5);
  CHECK(r.num("effect(\"Slider Control\")(\"Slider\").valueAtTime(1)") == 10);
  CHECK(r.num("effect(\"Slider Control\")(\"Slider\").velocity", 0.5) == Approx(10));
  CHECK(r.num("effect(\"Slider Control\")(\"Slider\").numKeys") == 2);
  CHECK(r.num("effect(\"Slider Control\")(\"Slider\").key(1).value") == 0);
  CHECK(r.vec("effect(\"Point Control\")(\"Point\")") == std::vector<double>{3, 4});
  CHECK(r.vec("effect(\"Point Control\")(\"Point\").value") == std::vector<double>{3, 4});
  CHECK(r.num("effect(\"Point Control\")(\"Point\").numKeys") == 0);
  CHECK(r.num("effect(\"Slider Control\").active ? 1 : 0") == 1);
  r.host.effect_on["Slider Control"] = false;
  CHECK(r.num("effect(\"Slider Control\").active ? 1 : 0") == 0);
  CHECK(r.num("effect(\"Slider Control\").enabled ? 1 : 0") == 0);
  // A checkbox at 0 is false, at 1 true, as rigs test it.
  r.host.effects["Checkbox Control"]["Checkbox"] = ex::EffectParam{.v = {0, 0, 0, 0}, .size = 1};
  CHECK(r.num("effect(\"Checkbox Control\")(\"Checkbox\") ? 1 : 2") == 2);
  CHECK(r.num("effect(\"Checkbox Control\")(\"Checkbox\") == 0 ? 1 : 2") == 1);
  CHECK(r.num("effect(\"Checkbox Control\")(\"Checkbox\") === 0 ? 1 : 2") == 1);
  CHECK(r.text("effect(\"Slider Control\")(\"Slider\")", 1) == "10");
}

TEST_CASE("expr lang: comp(\"Name\"), thisComp.name, layer names", "[expr][lang][ae]") {
  Run r;
  r.host.comps["Main"] = {ex::CompInfo{.width = 1920, .height = 1080, .duration = 10, .fps = 30, .num_layers = 2}, {"Self"}};
  r.host.comps["Titles"] = {ex::CompInfo{.width = 1280, .height = 720, .duration = 5, .fps = 25, .num_layers = 2},
                            {"Title", "Sub"}};
  r.host.layers["Title"] = {{"x", 640}, {"y", 100}};
  CHECK(r.text("thisComp.name") == "Main");
  CHECK(r.num("comp(\"Titles\").width") == 1280);
  CHECK(r.num("comp(\"Titles\").frameDuration") == Approx(0.04));
  CHECK(r.num("comp(\"Titles\").numLayers") == 2);
  CHECK(r.num("comp(\"Titles\").duration") == 5);
  CHECK(r.text("comp(\"Titles\").name") == "Titles");
  CHECK(r.vec("comp(\"Titles\").layer(\"Title\").transform.position") == std::vector<double>{640, 100, 0});
  CHECK(r.vec("comp(\"Titles\").layer(1).position") == std::vector<double>{640, 100, 0});
  CHECK(r.error("comp(\"Nope\")") == "No composition named “Nope”.");
  CHECK(r.error("comp(\"Titles\").layer(\"Nope\")") == "No layer “Nope” in composition “Titles”.");
  CHECK(r.text("thisLayer.name") == "Self");
  r.host.facts["Mover"] = ex::LayerFacts{.in_point = 0, .out_point = 10, .index = 1, .enabled = true, .parent = std::nullopt,
                                        .name = u"Mover Layer"};
  r.host.stack = {"Mover", "Self"};
  CHECK(r.text("thisComp.layer(1).name") == "Mover Layer");
}

// ── (2026-10-21) language ───────────────────────────────────────────────────

TEST_CASE("expr lang: object literals, template literals", "[expr][lang][syntax]") {
  Run r;
  CHECK(r.num("var o = {a: 1, b: [2, 3], \"c d\": 4, 5: 6}; o.a + o.b[1] + o[\"c d\"] + o[5]") == 14);
  CHECK(r.num("var o = {foo: 1}; o.foo = 5; o.bar = 2; o.foo + o.bar") == 7);
  CHECK(r.num("var x = 3; var o = {x, y: x * 2}; o.x + o.y") == 9);
  CHECK(r.num("var o = {a: 1, a: 2}; o.a") == 2);
  CHECK(r.num("var o = {}; o.missing == null ? 1 : 0") == 1);
  CHECK(r.num("var o = {n: {m: 4}}; o.n.m") == 4);
  CHECK(r.num("var f = () => ({v: 9}); f().v") == 9);
  CHECK(r.text("`a${1 + 1}b`") == "a2b");
  CHECK(r.text("var n = \"x\"; `${n}-${[1, 2]}-${`in${n}`}`") == "x-1,2-inx");
  CHECK(r.text("`line\\n${time}`", 2) == "line\n2");
  CHECK(r.text("`{${ {a: 1}.a }}`") == "{1}");
  CHECK(r.error("`open") == "Syntax error: Unterminated template literal — missing a closing “`”.");
}

TEST_CASE("expr lang: switch, do…while, for…of, for…in", "[expr][lang][syntax]") {
  Run r;
  const std::string_view sw = R"(
    var out = 0;
    switch (Math.floor(time)) {
      case 0: out = 10; break;
      case 1:
      case 2: out = 20; break;
      default: out = 30;
    }
    out
  )";
  CHECK(r.num(sw, 0) == 10);
  CHECK(r.num(sw, 1) == 20);
  CHECK(r.num(sw, 2.5) == 20);
  CHECK(r.num(sw, 7) == 30);
  CHECK(r.num("var s = 0; switch (\"b\") { case \"a\": s += 1; case \"b\": s += 2; case \"c\": s += 4; } s") == 6);
  CHECK(r.num("var s = 0; for (var i = 0; i < 4; i++) { switch (i) { case 1: continue; default: s += i; } } s") == 5);
  CHECK(r.num("var i = 0; do { i++ } while (i < 5); i") == 5);
  CHECK(r.num("var i = 10; do { i++ } while (false) i") == 11);
  CHECK(r.num("var s = 0; for (const v of [1, 2, 3]) s += v; s") == 6);
  CHECK(r.num("var s = 0; for (let v of [1, 2, 3, 4]) { if (v == 3) break; s += v } s") == 3);
  CHECK(r.text("var s = \"\"; for (var c of \"abc\") s = c + s; s") == "cba");
  CHECK(r.text("var s = \"\"; for (var k in {a: 1, b: 2}) s += k; s") == "ab");
  CHECK(r.num("var s = 0; for (var k in [5, 6, 7]) s += k * 1; s") == 3);
  CHECK(r.num("var last; for (last of [4, 8]) {} last") == 8);
  CHECK(r.error("for (var v of 5) v") == "That value is not iterable — for…of walks an array or a string.");
}

TEST_CASE("expr lang: try / catch / finally, throw", "[expr][lang][syntax]") {
  Run r;
  CHECK(r.num("try { nope() } catch (e) { 5 }") == 5);
  CHECK(r.text("try { nope() } catch (e) { e.message }") == "nope is not defined");  // JavaScript's own message
  CHECK(r.num("var x = 0; try { x = 1 } finally { x = 2 } x") == 2);
  CHECK(r.num("var x = 0; try { thisComp.layer(\"Missing\").transform.position.zzz.q } catch { x = 7 } x") == 7);
  CHECK(r.text("try { throw \"bad\" } catch (e) { e }") == "bad");
  CHECK(r.text("try { throw {message: \"m\", code: 2} } catch (e) { e.message + e.code }") == "m2");
  CHECK(r.error("throw \"stop\"") == "stop");
  CHECK(r.error("throw {message: \"boom\"}") == "boom");
  CHECK(r.num("function f() { try { return 1 } finally { } } f()") == 1);
  CHECK(r.num("function f() { try { nope() } catch (e) { return 2 } } f() + 1") == 3);
  // A caught error inside a function restores the caller's variables.
  CHECK(r.num("var a = 4; function f(x) { var q = 1; return x.y.z } try { f(null) } catch (e) {} a") == 4);
  // Budgets are not catchable: a runaway stays an error.
  CHECK(r.error("try { while (true) {} } catch (e) { 1 }") ==
        "This loop ran more than 50000 times — expressions must finish in bounded time.");
  CHECK(r.error("try { 1 }") == "Syntax error: Missing catch or finally after try.");
}

TEST_CASE("expr lang: ??, ?., default parameters, bitwise operators", "[expr][lang][syntax]") {
  Run r;
  CHECK(r.num("null ?? 3") == 3);
  CHECK(r.num("0 ?? 3") == 0);
  CHECK(r.num("var o = {a: {b: 2}}; o?.a?.b") == 2);
  CHECK(r.num("var o = null; o?.a.b.c ?? 5") == 5);
  CHECK(r.num("var o = {}; o.a?.b ?? 6") == 6);
  CHECK(r.num("var o = {}; o.f?.() ?? 7") == 7);
  CHECK(r.num("var a = [1, 2]; a?.[1]") == 2);
  CHECK(r.num("true ? .5 : 1") == 0.5);  // `?.5` stays a conditional
  CHECK(r.num("function f(a, b = 10) { return a + b } f(1)") == 11);
  CHECK(r.num("function f(a, b = a * 2) { return a + b } f(3)") == 9);
  CHECK(r.num("function f(a, b = 10) { return a + b } f(1, 2)") == 3);
  CHECK(r.num("var g = (x, y = 4) => x * y; g(2)") == 8);
  CHECK(r.num("function f(a, b = 1, c) {} f.length") == 1);
  CHECK(r.num("5 & 3") == 1);
  CHECK(r.num("5 | 3") == 7);
  CHECK(r.num("5 ^ 3") == 6);
  CHECK(r.num("~5") == -6);
  CHECK(r.num("1 << 4") == 16);
  CHECK(r.num("-16 >> 2") == -4);
  CHECK(r.num("-1 >>> 28") == 15);
}

TEST_CASE("AE: loopOut / loopIn count keyframes, loopOutDuration / loopInDuration seconds", "[expr][lang][loop]") {
  Run r;
  // 0 → 10 → 30 → 30 at 0, 1, 2, 3 s (the last segment holds).
  r.keys({{0, 0}, {1, 10}, {2, 30}, {3, 30}});
  // Whole span (absent / 0): at 3.5 s, cycle replays 0.5 s → 5.
  CHECK(r.num("loopOut(\"cycle\")", 3.5, 30) == 5);
  CHECK(r.num("loopOut(\"cycle\", 0)", 3.5, 30) == 5);
  // The last 2 segments [1, 3]: 3.5 s replays 1.5 s → 20.
  CHECK(r.num("loopOut(\"cycle\", 2)", 3.5, 30) == 20);
  // A count past the keys clamps to the whole span.
  CHECK(r.num("loopOut(\"cycle\", 99)", 3.5, 30) == 5);
  // The last 1.5 s [1.5, 3]: 3.25 s replays 1.75 s → 25.
  CHECK(r.num("loopOutDuration(\"cycle\", 1.5)", 3.25, 30) == 25);
  // loopIn mirrors it at the start: the first segment [0, 1] before 0.
  CHECK(r.num("loopIn(\"cycle\", 1)", -0.25, 0) == 7.5);
  CHECK(r.num("loopInDuration(\"cycle\", 1)", -0.25, 0) == 7.5);
  // On the property object too, and an unusable duration means the whole span.
  CHECK(r.num("thisProperty.loopOutDuration(\"cycle\", 1.5)", 3.25, 30) == 25);
  CHECK(r.num("loopOutDuration(\"cycle\", -1)", 3.5, 30) == 5);
}
