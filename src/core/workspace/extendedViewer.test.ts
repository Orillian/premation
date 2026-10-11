/**
 * Extended Viewer (extendedViewer.ts): where a viewport draws past the comp
 * frame — the axis and custom views whenever the option is on; Active Camera
 * (and a named camera) only with Draft 3D, as After Effects 26.
 */

import { extendedViewerActive } from './extendedViewer';

describe('extendedViewerActive', () => {
  it('is off whatever the view while the option is off', () => {
    for (const mode of ['active', 'front', 'top', 'custom1', 'camera:cam_1']) {
      expect(extendedViewerActive(mode, false, false)).toBe(false);
      expect(extendedViewerActive(mode, true, false)).toBe(false);
    }
  });

  it('extends the axis and custom views', () => {
    for (const mode of ['front', 'back', 'left', 'right', 'top', 'bottom', 'custom1', 'custom2', 'custom3']) {
      expect(extendedViewerActive(mode, false, true)).toBe(true);
    }
  });

  it('extends Active Camera and a named camera only in Draft 3D', () => {
    expect(extendedViewerActive('active', false, true)).toBe(false);
    expect(extendedViewerActive('camera:cam_1', false, true)).toBe(false);
    expect(extendedViewerActive('active', true, true)).toBe(true);
    expect(extendedViewerActive('camera:cam_1', true, true)).toBe(true);
  });
});
