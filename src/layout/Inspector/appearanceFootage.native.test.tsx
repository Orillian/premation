/**
 * Properties ▸ Appearance (Roundness, Fill 1, Stroke 1) is a shape's paint. It
 * appeared on footage — every layer carries the generic Style component — as
 * controls the renderer never reads (docs/PROGRAM_PERFORMANCE.md V8). After
 * Effects shows no Contents on a footage layer either.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { render, cleanup } from '@testing-library/react';
import { AppearanceSection } from './AppearanceSection';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';

jest.useFakeTimers();

let h: Harness;

function still(): string {
  const dir = path.join(os.tmpdir(), 'premation-test-clips');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'appearance-still.png');
  const png = new PNG({ width: 8, height: 8 });
  png.data.fill(200);
  writeFileSync(file, PNG.sync.write(png));
  return file;
}

beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => {
  cleanup();
  await h.dispose();
});

describe('the Appearance section', () => {
  it('is not shown on an image layer', async () => {
    const { items } = await h.run({ type: 'importFiles', files: [{ path: still(), asSequence: false, createComposition: false }] });
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'image', source: items[0]!, init: [] });
    await documentMirror().loadTree(layer);
    expect(documentMirror().tree(layer)?.nodes.has('layer/cornersLinked')).toBe(true);
    const { container } = render(<AppearanceSection nodeId={layer} />);
    expect(container.textContent).toBe('');
  });

  it('is shown on a shape layer', async () => {
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Box', init: [] });
    await documentMirror().loadTree(layer);
    const { container } = render(<AppearanceSection nodeId={layer} />);
    expect(container.textContent).not.toBe('');
  });
});
