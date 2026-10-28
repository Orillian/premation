// A layer's on-canvas box at a time — src/core/workspace/geometry.ts
// `readGeometry` over the document (B4 round 2 `getLayerBounds`, ENGINE_API.md
// §15.12): centre position + per-kind size, rotation, scale, the ellipse flag,
// and a GROUP's box as the union of its children at the same time. The
// TypeScript twin of the query is src/core/engine/layerBoundsQuery.ts.
//
// Text is measured by the text port (TextQueries, on the frame builder's fonts);
// without it a text layer — or a group holding one — cannot be sized and the
// caller answers `unsupported`. Not ported: a plugin generator's live instance
// bounds (the TypeScript unions the last render's `latestGeneratorBounds`; here
// the emitter box stands) and text on a path's bent extent (the plain text box).
#pragma once

#include <optional>
#include <string_view>

#include "worldxf.hpp"

namespace premation {
class TextQueries;  // scene/session_hooks.hpp
}

namespace premation::doc {

struct LayerGeometry {
  double x = 0;
  double y = 0;
  double rotationDeg = 0;
  /// Base (unscaled) size, px.
  double width = 0;
  double height = 0;
  double scaleX = 1;
  double scaleY = 1;
  bool ellipse = false;
  /// Where the box centre sits relative to the layer origin, local px (a group's union, text's font box).
  double offsetX = 0;
  double offsetY = 0;
};

/// `readGeometry(node, animatedValuesAt(seconds))` with a group's union at `seconds`;
/// nullopt for a kind with no canvas box (audio, adjustment) or a missing node.
/// `text` null + a text layer in the way → throws EngineFail `unsupported`.
[[nodiscard]] std::optional<LayerGeometry> layer_geometry_at(const SpaceCtx& c, TextQueries* text, std::string_view node,
                                                             double seconds);

/// The box of what the layer SHOWS: `layer_geometry_at` trimmed to what its
/// masks (mode, Inverted, Expansion, Feather) and a cutting subject matte (the
/// Object Matte / Roto Brush cut-out, by its traced outline) leave visible.
/// After Effects keeps a masked layer's box at its source size; the editor's
/// selection box, Centre Anchor, Align and getLayerBounds use this, so a
/// small cut-out subject is handled as the subject. Source-size users (jobs,
/// plugin frames, Fit to Comp) keep `layer_geometry_at`.
[[nodiscard]] std::optional<LayerGeometry> visible_geometry_at(const SpaceCtx& c, TextQueries* text, std::string_view node,
                                                               double seconds);

/// Whether a point in the layer's box space (centre origin, before the anchor)
/// lies in what its masks and cutting matte leave visible: click selection
/// passes through the cut-away part to the layers underneath. True when
/// nothing cuts.
[[nodiscard]] bool visible_contains(const SpaceCtx& c, std::string_view node, double seconds, double x, double y);

}  // namespace premation::doc
