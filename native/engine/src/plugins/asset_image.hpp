// SDK 1.2 assets (docs/PLUGIN_SDK.md "Assets"): a FILE param's image decoded
// to linear, premultiplied RGBA float (get_asset_image / _gpu), and the files
// beside the asset (get_asset_sibling_bytes).
//
// Decoding: the host reads Radiance .hdr and binary .ppm / .pfm itself (pure
// C++, so the GPU-free host tests cover the whole path); everything else goes
// through the decoder the engine installs (set_asset_image_decoder — the
// engine's own still-image and EXR decoders, scene_finish.cpp). A decoded
// image is kept per file, size and modification time, so a re-saved file
// decodes again and an unchanged one never does twice.
#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <string_view>

#include "host.hpp"

namespace premation::plugins {

/// The image in `file`, linear premultiplied RGBA float. nullptr with `why` on failure;
/// `unsupported` = no decoder reads this kind of file. `key` = the cache key
/// (file + size + modification time), what the GPU upload is kept under.
[[nodiscard]] std::shared_ptr<const AssetImage> load_asset_image(const std::filesystem::path& file, std::string& key, std::string& why,
                                                                 bool& unsupported);

/// `relative` resolved under `asset`'s folder: a relative path ('/' or '\' separators) with no
/// "..", no root, no drive, that exists and — symlinks resolved — stays inside the folder.
/// False with `why` otherwise.
[[nodiscard]] bool resolve_sibling(const std::filesystem::path& asset, std::string_view relative, std::filesystem::path& out,
                                   std::string& why);

/// Forget every decoded image (tests).
void clear_asset_images();

}  // namespace premation::plugins
