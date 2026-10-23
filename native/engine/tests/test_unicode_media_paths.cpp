// Footage named outside the ANSI code page (user report 2026-10-23: a
// Japanese user's `ダウンロード (15).png` layers crash-looped the engine when the
// project opened). The document's paths are UTF-8; on Windows
// `std::filesystem::path(std::string)` and `path::string()` go through the
// ANSI code page instead, and throw on a name it cannot spell.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <system_error>

#include "image_decode.hpp"
#include "media_paths.hpp"

namespace sc = premation::scene;
namespace fs = std::filesystem;

namespace {

/// "ダウンロード (15).png" as the document holds it (UTF-8).
const std::string kName = "\xE3\x83\x80\xE3\x82\xA6\xE3\x83\xB3\xE3\x83\xAD\xE3\x83\xBC\xE3\x83\x89 (15).png";

fs::path u8(const std::string& s) { return {std::u8string(s.begin(), s.end())}; }

/// A 1×1 RGBA PNG.
constexpr std::array<std::uint8_t, 70> kPng = {
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x05, 0x02, 0x00,
    0x5f, 0xc8, 0xf1, 0xd2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};

}  // namespace

TEST_CASE("unicode media: a file URL's path is read as UTF-8, whatever the code page", "[scene][unicode]") {
  // %-encoded, as the desktop app writes local-file:// URLs.
  const fs::path p = sc::file_url_fs_path(
      "file:///C:/x/%E3%83%80%E3%82%A6%E3%83%B3%E3%83%AD%E3%83%BC%E3%83%89%20(15).png");
  CHECK(sc::utf8_path(p) == "C:/x/" + kName);
  CHECK(p.filename() == u8(kName));
  CHECK(sc::utf8_path(p.lexically_normal()) == sc::utf8_path(u8("C:/x/" + kName).lexically_normal()));
}

TEST_CASE("unicode media: a Japanese-named still decodes, and a missing one fails without throwing", "[scene][unicode]") {
  const fs::path dir = fs::temp_directory_path() / u8("premation-unicode-" + std::to_string(std::random_device{}()));
  fs::create_directories(dir);
  const fs::path file = dir / u8(kName);
  {
    std::ofstream out(file, std::ios::binary);
    out.write(reinterpret_cast<const char*>(kPng.data()), static_cast<std::streamsize>(kPng.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes out
  }
  sc::DecodedImage img;
  std::string error;
  CHECK(sc::decode_image_file(file, img, error));
  CHECK(error.empty());
  CHECK(img.width == 1);
  CHECK(img.height == 1);

  // The failure message names the file in UTF-8 (path::string() threw here).
  sc::DecodedImage none;
  std::string why;
  bool decoded = true;
  REQUIRE_NOTHROW(decoded = sc::decode_image_file(dir / u8("missing " + kName), none, why));
  CHECK_FALSE(decoded);
  CHECK(why.find(kName) != std::string::npos);

  std::error_code ec;
  fs::remove_all(dir, ec);
}
