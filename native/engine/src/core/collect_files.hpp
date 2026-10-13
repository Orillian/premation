// collectFiles (ENGINE_API.md §4.1, File ▸ Dependencies ▸ Collect Files): a
// COPY of the project and every file it uses, written into one folder.
//
// The layout is the TypeScript port's (appPorts.ts `collectFiles`): one
// `.motion` directory bundle `<folder>/<folder name>.motion` (bundle_io.hpp),
// its footage inside it content-addressed — so the collected folder is
// self-contained and can be moved to another machine:
//
//   <folder>/<name>.motion/
//     scene.json … manifest.json      the document's chunks, manifest last
//     assets/registry.json            one row per collected file
//     blobs/<hh>/<sha256>             every file the document uses
//
// What is collected: each component's `src` / `__src` (with its `assetId` /
// `__assetId` item: the item's file — its `path` on disk — wins over a session
// `blob:` src, as the jobs read footage), `motion-blob:` footage from the
// bundle the document lives in, footage items' user-supplied proxies and,
// unless `onlyUsed`, the files of items no layer uses. In the COPY every
// collected src becomes `motion-blob:<sha256>` and each collected item loses
// its outside `path` (nothing in the copy points outside the folder).
// `onlyUsed` also drops unused footage items from the copy (removeUnusedItems'
// rule: an item no layer uses).
//
// Items the content-addressed layout would break keep a name: a native SDK
// effect's FILE param item (and the files beside it the plugin lists through
// PR_CMD_LIST_ASSET_FILES — a .gltf's .bin and textures), and footage a plugin
// importer reads by its extension. Their record becomes
//   `path: "motion-blob:<sha>"`,
//   `collected: { name: "<file name with extension>", siblings: { "<relative>": "motion-blob:<sha>" } }`
// and materialize_collected() lays the files out again under their names when
// a real path is needed (reopen, an export's snapshot). `data:` / `http(s):` / `/files/` srcs travel as
// they are (the TypeScript collector leaves them too). A file that cannot be
// read is reported in `missing` and its reference kept — one bad file never
// fails the collect. Fonts are not collected (the TypeScript collector does not
// either); nor are image sequences, which the document has no form for.
//
// The open document is never touched: the Session hands in a captured copy.
// Refused: an empty folder, a target that is the open project or its bundle, a
// folder inside the project's bundle, a target that exists and is not a bundle.
//
// I/O goes through CollectIo so the same planner runs on disk (FilePorts) and
// in memory (FakePorts, tests).
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"

namespace premation::doc {

/// The file side of a collect.
class CollectIo {
 public:
  CollectIo() = default;
  virtual ~CollectIo() = default;
  CollectIo(const CollectIo&) = delete;
  CollectIo& operator=(const CollectIo&) = delete;
  CollectIo(CollectIo&&) = delete;
  CollectIo& operator=(CollectIo&&) = delete;

  /// The bytes a document reference names (a src or a path, as the document
  /// holds it — `motion-blob:` in `sourceBundle`, `file://`, a plain path, …).
  /// False with `why` set when it cannot be read.
  virtual bool read(std::string_view ref, const std::string& sourceBundle, std::string& bytes, std::string& why) = 0;
  /// `path` made absolute and normal (for the "is it the project?" checks), '/' separators.
  [[nodiscard]] virtual std::string normal(const std::string& path) = 0;
  enum class Target : std::uint8_t { absent, bundle, other };
  [[nodiscard]] virtual Target target(const std::string& path) = 0;
  /// Store one collected file as `<bundle>/blobs/<hh>/<hash>`; the bytes written (0 when already there).
  virtual std::uint64_t put_blob(const std::string& bundle, const std::string& hash, std::string_view bytes) = 0;
  /// Write the registry, then the document's chunks (manifest last); the bytes written.
  virtual std::uint64_t write_bundle(const std::string& bundle, const js::Json& doc, const js::Json& registry) = 0;
  /// The file on disk a reference names ('' when it is not a file) — what a plugin is shown when it
  /// lists the files beside an asset. Default: the jobs' footage resolution.
  [[nodiscard]] virtual std::string file_of(std::string_view ref, const std::string& sourceBundle);
};

struct CollectRequest {
  std::string folder;
  bool onlyUsed = false;
  /// The captured document (a copy; rewritten in place).
  js::Json doc;
  /// Footage item ids no layer uses (removeUnusedItems' rule).
  std::set<std::string, std::less<>> unusedItems;
  /// The bundle the document's `motion-blob:` footage lives in ('' = none).
  std::string sourceBundle;
  /// The open project's file ('' = untitled).
  std::string projectPath;
};

struct CollectOutcome {
  std::string path;
  std::uint64_t bytes = 0;
  /// References that could not be collected, one line each ("<name>: <why>").
  std::vector<std::string> missing;
  /// Files copied into the bundle.
  std::size_t collected = 0;
};

/// `<folder>/<folder name>.motion` ("Project.motion" for a root folder).
[[nodiscard]] std::string collect_target(std::string_view folder);

/// Run a collect. Throws EngineFail: invalidArgument for a refused target, io
/// when writing fails (the source project is never written).
[[nodiscard]] CollectOutcome collect_files(CollectRequest req, CollectIo& io);

/// A collected item's files laid out under their names — `<temp>/premation-collected/<key>/<name>`
/// and its siblings at their relative paths beside it — and the main file's path. `record` is the
/// item (`path` + `collected`); its references resolve against `bundleRoot` (`motion-blob:`) or as
/// files (an export's snapshot, already absolute). The folder is content-addressed (the files'
/// hashes and names), so the same item lands in the same place and is written once. nullopt + `why`
/// when the record is not a collected item or a file cannot be read.
[[nodiscard]] std::optional<std::string> materialize_collected(const js::Json& record, std::string_view bundleRoot,
                                                               std::string* why = nullptr);

/// The disk implementation (std::filesystem, temp + rename — bundle_io.hpp).
[[nodiscard]] std::unique_ptr<CollectIo> make_disk_collect_io();

}  // namespace premation::doc
