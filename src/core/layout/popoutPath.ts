/**
 * The route a pop-out window shows a panel at: `#/popout/<segment>`.
 *
 * A panel id is one path segment only when it is encoded: a native plugin's
 * panel is `plugin:<plugin id>/<panel>` (P7d), and its '/' would otherwise
 * split the route so `/popout/:panelId` never matched. Electron main encodes
 * the id it is handed (`popout:spawnWindow`); the in-browser fallback builds
 * the same URL here; the route decodes it back.
 */

/** The encoded route segment for `panelId`. */
export function popoutSegment(panelId: string): string {
  return encodeURIComponent(panelId);
}

/** The hash a pop-out of `panelId` opens at. */
export function popoutHash(panelId: string): string {
  return `#/popout/${popoutSegment(panelId)}`;
}

/**
 * The panel id from the route's `:panelId` (or a raw segment of the location).
 * Decoding twice is harmless: panel ids never contain '%' (plugin ids are
 * `A-Z a-z 0-9 . _ -`), so a value the router already decoded comes back as is.
 */
export function panelIdFromPopoutSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
