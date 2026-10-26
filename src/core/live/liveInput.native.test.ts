/**
 * Live input over the real engine (the headless build links the live port):
 * with no hand model installed, a start is accepted and then fails IN WORDS
 * that say where to install it — no camera is opened. The camera list answers
 * in either shape (cameras, or the platform's reason). The child process
 * itself is covered by native/engine/tests/test_live_host.cpp.
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useLiveInputStore } from '@stores/liveInputStore';
import { listLiveCameras, resetLiveInputForTests, startLiveInput, stopLiveInput } from './liveInput';

let h: Awaited<ReturnType<typeof setupAppEngine>>;
const savedUser = process.env.PREMATION_HAND_USER_DIR;
const savedBundled = process.env.PREMATION_HAND_DIR;

beforeEach(async () => {
  // No installed model for this engine: the case a fresh machine is in.
  delete process.env.PREMATION_HAND_USER_DIR;
  delete process.env.PREMATION_HAND_DIR;
  h = await setupAppEngine();
  resetLiveInputForTests();
});
afterEach(async () => {
  await stopLiveInput();
  await h.dispose();
  if (savedUser !== undefined) process.env.PREMATION_HAND_USER_DIR = savedUser;
  if (savedBundled !== undefined) process.env.PREMATION_HAND_DIR = savedBundled;
});

async function waitForState(state: string): Promise<void> {
  for (let i = 0; i < 100 && useLiveInputStore.getState().state !== state; i++) {
    await engineIdle();
    await new Promise((r) => setTimeout(r, 10));
  }
}

it('without the hand model, a start fails in words that point to Settings', async () => {
  expect(await startLiveInput()).toBeNull();  // accepted; the outcome is an event
  await waitForState('failed');
  const s = useLiveInputStore.getState();
  expect(s.state).toBe('failed');
  expect(s.message).toMatch(/hand tracking model is not installed/i);
  expect(s.message).toMatch(/Settings/);
});

it('lists cameras as a list, or says why it cannot', async () => {
  const r = await listLiveCameras();
  if ('cameras' in r) {
    for (const c of r.cameras) {
      expect(typeof c.id).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
    }
  } else {
    expect(r.error.length).toBeGreaterThan(0);
  }
});
