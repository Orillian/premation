/**
 * U1: the viewport says what a camera drag edits — the shot (Active Camera /
 * a camera view, "· keyframing" when the drag will key it) or only the
 * preview (custom / orthographic views) — while a camera tool is armed or Alt
 * is held, and nothing otherwise.
 */

import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';
import type { Keyframe } from '@motion/engine-api';
import { compTime } from '@core/engine/propRefs';
import { setupAppEngine, propRef } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { cameraViewMode } from '@core/scene/cameraViewMode';
import { CameraNavBadge, cameraNavBadgeText } from './CameraNavBadge';

let h: Harness;
let CAM = '';

beforeEach(async () => {
  h = await setupAppEngine();
  usePreferenceStore.getState().set('timelineAutoKeyframe', false);
  useGuidesStore.setState({ camera3dMode: 'active', cameraTool: 'none' });
  await act(async () => {
    ({ layer: CAM } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Camera 1', init: [] }));
    await engineIdle();
    await documentMirror().loadTree(CAM);
  });
});
afterEach(async () => {
  cleanup();
  useGuidesStore.setState({ camera3dMode: 'active', cameraTool: 'none' });
  await h.dispose();
});

const badge = (): string | null => document.querySelector('[data-camera-nav-badge]')?.textContent ?? null;
const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); await documentMirror().whenIdle(); }); };

describe('cameraNavBadgeText', () => {
  it('names the camera and the consequence, or the view and "preview only"', () => {
    expect(cameraNavBadgeText({ mode: 'active', cameraName: 'Camera 1', keyframing: false, viewLabel: 'Active Camera' })).toBe('Camera 1 · moves the shot');
    expect(cameraNavBadgeText({ mode: 'active', cameraName: 'Camera 1', keyframing: true, viewLabel: 'Active Camera' })).toBe('Camera 1 · moves the shot · keyframing');
    expect(cameraNavBadgeText({ mode: 'custom1', cameraName: null, keyframing: false, viewLabel: 'Custom View 1' })).toBe('Custom View 1 · preview only');
    expect(cameraNavBadgeText({ mode: 'front', cameraName: null, keyframing: false, viewLabel: 'Front' })).toBe('Front · preview only');
    // No camera to look through: a drag moves nothing, so there is nothing to say.
    expect(cameraNavBadgeText({ mode: 'active', cameraName: null, keyframing: false, viewLabel: 'Active Camera' })).toBeNull();
  });
});

describe('the badge', () => {
  it('shows only while a camera tool is armed or Alt is held', async () => {
    render(<CameraNavBadge />);
    expect(badge()).toBeNull();

    act(() => { useGuidesStore.getState().setCameraTool('orbit'); });
    expect(badge()).toBe('Camera 1 · moves the shot');
    act(() => { useGuidesStore.getState().setCameraTool('none'); });
    expect(badge()).toBeNull();

    fireEvent.keyDown(window, { key: 'Alt' });
    expect(badge()).toBe('Camera 1 · moves the shot');
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(badge()).toBeNull();
    fireEvent.keyDown(window, { key: 'Alt' });
    fireEvent.blur(window);
    expect(badge()).toBeNull();
  });

  it('in a camera view names that camera; in a custom view says the drag is preview only', async () => {
    render(<CameraNavBadge />);
    act(() => { useGuidesStore.getState().setCameraTool('unified'); });
    act(() => { useGuidesStore.getState().setCamera3dMode(cameraViewMode(CAM)); });
    expect(badge()).toBe('Camera 1 · moves the shot');
    act(() => { useGuidesStore.getState().setCamera3dMode('custom1'); });
    expect(badge()).toBe('Custom View 1 · preview only');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('adds "· keyframing" under Auto-Keyframe, and when a navigation track is animated', async () => {
    render(<CameraNavBadge />);
    act(() => { useGuidesStore.getState().setCameraTool('orbit'); });
    expect(badge()).toBe('Camera 1 · moves the shot');

    act(() => { usePreferenceStore.getState().set('timelineAutoKeyframe', true); });
    expect(badge()).toBe('Camera 1 · moves the shot · keyframing');
    act(() => { usePreferenceStore.getState().set('timelineAutoKeyframe', false); });
    expect(badge()).toBe('Camera 1 · moves the shot');

    const key = (t: number, v: number): Keyframe => ({
      id: '', time: compTime(t), value: { kind: 'scalar', value: v }, easing: 'linear',
      continuous: false, roving: false, spatialInterp: 'linear', spatialIn: [], spatialOut: [], label: 0, dims: [],
    });
    const prop = await propRef(CAM, 'orbitYaw');
    await act(async () => { await h.run({ type: 'setKeyframes', prop, keys: [key(0, 0), key(1, 30)] }); });
    await idle();
    expect(badge()).toBe('Camera 1 · moves the shot · keyframing');

    // A custom view never keys anything, whatever the camera's state.
    act(() => { useGuidesStore.getState().setCamera3dMode('custom2'); });
    expect(badge()).toBe('Custom View 2 · preview only');
  });
});
