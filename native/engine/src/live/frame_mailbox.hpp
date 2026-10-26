// The newest camera frame, handed from the capture thread to the tracker
// (P1). Latest wins: a frame the tracker had no time for is dropped, never
// queued — a queue is latency (the spike measured 200 ms of it when capture
// and tracking shared one thread and tracking fell behind the camera).
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>

#include "camera.hpp"

namespace premation::live {

class FrameMailbox {
 public:
  /// Capture side: replace whatever is waiting. Swaps buffers, so `f` comes back with the old storage to reuse.
  void put(CameraFrame& f) {
    {
      const std::lock_guard<std::mutex> lock(m_);
      if (full_) ++dropped_;
      std::swap(slot_, f);
      full_ = true;
    }
    cv_.notify_one();
  }

  /// Tracker side: wait up to `timeout` for a frame newer than the last taken; swaps it into `out`.
  bool take(CameraFrame& out, std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(m_);
    if (!cv_.wait_for(lock, timeout, [&] { return full_ || closed_; })) return false;
    if (!full_) return false;
    std::swap(slot_, out);
    full_ = false;
    return true;
  }

  /// Wake a waiting `take` for good (shutdown).
  void close() {
    {
      const std::lock_guard<std::mutex> lock(m_);
      closed_ = true;
    }
    cv_.notify_all();
  }

  /// Frames replaced before the tracker took them.
  [[nodiscard]] std::uint64_t dropped() const {
    const std::lock_guard<std::mutex> lock(m_);
    return dropped_;
  }

 private:
  mutable std::mutex m_;
  std::condition_variable cv_;
  CameraFrame slot_;
  bool full_ = false;
  bool closed_ = false;
  std::uint64_t dropped_ = 0;
};

}  // namespace premation::live
