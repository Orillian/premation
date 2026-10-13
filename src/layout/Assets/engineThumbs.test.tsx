/**
 * A `.ppm` imported through a plugin (ppmio) showed a broken image in the
 * Project panel (2026-10-13 QA): the panel handed the file to an `<img>`,
 * which cannot decode it. An image the page cannot decode — or whose `<img>`
 * fails — is the engine's thumbnail (getThumbnail of the item: the importer
 * the render uses); an engine without one leaves the type glyph.
 */

import { act, fireEvent, render } from '@testing-library/react';
import type { ImportedAsset } from '@stores/assetStore';
import { engine } from '@core/engine/engineInstance';
import { AssetThumb } from './AssetThumb';
import { browserDecodes, resetEngineThumbsForTest } from './engineThumbs';

jest.mock('@core/engine/engineInstance', () => ({ engine: jest.fn() }));

const query = jest.fn();
beforeAll(() => {
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:engine-thumb';
});
beforeEach(() => {
  resetEngineThumbsForTest();
  query.mockReset();
  jest.mocked(engine).mockReturnValue({ query } as never);
});

const asset = (name: string, id = name): ImportedAsset => ({ id, name, type: 'image', src: `local-file:///C:/m/${name}`, size: 1 } as ImportedAsset);
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

it('decides by extension what the page decodes', () => {
  expect(browserDecodes('a.PNG')).toBe(true);
  expect(browserDecodes('local-file:///x/b.jpeg?v=2')).toBe(true);
  expect(browserDecodes('test.ppm')).toBe(false);
  expect(browserDecodes('plate.exr')).toBe(false);
});

it('a .ppm is drawn from the engine\'s thumbnail of the item', async () => {
  query.mockResolvedValue({ ok: true, value: { width: 160, height: 90, format: 'png', data: new Uint8Array([1, 2, 3]) }, revision: 1 });
  const { container } = render(<AssetThumb asset={asset('test.ppm', 'item_7')} variant="row" />);
  await flush();
  expect(query).toHaveBeenCalledWith({ type: 'getThumbnail', item: 'item_7', time: 0, maxSize: 160 });
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:engine-thumb');
});

it('a PNG keeps its own file; an <img> that fails asks the engine; no engine thumbnail = the glyph', async () => {
  query.mockResolvedValue({ ok: false, error: { code: 'decode', message: 'no picture' }, revision: 1 });
  const { container } = render(<AssetThumb asset={asset('ok.png', 'item_8')} variant="row" />);
  const img = container.querySelector('img')!;
  expect(img.getAttribute('src')).toBe('local-file:///C:/m/ok.png');
  expect(query).not.toHaveBeenCalled();
  fireEvent.error(img);
  await flush();
  expect(query).toHaveBeenCalledTimes(1);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
});
