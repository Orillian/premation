// Live camera capture for performance input (P1). The OS API lives only in
// camera_ffi_*.cpp: Media Foundation on Windows; other platforms build the
// stub until their capture lands (macOS: AVFoundation, a later row).
//
// Frames arrive as top-down BGRA8. Each carries two times on ONE clock
// (`now_ns`, the OS performance counter): when the driver says the sensor
// captured it, and when it reached us — the difference is the driver's own
// delay, the first term of the camera → keyframe latency (plan §3.3).
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace premation::live {

struct CameraDevice {
  /// Stable id to open it by (the OS's symbolic link).
  std::string id;
  std::string name;
};

struct CameraFrame {
  std::vector<std::uint8_t> bgra;
  int width = 0;
  int height = 0;
  int stride = 0;
  /// When the sensor captured the frame, `now_ns` clock; 0 when the driver does not say.
  std::int64_t captureNs = 0;
  /// When the frame reached this process, `now_ns` clock.
  std::int64_t arrivalNs = 0;
};

class Camera {
 public:
  Camera() = default;
  virtual ~Camera() = default;
  Camera(const Camera&) = delete;
  Camera& operator=(const Camera&) = delete;
  Camera(Camera&&) = delete;
  Camera& operator=(Camera&&) = delete;

  /// Block until the next frame. False on an error (the device went away, …).
  virtual bool read(CameraFrame& frame, std::string& error) = 0;
  [[nodiscard]] virtual int width() const noexcept = 0;
  [[nodiscard]] virtual int height() const noexcept = 0;
  [[nodiscard]] virtual double fps() const noexcept = 0;
  /// The sensor format chosen ("NV12", "YUY2", "MJPG", …).
  [[nodiscard]] virtual std::string format() const = 0;
  [[nodiscard]] virtual std::string name() const = 0;
  /// Every format the sensor offers, one "FMT WxH @ fps" line each (diagnostics).
  [[nodiscard]] virtual std::vector<std::string> formats() const = 0;
};

/// The capture devices, in the OS's order. Empty with `error` set when the OS refuses.
[[nodiscard]] std::vector<CameraDevice> list_cameras(std::string& error);

struct CameraRequest {
  /// A device id from list_cameras, or '' for the first one whose name does not mark it infrared / depth.
  std::string id;
  /// Frame width delivered to the tracker. The sensor format is chosen for
  /// rate first; when it is wider, the OS scales it down before we see it —
  /// 640 is plenty for hands, and every later step costs per pixel.
  int width = 640;
  /// Preferred rate; the highest the device offers up to this.
  double fps = 60;
};

[[nodiscard]] std::unique_ptr<Camera> open_camera(const CameraRequest& request, std::string& error);

/// The clock frames are stamped on, ns (monotonic).
[[nodiscard]] std::int64_t now_ns() noexcept;

/// An environment variable as UTF-8 ('' when unset). Windows: read wide — a
/// user folder with non-ASCII characters does not survive the ANSI getenv.
[[nodiscard]] std::string env_utf8(const char* name);

}  // namespace premation::live
