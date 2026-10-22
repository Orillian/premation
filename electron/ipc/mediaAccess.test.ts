/**
 * The microphone permission table (Record Audio panel): audio only, our own
 * renderer only, every other permission left at Electron's default.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  session: { defaultSession: {} },
  systemPreferences: {},
}));

import { decidePermissionCheck, decidePermissionRequest, isOwnRendererOrigin } from './mediaAccess';

const DEV = 'http://localhost:5173';

describe('isOwnRendererOrigin', () => {
  it.each([
    ['file:///C:/app/dist/index.html', true],
    ['file://', true],
    ['http://localhost:5173/#/popout/audio', true],
    ['http://localhost:5173', true],
    ['http://localhost:5174', false],
    ['https://example.com', false],
    ['null', false],
    ['premation-plugin://x/panel.html', false],
    ['', false],
    [undefined, false],
  ])('%s → %s', (url, want) => {
    expect(isOwnRendererOrigin(url as string | undefined, DEV)).toBe(want);
  });
});

describe('decidePermissionRequest', () => {
  const own = 'http://localhost:5173/';
  it('grants an audio-only request from our top frame', () => {
    expect(decidePermissionRequest('media', { requestingUrl: own, isMainFrame: true, mediaTypes: ['audio'] }, DEV)).toBe(true);
  });
  it('refuses the camera, even alongside audio', () => {
    expect(decidePermissionRequest('media', { requestingUrl: own, isMainFrame: true, mediaTypes: ['video'] }, DEV)).toBe(false);
    expect(decidePermissionRequest('media', { requestingUrl: own, isMainFrame: true, mediaTypes: ['audio', 'video'] }, DEV)).toBe(false);
  });
  it('refuses a request naming no media type', () => {
    expect(decidePermissionRequest('media', { requestingUrl: own, isMainFrame: true, mediaTypes: [] }, DEV)).toBe(false);
  });
  it('refuses subframes and foreign pages', () => {
    expect(decidePermissionRequest('media', { requestingUrl: own, isMainFrame: false, mediaTypes: ['audio'] }, DEV)).toBe(false);
    expect(decidePermissionRequest('media', { requestingUrl: 'https://evil.example/', isMainFrame: true, mediaTypes: ['audio'] }, DEV)).toBe(false);
  });
  it('leaves every other permission at Electron’s default (granted)', () => {
    for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications', 'pointerLock']) {
      expect(decidePermissionRequest(p, { requestingUrl: 'https://anything/' }, DEV)).toBe(true);
    }
  });
});

describe('decidePermissionCheck', () => {
  it('answers yes for audio from our origin only', () => {
    expect(decidePermissionCheck('media', 'file://', { mediaType: 'audio' }, DEV)).toBe(true);
    expect(decidePermissionCheck('media', 'file://', { mediaType: 'video' }, DEV)).toBe(false);
    expect(decidePermissionCheck('media', 'https://x.example', { mediaType: 'audio' }, DEV)).toBe(false);
    expect(decidePermissionCheck('media', 'file://', { mediaType: 'audio', isMainFrame: false }, DEV)).toBe(false);
  });
  it('leaves other checks at the default', () => {
    expect(decidePermissionCheck('clipboard-read', 'https://x.example', {}, DEV)).toBe(true);
  });
});
