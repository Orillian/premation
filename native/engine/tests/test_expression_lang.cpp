// AE-style rigs through the engine (docs/EXPRESSION_LANGUAGE.md): statement
// programs on real properties, effect("…")("…") over an expression control
// and a catalogue effect, transform.*, inPoint/outPoint from the layer's bar,
// index from the stack, parent from SetParent — the DocExprEnv half of what
// native/tests/test_expr_lang.cpp covers with a fake host.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <optional>
#include <string>
#include <vector>

#include "core/anim.hpp"
#include "core/catalog_data.hpp"
#include "docexpr.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;

double scalar_of(const api::Value& v) { return std::get<double>(v.v); }

struct Rig {
  Harness h;
  api::ItemId comp;

  Rig() {
    (void)h.hello();
    api::CreateComposition c;
    c.settings.name = "Rig";
    c.settings.width = 640;
    c.settings.height = 360;
    c.settings.frame_rate = api::Rational{30, 1};
    c.settings.duration = 10 * kSec;
    comp = result_item(h.run(cmd(c)));
  }

  api::LayerId layer(api::LayerKind kind = api::LayerKind::solid) {
    api::CreateLayer l;
    l.comp = comp;
    l.kind = kind;
    return result_layer(h.run(cmd(l)));
  }

  template <class T>
  T query(api::Query q) {
    const auto r = h.ask(std::move(q));
    REQUIRE(is_ok(r));
    return result_as<T>(std::get<api::QueryResult>(r.outcome.v));
  }

  std::string add_effect(const api::LayerId& layer, const std::string& matchName,
                         std::optional<std::string> name = std::nullopt) {
    api::AddPropertyGroup a;
    a.layer = layer;
    a.parent = "effects";
    a.match_name = matchName;
    a.name = std::move(name);
    const auto r = h.run(cmd(a));
    INFO("adding " << matchName);
    REQUIRE(is_ok(r));
    return result_as<api::GroupList>(r).groups.at(0);
  }

  void set(const api::LayerId& layer, const std::string& path, api::Value v) {
    api::SetProperty s;
    s.prop = {layer, path};
    s.value = std::move(v);
    REQUIRE(is_ok(h.run(cmd(s))));
  }

  void key(const api::LayerId& layer, const std::string& path, api::Time t, api::Value v) {
    api::AddKeyframes a;
    api::KeyframeInsert k;
    k.prop = {layer, path};
    k.time = t;
    k.value = std::move(v);
    a.keys.push_back(std::move(k));
    REQUIRE(is_ok(h.run(cmd(a))));
  }

  void expression(const api::LayerId& layer, const std::string& path, const std::string& src) {
    api::SetExpression e;
    e.prop = {layer, path};
    e.source = src;
    e.enabled = true;
    REQUIRE(is_ok(h.run(cmd(e))));
  }

  api::Value value(const api::LayerId& layer, const std::string& path, api::Time t) {
    api::GetPropertyValues q;
    q.props = {api::PropRef{layer, path}};
    q.time = t;
    q.evaluated = true;
    return query<api::PropertyValues>(qry(q)).values.at(0).value;
  }

  /// What the engine reports for `src` on that property: the diagnostics.
  std::string diagnostics(const api::LayerId& layer, const std::string& path, const std::string& src, api::Time t = 0) {
    api::EvaluateExpression q;
    q.prop = {layer, path};
    q.time = t;
    q.source = src;
    const auto r = query<api::ExpressionEvaluation>(qry(q));
    std::string out = r.value || r.text ? "ok" : "error";
    for (const auto& d : r.diagnostics) out += " | " + d.message;
    return out;
  }

  /// Set `src` on the layer's property and read it at `t`.
  double probe(const api::LayerId& layer, const std::string& path, const std::string& src, api::Time t = 0) {
    expression(layer, path, src);
    INFO("src: " << src << " → " << diagnostics(layer, path, src, t));
    return scalar_of(value(layer, path, t));
  }
  double rotation(const api::LayerId& layer, const std::string& src, api::Time t = 0) {
    return probe(layer, "transform/rotation", src, t);
  }

