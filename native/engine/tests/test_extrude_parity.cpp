// Cross-engine extrusion parity (tests/data/extrude_parity.json, frozen from
// the TypeScript engine's extrudeCrossEngine.test.ts): every recipe — rect,
// rounded rect, ellipse, Bézier runs with a hole, a traced bitmap — × extrusion
// options through the C++ port must give the editor's mesh: same counts, ranges
// and clamped bevel, and the same FNV-1a 64 over the exact vertex / index
// bytes. PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "extrude_mesh.hpp"
#include "json.hpp"
#include "parity_rebless.hpp"

namespace m = premation::scene::mesh;
using premation::js::Json;

namespace {

std::string fnv1a64(const std::uint8_t* p, std::size_t n) {
  std::uint64_t h = 0xcbf29ce484222325ULL;
  for (std::size_t i = 0; i < n; ++i) {
    h ^= p[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    h *= 0x100000001b3ULL;
  }
  std::array<char, 17> out{};
  std::snprintf(out.data(), out.size(), "%016llx", static_cast<unsigned long long>(h));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return std::string(out.data());
}

std::vector<m::Ring> rings_of(const Json& o) {
  const std::string kind = o.at("kind").str();
  if (kind == "rect") {
    const auto& r = o.at("radii").arr();
    return m::rect_outline(o.at("width").num(), o.at("height").num(), {r[0].num(), r[1].num(), r[2].num(), r[3].num()},
                           static_cast<int>(o.at("segmentsPer90").num()));
  }
  if (kind == "ellipse") {
    std::optional<int> seg;
    if (o.at("segments").is_number()) seg = static_cast<int>(o.at("segments").num());
    return m::ellipse_outline(o.at("width").num(), o.at("height").num(), seg);
  }
  if (kind == "runs") {
    std::vector<m::BezRun> runs;
    for (const Json& r : o.at("runs").arr()) {
      m::BezRun run;
      run.open = r.at("open").b();
      for (const Json& p : r.at("points").arr()) {
        const auto& a = p.arr();
        run.points.push_back({a[0].num(), a[1].num(), a[2].num(), a[3].num(), a[4].num(), a[5].num()});
      }
      runs.push_back(std::move(run));
    }
    return m::bezier_runs_to_rings(runs, o.at("tolerance").num());
  }
  // bitmap
  std::vector<std::uint8_t> alpha;
  for (const Json& v : o.at("alpha").arr()) alpha.push_back(static_cast<std::uint8_t>(v.num()));
  m::TraceOptions to;
  to.threshold = o.at("threshold").num();
  to.tolerance = o.at("tolerance").num();
  to.minArea = o.at("minArea").num();
  std::vector<m::Ring> rings;
  for (m::TracedContour& c : m::trace_bitmap(alpha, static_cast<int>(o.at("width").num()), static_cast<int>(o.at("height").num()), 1, to)) {
    rings.push_back({std::move(c.points), c.hole});
  }
  return rings;
}

m::ExtrudeOptions options_of(const Json& j) {
  m::ExtrudeOptions o;
  o.depth = j.at("depth").num();
  if (j.at("bevel").is_number()) o.bevel = j.at("bevel").num();
  if (j.at("bevelStyle").is_string()) {
    const std::string s = j.at("bevelStyle").str();
    o.bevelStyle = s == "concave" ? m::BevelProfile::concave : s == "convex" ? m::BevelProfile::convex : m::BevelProfile::angular;
  }
  if (j.at("bevelSegments").is_number()) o.bevelSegments = j.at("bevelSegments").num();
  if (j.at("smoothAngleDeg").is_number()) o.smoothAngleDeg = j.at("smoothAngleDeg").num();
  if (j.at("frontCap").is_bool()) o.frontCap = j.at("frontCap").b();
  if (j.at("frontBevel").is_bool()) o.frontBevel = j.at("frontBevel").b();
  if (j.at("holeBevelScale").is_number()) o.holeBevelScale = j.at("holeBevelScale").num();
  if (j.at("backCap").is_bool()) o.backCap = j.at("backCap").b();
  if (j.at("uvBox").is_object()) {
    const Json& b = j.at("uvBox");
    o.uvBox = m::Box{b.at("x").num(), b.at("y").num(), b.at("width").num(), b.at("height").num()};
  }
  return o;
}

const char* role_name(m::MeshRole r) {
  switch (r) {
    case m::MeshRole::back: return "back";
    case m::MeshRole::side: return "side";
    case m::MeshRole::bevel: return "bevel";
    default: return "front";
  }
}

}  // namespace

TEST_CASE("extrusion parity: the C++ port builds the editor's extruded meshes", "[scene][extrude][parity]") {
  premation::test::JsonFixture fx("extrude_parity.json");
  REQUIRE(fx.ok());
  auto& rows = fx.root().find_mut("rows")->arr_mut();
  REQUIRE(rows.size() >= 9);
  for (Json& row : rows) {
    INFO(row.at("name").str());
    const std::vector<m::Ring> rings = rings_of(row.at("outline"));
    const std::optional<m::ExtrudedMesh> mesh = m::extrude_outline(rings, options_of(row.at("opts")));
    if (!mesh) {
      CHECK(fx.answer(row, "mesh", Json::null()));
      continue;
    }
    Json::Array ranges;
    for (const auto& r : mesh->ranges) {
      ranges.push_back(Json::object(Json::Object{{"role", Json::string(role_name(r.role))},
                                                 {"first", Json::number(r.first)},
                                                 {"count", Json::number(r.count)}}));
    }
    std::vector<std::uint8_t> idx;
    if (mesh->index32) {
      idx.resize(mesh->indices.size() * 4);
      std::memcpy(idx.data(), mesh->indices.data(), idx.size());
    } else {
      idx.resize(mesh->indices.size() * 2);
      for (std::size_t i = 0; i < mesh->indices.size(); ++i) {
        const auto v = static_cast<std::uint16_t>(mesh->indices[i]);
        std::memcpy(idx.data() + i * 2, &v, 2);
      }
    }
    const std::string verticesFnv =
        fnv1a64(reinterpret_cast<const std::uint8_t*>(mesh->vertices.data()), mesh->vertices.size() * sizeof(float));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    CHECK(fx.answer(row, "mesh",
                    Json::object(Json::Object{{"vertexCount", Json::number(mesh->vertexCount)},
                                              {"indexCount", Json::number(static_cast<double>(mesh->indices.size()))},
                                              {"index32", Json::boolean(mesh->index32)},
                                              {"bevel", Json::number(mesh->bevel)},
                                              {"ranges", Json::array(std::move(ranges))},
                                              {"verticesFnv", Json::string(verticesFnv)},
                                              {"indicesFnv", Json::string(fnv1a64(idx.data(), idx.size()))}})));
  }
  REQUIRE(fx.finish());
}

namespace {

double tri_area(const m::Triangulation& tr) {
  double a = 0;
  for (std::size_t i = 0; i + 2 < tr.triangles.size(); i += 3) {
    const m::Pt2 p = tr.vertices[tr.triangles[i]];
    const m::Pt2 q = tr.vertices[tr.triangles[i + 1]];
    const m::Pt2 r = tr.vertices[tr.triangles[i + 2]];
    a += std::abs(((q.x - p.x) * (r.y - p.y)) - ((q.y - p.y) * (r.x - p.x))) / 2;
  }
  return a;
}

/// Area of the triangles of one role, projected on the cap plane.
double role_area(const m::ExtrudedMesh& mesh, m::MeshRole role) {
  double a = 0;
  for (const auto& r : mesh.ranges) {
    if (r.role != role) continue;
    for (std::uint32_t i = r.first; i + 2 < r.first + r.count; i += 3) {
      const auto at = [&](std::uint32_t k) {
        const std::size_t o = static_cast<std::size_t>(mesh.indices[k]) * m::kMeshVertexFloats;
        return m::Pt2{mesh.vertices[o], mesh.vertices[o + 1]};
      };
      const m::Pt2 p = at(i);
      const m::Pt2 q = at(i + 1);
      const m::Pt2 s = at(i + 2);
      a += std::abs(((q.x - p.x) * (s.y - p.y)) - ((q.y - p.y) * (s.x - p.x))) / 2;
    }
  }
  return a;
}

}  // namespace

// The traced "T": the two inner corners under the bar sit ON the bar's
// underside, and the strict-inside ear test clipped the whole bar through them
// — the back cap spilled a wedge outside the glyph beside the stem.
TEST_CASE("cap triangulation: collinear reflex corners block an ear (the 3D T)", "[scene][extrude]") {
  const std::vector<m::Pt2> T{{8.2, 10.8}, {48.0, 10.8}, {48.0, 17.0}, {30.8, 17.0},
                              {30.8, 56.0}, {24.2, 56.0}, {24.2, 17.0}, {8.2, 17.0}};
  for (const bool reversed : {false, true}) {
    std::vector<m::Pt2> ring = T;
    if (reversed) std::ranges::reverse(ring);
    const m::Triangulation tr = m::triangulate_rings(ring, {});
    CHECK(std::abs(tri_area(tr) - std::abs(m::signed_area(ring))) < 1e-6);
  }
  // An "E" (three collinear arm roots on the spine).
  const std::vector<m::Pt2> E{{0, 0},   {30, 0},  {30, 5},  {6, 5},  {6, 12}, {24, 12},
                              {24, 17}, {6, 17},  {6, 25},  {30, 25}, {30, 30}, {0, 30}};
  const m::Triangulation te = m::triangulate_rings(E, {});
  CHECK(std::abs(tri_area(te) - std::abs(m::signed_area(E))) < 1e-6);
}

// An "o" whose band (4 px) is thinner than twice the asked bevel: the hole's
// inset used to cross the outer one, the hole was lost and the caps filled the
// counter. The bevel clamps to the band and the counter stays open.
TEST_CASE("bevel clamps to the band between an outline and its hole", "[scene][extrude]") {
  std::vector<m::Ring> rings = m::ellipse_outline(40, 40, 48);
  std::vector<m::Ring> inner = m::ellipse_outline(32, 32, 48);
  inner[0].hole = true;
  rings.push_back(inner[0]);
  m::ExtrudeOptions o;
  o.depth = 20;
  o.bevel = 6;
  o.frontCap = true;
  const std::optional<m::ExtrudedMesh> mesh = m::extrude_outline(rings, o);
  REQUIRE(mesh);
  CHECK(mesh->bevel < 2);
  const double band = std::abs(m::signed_area(rings[0].points)) - std::abs(m::signed_area(rings[1].points));
  CHECK(role_area(*mesh, m::MeshRole::back) <= band + 1e-3);
  CHECK(role_area(*mesh, m::MeshRole::front) <= band + 1e-3);
}
