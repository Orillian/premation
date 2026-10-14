/**
 * U7: the Orbit tool's tooltip names which of the camera Inspector's two
 * "rotations" its drag writes — "Orbit around target", never "Turn on the spot".
 */

import { CAMERA_TOOLS, cameraToolTitle } from './SceneControls';

describe('camera tool tooltips', () => {
  it('the Orbit tool (and the Unified tool\'s left-drag) say they write Orbit around target', () => {
    expect(cameraToolTitle('orbit')).toContain('writes Orbit around target');
    expect(cameraToolTitle('orbit')).toContain('never Turn on the spot');
    expect(cameraToolTitle('unified')).toContain('Orbit around target');
  });

  it('every tool says what its drag writes; none armed says so', () => {
    for (const t of CAMERA_TOOLS) expect(cameraToolTitle(t.id)).toContain(t.writes);
    expect(cameraToolTitle('none')).toMatch(/^Camera tool — none armed/);
  });
});