  /// The Source Text an enabled expression produces (the scene reader's path).
  std::optional<std::string> source_text(const api::LayerId& layer, double t) {
    doc::ExprCache cache;
    const doc::DocExprEnv env(h.session.document(), h.session.view(), cache);
    const auto r = doc::anim_evaluate_source_text(h.session.document(), env, cache, layer, t);
    if (!r) return std::nullopt;
    return doc::to_u8(r->text);
  }
};

}  // namespace

TEST_CASE("rig: a var/if program over a slider control, keyed and static", "[expr][rig]") {
  Rig x;
  const auto l = x.layer();
  const std::string g = x.add_effect(l, "ADBE Slider Control", "Speed");
  REQUIRE(g == "effects/ctrl_Speed");
  x.set(l, g + "/slider", scalar(42));
  CHECK(x.rotation(l, "var v = effect(\"Speed\")(\"Slider\");\nif (v > 10) { v * 2 } else { v }") == 84);
  CHECK(x.rotation(l, "effect(\"speed\").param(\"slider\") + effect(\"Speed\")(1)") == 84);  // case-free, by index
  // Keyed: the slider interpolates, the expression follows.
  x.key(l, g + "/slider", 0, scalar(0));
  x.key(l, g + "/slider", 2 * kSec, scalar(100));
  CHECK(x.rotation(l, "effect(\"Speed\")(\"Slider\")", kSec) == Catch::Approx(50));
  // A point control reads a vector; a colour control reads 0..1 channels.
  const std::string p = x.add_effect(l, "ADBE Point Control", "Aim");
  x.set(l, p + "/point", vec2(30, 40));
  CHECK(x.rotation(l, "var a = effect(\"Aim\")(\"Point\"); a[0] + a[1]") == 70);
  const std::string c = x.add_effect(l, "ADBE Color Control", "Tint");
  x.set(l, c + "/color", doc::v_color(255, 0, 51, 1));
  CHECK(x.rotation(l, "var c = effect(\"Tint\")(\"Color\"); c[0] * 100 + c[1] + c[2] * 10 + c[3]") == Catch::Approx(103));
  // A missing effect is a stated error; the property keeps its pre-expression value.
  CHECK(x.diagnostics(l, "transform/rotation", "effect(\"Nope\")(\"Slider\")") == "error | No effect named “Nope” on this layer.");
  CHECK(x.rotation(l, "effect(\"Nope\")(\"Slider\")") == 0);
}

TEST_CASE("rig: effect() over a catalogue effect by label, key and index", "[expr][rig]") {
  Rig x;
  const auto l = x.layer();
  // The first registered CPU effect with a plain number parameter, added
  // with a caller-chosen id (AddEffect, as the automation clients do).
  const doc::EffectDef* def = nullptr;
  const doc::EffectParamDef* param = nullptr;
  for (const doc::EffectDef& d : doc::registry().effects) {
    if (d.gpuOnly) continue;
    for (const auto& p : d.params) {
      if (p.type == "number" && !p.fixed) {
        def = &d;
        param = &p;
        break;
      }
    }
    if (def != nullptr) break;
  }
  REQUIRE(def != nullptr);
  api::AddEffect add;
  add.layers = {l};
  add.effect = def->type;
  add.id = "fx1";
  REQUIRE(is_ok(x.h.run(cmd(add))));
  const std::string g = "effects/fx1";
  x.set(l, g + "/" + param->key, scalar(7));
  INFO("effect " << def->label << " (" << def->type << ") param " << param->label << " (" << param->key << ")");
  CHECK(x.rotation(l, "effect(\"" + def->label + "\")(\"" + param->label + "\")") == 7);
  CHECK(x.rotation(l, "effect(\"" + def->type + "\")(\"" + param->key + "\")") == 7);
  std::size_t index = 0;
  for (std::size_t i = 0; i < def->params.size(); ++i) {
    if (&def->params[i] == param) index = i + 1;
  }
  CHECK(x.rotation(l, "effect(\"" + def->label + "\")(" + std::to_string(index) + ")") == 7);
}

