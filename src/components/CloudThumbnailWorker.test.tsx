/** A poster frame that did not change is not uploaded again (each upload is a storage write + CDN invalidation). */

import { act, render } from '@testing-library/react';

const listeners: Array<() => void> = [];
jest.mock('@stores/documentMirror', () => ({
  documentMirror: () => ({
    subscribe: (_keys: string[], l: () => void) => {
      listeners.push(l);
      return () => undefined;
    },
  }),
}));

let nextFrame: Blob | null = null;
jest.mock('./thumbnailCapture', () => ({
  captureThumbnailWhenIdle: (onBlob: (b: Blob | null) => void) => {
    queueMicrotask(() => onBlob(nextFrame));
    return () => undefined;
  },
}));

const setProjectThumbnail = jest.fn((_id: string, _b: Blob) => Promise.resolve({}));
jest.mock('@core/api/client', () => ({ api: { setProjectThumbnail: (id: string, b: Blob) => setProjectThumbnail(id, b) } }));

import { CloudThumbnailWorker } from './CloudThumbnailWorker';

const frame = (...bytes: number[]): Blob => new Blob([new Uint8Array(bytes)], { type: 'image/png' });

async function editAndCapture(): Promise<void> {
  await act(async () => {
    for (const l of listeners) l();
    jest.advanceTimersByTime(120_000);
  });
  // The capture answers in a microtask, the upload reads the blob's bytes.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise<void>((r) => { jest.requireActual<typeof globalThis>('timers').setImmediate(r); }); });
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate', 'nextTick'] });
  listeners.length = 0;
  setProjectThumbnail.mockClear();
});
afterEach(() => jest.useRealTimers());

it('uploads a changed poster frame and skips an identical one', async () => {
  const view = render(<CloudThumbnailWorker projectId="p1" />);
  nextFrame = frame(1, 2, 3);
  await editAndCapture();
  expect(setProjectThumbnail).toHaveBeenCalledTimes(1);

  nextFrame = frame(1, 2, 3);
  await editAndCapture();
  expect(setProjectThumbnail).toHaveBeenCalledTimes(1);

  nextFrame = frame(1, 2, 4);
  await editAndCapture();
  expect(setProjectThumbnail).toHaveBeenCalledTimes(2);
  view.unmount();
});
