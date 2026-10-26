// Live camera capture — the stub for platforms whose capture has not landed
// (camera.hpp). Lists nothing and refuses to open, with the reason.
#include "camera.hpp"

#include <chrono>
#include <cstdlib>

namespace premation::live {

std::vector<CameraDevice> list_cameras(std::string& error) {
  error = "live camera input is not available on this platform yet";
  return {};
}

std::unique_ptr<Camera> open_camera(const CameraRequest& /*request*/, std::string& error) {
  error = "live camera input is not available on this platform yet";
  return nullptr;
}

std::string env_utf8(const char* name) {
  const char* v = std::getenv(name);
  return v != nullptr ? std::string(v) : std::string();
}

std::int64_t now_ns() noexcept {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

}  // namespace premation::live