TEST_CASE("rig: transform members, index, inPoint/outPoint and parent from the document", "[expr][rig]") {
  Rig x;
  const auto bottom = x.layer();
  const auto top = x.layer();
  x.set(top, "transform/position", vec2(100, 200));
  x.set(top, "transform/scale", vec2(50, 150));
  x.set(top, "transform/opacity", scalar(80));
  x.set(bottom, "transform/position", vec2(300, 400));
  x.set(bottom, "transform/rotation", scalar(45));

  // Probes go on `top`'s Rotation (and `bottom`'s Opacity), never on the
  // values other probes read.
  CHECK(x.rotation(top, "transform.position[0] + transform.position[1]") == 300);
  CHECK(x.rotation(top, "var s = transform.scale; s[0] + s[1]") == 200);
  CHECK(x.rotation(top, "opacity") == 80);
  CHECK(x.probe(bottom, "transform/opacity", "thisLayer.transform.rotation") == 45);
  CHECK(x.rotation(top, "index") == 1);
  CHECK(x.probe(bottom, "transform/opacity", "thisLayer.index") == 2);
  CHECK(x.rotation(top, "thisComp.layer(2).transform.rotation") == 45);
  CHECK(x.rotation(top, "thisComp.layer(2).transform.position[0]") == 300);
  CHECK(x.rotation(top, "inPoint * 100 + outPoint") == 10);  // the whole comp: 0 → 10 s
  api::SetLayerTiming st;
  st.items = {api::LayerTimingPatch{top, 2 * kSec, 5 * kSec, std::nullopt, std::nullopt}};
  REQUIRE(is_ok(x.h.run(cmd(st))));
  CHECK(x.rotation(top, "inPoint * 100 + outPoint") == 205);
  CHECK(x.rotation(top, "hasParent ? 1 : 0") == 0);
  CHECK(x.rotation(top, "parent == null ? 1 : 0") == 1);
  api::SetParent sp;
  sp.layers = {top};
  sp.parent = bottom;
  REQUIRE(is_ok(x.h.run(cmd(sp))));
  CHECK(x.rotation(top, "hasParent ? 1 : 0") == 1);
  CHECK(x.rotation(top, "parent.transform.rotation") == 45);
  // The stack order is the API's layer order: a parented layer sits under
  // its parent, so the indices swap.
  CHECK(x.rotation(top, "parent.index") == 1);
  CHECK(x.rotation(top, "index") == 2);
  CHECK(x.rotation(top, "thisComp.layer(1).transform.rotation") == 45);
  // The AE "offset from the parent" rig, on Position.
  x.expression(top, "transform/position", "parent.transform.position + [0, 40]");
  const api::Value pos = x.value(top, "transform/position", 0);
  CHECK(pos == vec2(300, 440));
}

TEST_CASE("rig: a fade from the in point and a bounce after the last key, on real tracks", "[expr][rig]") {
  Rig x;
  const auto l = x.layer();
  api::SetLayerTiming st;
  st.items = {api::LayerTimingPatch{l, 1 * kSec, 5 * kSec, std::nullopt, std::nullopt}};
  REQUIRE(is_ok(x.h.run(cmd(st))));
  x.expression(l, "transform/opacity",
               "var fadeIn = 0.5;\n"
               "var t = time - inPoint;\n"
               "if (t < fadeIn) linear(t, 0, fadeIn, 0, 100); else 100;");
  CHECK(scalar_of(x.value(l, "transform/opacity", kSec)) == 0);
  // 1.2 s is a whole frame at 30 fps (values are read on frames).
  CHECK(scalar_of(x.value(l, "transform/opacity", kSec + kSec / 5)) == Catch::Approx(40));
  CHECK(scalar_of(x.value(l, "transform/opacity", 3 * kSec)) == 100);

  x.key(l, "transform/rotation", 0, scalar(0));
  x.key(l, "transform/rotation", kSec, scalar(90));
  x.expression(l, "transform/rotation",
               "var amp = .1, freq = 2, decay = 2;\n"
               "var n = numKeys > 0 ? nearestKey(time).index : 0;\n"
               "if (n > 0 && key(n).time > time) n--;\n"
               "var t = n == 0 ? 0 : time - key(n).time;\n"
               "if (n > 0 && t < 1) {\n"
               "  var v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);\n"
               "  value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);\n"
               "} else value;");
  const double at_key = scalar_of(x.value(l, "transform/rotation", kSec));
  CHECK(at_key == Catch::Approx(90));
  const double after = scalar_of(x.value(l, "transform/rotation", kSec + kSec / 10));
  CHECK(after != Catch::Approx(90));  // ringing
  CHECK(std::abs(after - 90) < 20);
  CHECK(scalar_of(x.value(l, "transform/rotation", 3 * kSec)) == Catch::Approx(90));
}

