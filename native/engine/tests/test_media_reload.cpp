// Footage reload log (scene/media_reload.hpp): every viewport drawer sees each
// reload once, a new drawer sees none from before it, and a drawer that fell
// behind the bounded log forgets every source.
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <string>
#include <vector>

#include "media_reload.hpp"

using premation::scene::MediaReloadLog;

TEST_CASE("media reload log: each drawer drains each reload once", "[scene][media][reload]") {
  MediaReloadLog& log = MediaReloadLog::instance();
  std::uint64_t a = log.generation();
  std::uint64_t b = log.generation();
  (void)log.post({"C:/m/one.mov"});
  (void)log.post({"C:/m/two.png", "C:/m/two.psd"});
  const auto first = log.take(a);
  CHECK_FALSE(first.everything);
  CHECK(first.paths == std::vector<std::string>{"C:/m/one.mov", "C:/m/two.png", "C:/m/two.psd"});
  CHECK(log.take(a).paths.empty());  // nothing new for the same drawer
  CHECK(log.take(b).paths.size() == 3);  // the other drawer still sees both reloads
  std::uint64_t late = log.generation();  // a drawer made after them sees neither
  CHECK(log.take(late).paths.empty());
}

TEST_CASE("media reload log: a drawer behind the bounded log forgets everything", "[scene][media][reload]") {
  MediaReloadLog& log = MediaReloadLog::instance();
  std::uint64_t behind = log.generation();
  for (int i = 0; i < 100; ++i) (void)log.post({"C:/m/f" + std::to_string(i) + ".png"});
  const auto p = log.take(behind);
  CHECK(p.everything);
  CHECK(behind == log.generation());
}
