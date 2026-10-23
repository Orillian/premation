// Document media sources as file paths, GPU-free (media_paths.cpp): shared by
// the texture feed (scene_textures.hpp) and the model registry (gltf_model.cpp).
#pragma once

#include <filesystem>
#include <string>
#include <string_view>

namespace premation::scene {

/// A document media `src` as a file path: `file://` and the desktop app's
/// `local-file://` URLs decoded; anything else returned unchanged.
[[nodiscard]] std::string file_url_path(std::string_view src);

/// `file_url_path` as a filesystem path, read as UTF-8 (what the document holds).
/// Never `std::filesystem::path(std::string)`: on Windows that reads the bytes in
/// the ANSI code page, and on a Japanese system (932) a UTF-8 name like
/// `ダウンロード.png` throws (or names another file elsewhere).
[[nodiscard]] std::filesystem::path file_url_fs_path(std::string_view src);

/// A path as UTF-8 bytes, never the ANSI code page (`path::string()` throws on a
/// name the code page cannot spell).
[[nodiscard]] std::string utf8_path(const std::filesystem::path& p);

}  // namespace premation::scene
