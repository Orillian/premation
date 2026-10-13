/**
 * The first effect added after a project opens shows in Effect Controls (and
 * the Properties panel's Effects section, which draws the same body) without
 * any further change. 2026-10-13 QA, real app: after a reload into a project,
 * the added effect's card was missing until another edit.
 *
 * Why: the engine describes a group's new children only for a layer it has
 * described since its last (re)load. After openProject (documentReset) the
 * page refetches the trees it holds, but the engine's first edit of such a
 * layer sends only the root list — `effects` now lists `effects/fx_2` — and
 * nothing under it. The mirror kept a tree naming a child it had no node for,
 * so the stack skipped it. The mirror now refetches a tree left with a hole.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TooltipProvider } from '@components/Tooltip';
import { setupAppEngine, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror, resetDocumentMirror, treeHasHole } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { mirrorEffectHeaders } from '@core/mirror/effects';
import { addEffectEdit } from './effectEdits';
import { EffectControlsPanel } from './EffectControlsPanel';

class StubResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }

let h: Harness;
let dir = '';
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  dir = mkdtempSync(path.join(os.tmpdir(), 'first-effect-'));
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { cleanup(); await h.dispose(); });

const idle = async (): Promise<void> => { await act(async () => { await settleEdits(); }); };

it('the effect added first after opening a project shows its card, and the mirror tree has no hole', async () => {
  const layer = ((await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as never)) as unknown as { layer: string }).layer;
  await addEffectEdit([layer], 'gaussian-blur');
  await settleEdits();
  const file = path.join(dir, 'p.motion');
  await h.run({ type: 'saveProject', path: file, copy: false } as never);

  // A page load: a fresh mirror; the layer selected, Effect Controls open on it.
  resetDocumentMirror();
  documentMirror();
  await idle();
  useSelectionStore.setState({ ids: [layer], primary: layer } as never);
  render(<TooltipProvider><EffectControlsPanel /></TooltipProvider>);
  await idle();
  expect(screen.getByText('Gaussian Blur')).toBeTruthy();

  // The project opens (documentReset): the mirror refetches the tree it holds.
  await act(async () => { await h.run({ type: 'openProject', path: file } as never); });
  await idle();

  await act(async () => { await addEffectEdit([layer], 'directional-blur'); });
  for (let i = 0; i < 3; i++) await idle();

  const tree = documentMirror().tree(layer)!;
  expect(treeHasHole(tree)).toBe(false);
  expect(mirrorEffectHeaders(tree).map((e) => e.type)).toEqual(['gaussian-blur', 'directional-blur']);
  expect(screen.getByText('Directional Blur')).toBeTruthy();
});
