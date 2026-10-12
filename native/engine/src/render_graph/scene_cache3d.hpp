// E5 (docs/PROGRAM_3D_PERF_UX.md): what the 3D path keeps across runs and
// frames — the shadow maps, the SSAO buffers and the planar reflections of a
// run — so a static lit scene rebuilds none of them on its second frame, and a
// frame split into several runs by a 2D layer between 3D layers builds each
// once. A slot holds the KEY of what its device target currently shows
// (threed.cpp: the shadow camera + every caster's content and transform; the
// camera + viewport + occluders; the camera + lights + every mirrored layer).
// Equal key, target still alive (Device::target did not re-create it) = reuse.
// Owned by the SceneRenderer; render thread only. 0 = empty / never reuse.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace premation::rg {

struct SceneCache3D {
  struct Slot {
    std::uint64_t key = 0;
  };
  static constexpr std::size_t kShadowSlots = 4;
  static constexpr std::size_t kReflectionSlots = 2;
  std::array<Slot, kShadowSlots> shadow{};
  Slot ssao;
  std::array<Slot, kReflectionSlots> reflection{};

  void clear() noexcept {
    for (Slot& s : shadow) s.key = 0;
    ssao.key = 0;
    for (Slot& s : reflection) s.key = 0;
  }
};

}  // namespace premation::rg