TEST_CASE("rig: a text counter driven by a slider, through a function helper", "[expr][rig]") {
  Rig x;
  const auto t = x.layer(api::LayerKind::text);
  const std::string g = x.add_effect(t, "ADBE Slider Control", "Count");
  x.key(t, g + "/slider", 0, scalar(0));
  x.key(t, g + "/slider", 2 * kSec, scalar(2000));
  x.expression(t, "text/sourceText",
               "function pad(n) { var s = Math.round(n).toString(); while (s.length < 4) s = \"0\" + s; return s }\n"
               "\"#\" + pad(effect(\"Count\")(\"Slider\"))");
  CHECK(x.source_text(t, 0) == std::optional<std::string>("#0000"));
  CHECK(x.source_text(t, 1) == std::optional<std::string>("#1000"));
  CHECK(x.source_text(t, 2) == std::optional<std::string>("#2000"));
}

// ── 2026-10-21: AE property objects, units, error positions ─────────────────

TEST_CASE("rig: the pick-whip's AE paths read the receiving property's own units", "[expr][rig][units]") {
  Rig x;
  const auto a = x.layer();
  const auto b = x.layer();
  x.set(a, "transform/position", vec2(120, 260));
  x.set(a, "transform/anchorPoint", vec2(7, 9));
  x.set(a, "transform/scale", vec2(50, 150));
  x.set(a, "transform/rotation", scalar(30));
  x.set(a, "transform/opacity", scalar(40));
  const std::string A = "thisComp.layer(2)";  // `a`: created first, so under `b`
  // Same kind of property on B: B reads exactly A's value.
  const auto same = [&](const std::string& path, const std::string& src) {
    x.expression(b, path, src);
    INFO(path << " = " << src << " → " << x.diagnostics(b, path, src));
    CHECK(x.value(b, path, 0) == x.value(a, path, 0));
  };
  same("transform/position", A + ".transform.position");
  same("transform/anchorPoint", A + ".transform.anchorPoint");
  same("transform/scale", A + ".transform.scale");
  same("transform/rotation", A + ".transform.rotation");
  same("transform/opacity", A + ".transform.opacity");
  // One dimension of an unseparated Position / Scale (the pick-whip's member form).
  const auto member = [&](const std::string& path, std::uint32_t m, const std::string& src) {
    api::SetExpression e;
    e.prop = {b, path};
    e.source = src;
    e.enabled = true;
    e.member = m;
    REQUIRE(is_ok(x.h.run(cmd(e))));
  };
  x.expression(b, "transform/position", "");
  x.set(b, "transform/position", vec2(1, 2));
  member("transform/position", 0, A + ".transform.position[0]");
  CHECK(x.value(b, "transform/position", 0) == vec2(120, 2));
  x.expression(b, "transform/scale", "");
  x.set(b, "transform/scale", vec2(100, 100));
  member("transform/scale", 1, A + ".transform.scale[1]");
  CHECK(x.value(b, "transform/scale", 0) == vec2(100, 150));
  // `value` on Scale is percent, as in AE.
  x.expression(b, "transform/scale", "value * 2");
  CHECK(x.value(b, "transform/scale", 0) == vec2(200, 200));
  // An effect parameter: effect("<label>")("<param label>") reads its stored value.
  const std::string g = x.add_effect(a, "ADBE Slider Control", "Drive");
  x.set(a, g + "/slider", scalar(66));
  const std::string gb = x.add_effect(b, "ADBE Slider Control", "Drive");
  x.expression(b, gb + "/slider", A + ".effect(\"Drive\")(\"Slider\")");
  CHECK(scalar_of(x.value(b, gb + "/slider", 0)) == 66);
}

