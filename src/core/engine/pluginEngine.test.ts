/**
 * pluginEngine(): plugin management from the dashboard (no editor session).
 *
 * Found on the RTX box (2026-10-13, second app instance against a local
 * backend): Dashboard ▸ Plugins installed a store plugin, but `engine()` is the
 * inert client until the editor boots, so the rescan never reached the engine
 * and the plugin's effects were missing from the Effects panel until a restart.
 */

import type { EngineBridge } from '@motion/engine-api';
import { hasEngine, pluginEngine } from './engineInstance';
import { processEngine, resetProcessEngine } from './process/processEngine';

type W = { motionEditor?: { engine?: EngineBridge } };

/** A bridge whose engine never finishes connecting: enough to see which client is used. */
function pendingBridge(): EngineBridge {
  return {
    request: () => new Promise(() => {}),
    status: () => new Promise(() => {}),
    onEvents: () => () => {},
    onState: () => () => {},
    onRestarted: () => () => {},
    onUnavailable: () => () => {},
  };
}

afterEach(async () => {
  delete (window as unknown as W).motionEditor;
  await resetProcessEngine();
});

test('without an engine bridge it is the inert client (answers busy)', async () => {
  const res = await pluginEngine().execute({ type: 'rescanPlugins' });
  expect(res.ok).toBe(false);
  expect(res.ok ? '' : res.error.message).toMatch(/No engine is running/);
});

test('with a bridge and no editor session it is the window process client, not the inert one', () => {
  (window as unknown as W).motionEditor = { engine: pendingBridge() };
  expect(hasEngine()).toBe(false);
  const client = pluginEngine();
  expect(client).toBe(processEngine());
  // One client per window: the editor session wraps this same one when it boots.
  expect(pluginEngine()).toBe(client);
});