TEST_CASE("rig: another layer's keyed property through valueAtTime / velocity / numKeys", "[expr][rig]") {
  Rig x;
  const auto a = x.layer();
  const auto b = x.layer();
  x.key(a, "transform/rotation", 0, scalar(0));
  x.key(a, "transform/rotation", 2 * kSec, scalar(100));
  const std::string g = x.add_effect(a, "ADBE Slider Control", "Speed");
  x.key(a, g + "/slider", 0, scalar(0));
  x.key(a, g + "/slider", kSec, scalar(30));
  const std::string A = "thisComp.layer(2)";  // `a`: created first, so under `b`
  CHECK(x.probe(b, "transform/rotation", A + ".transform.rotation.valueAtTime(1)") == Catch::Approx(50));
  CHECK(x.probe(b, "transform/rotation", A + ".transform.rotation.velocity", kSec) == Catch::Approx(50));
  CHECK(x.probe(b, "transform/rotation", A + ".transform.rotation.numKeys") == 2);
  CHECK(x.probe(b, "transform/rotation", A + ".transform.rotation.key(2).time") == 2);
  CHECK(x.probe(b, "transform/rotation", A + ".effect(\"Speed\")(\"Slider\").valueAtTime(1)") == Catch::Approx(30));
  CHECK(x.probe(b, "transform/rotation", A + ".effect(\"Speed\")(\"Slider\").numKeys") == 2);
  CHECK(x.probe(b, "transform/rotation", A + ".effect(\"Speed\").active ? 1 : 0") == 1);
  CHECK(x.probe(b, "transform/rotation", "thisComp.layer(1).name == thisComp.layer(1).name ? 1 : 0") == 1);
  CHECK(x.probe(b, "transform/rotation", "comp(thisComp.name).numLayers") == 2);
  CHECK(x.probe(b, "transform/rotation", "comp(\"Rig\").layer(2).transform.rotation.valueAtTime(0) + 3") == 3);
  CHECK(x.diagnostics(b, "transform/rotation", "comp(\"Nope\").width") == "error | No composition named “Nope”.");
}

TEST_CASE("rig: expression diagnostics carry the line and column", "[expr][rig][pos]") {
  Rig x;
  const auto l = x.layer();
  // SetExpression: a syntax error, stored and reported with its position.
  api::SetExpression e;
  e.prop = {l, "transform/rotation"};
  e.source = "var a = 1;\nvar b = ;";
  e.enabled = true;
  const auto r = x.h.run(cmd(e));
  REQUIRE(is_ok(r));
  const auto res = result_as<api::ExpressionResult>(r);
  CHECK_FALSE(res.ok);
  REQUIRE(res.diagnostics.size() == 1);
  CHECK(res.diagnostics[0].message == "Syntax error: Unexpected “;”.");
  CHECK(res.diagnostics[0].line == 2);
  CHECK(res.diagnostics[0].column == 9);
  // EvaluateExpression: a runtime error, with its position.
  api::EvaluateExpression q;
  q.prop = {l, "transform/rotation"};
  q.time = 0;
  q.source = "var a = 1;\n\n  a + foo";
  const auto ev = x.query<api::ExpressionEvaluation>(qry(q));
  REQUIRE(ev.diagnostics.size() == 1);
  CHECK(ev.diagnostics[0].message.starts_with("Unknown name “foo”."));
  CHECK(ev.diagnostics[0].line == 3);
  CHECK(ev.diagnostics[0].column == 7);
}
