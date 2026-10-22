/**
 * Microphone access for the Record Audio panel (voice-over recording).
 *
 * Two layers decide whether the page may open the microphone, and both live
 * here:
 *
 *  1. **Chromium's permission handlers** on the default session. Without a
 *     handler Electron grants EVERY permission request, so installing one
 *     takes over all of them. Only `media` is decided here, and narrowly:
 *     audio only (never the camera, never a screen grab), from our own
 *     renderer's origin (the packaged `file://` page or the dev server) and
 *     its top frame — a plugin panel iframe or a page a window navigated to
 *     is refused. Every other permission keeps Electron's default answer
 *     (granted), so clipboard, fullscreen, notifications and the rest behave
 *     exactly as before this file existed.
 *
 *  2. **The OS.** macOS keeps its own per-app microphone switch (TCC): the
 *     page cannot ask for it, so `mic:status` / `mic:request` expose
 *     `systemPreferences.getMediaAccessStatus` / `askForMediaAccess` through
 *     the preload. Windows reports its privacy switch through the same status
 *     call; Linux has none (always "granted" from here — PulseAudio/PipeWire
 *     decide).
 *
 * The decisions are pure functions so the table is unit-tested without the
 * Electron binary (`mediaAccess.test.ts`).
 */

import { session, systemPreferences } from 'electron';
import { handle } from '../ipcGuard';

/** What `systemPreferences.getMediaAccessStatus` answers, plus our "no such switch". */
export type MicAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

/**
 * Whether a URL / origin is our own renderer: the packaged page (`file:`) or
 * the dev server's exact origin. Opaque origins ("null" — a sandboxed plugin
 * panel), other hosts and unparsable values are not.
 */
export function isOwnRendererOrigin(urlOrOrigin: string | undefined | null, devServerUrl: string): boolean {
  if (!urlOrOrigin || urlOrOrigin === 'null') return false;
  try {
    const u = new URL(urlOrOrigin);
    if (u.protocol === 'file:') return true;
    return u.origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

/** The fields of Electron's request details this decision reads. */
export interface MediaRequestFacts {
  requestingUrl?: string;
  isMainFrame?: boolean;
  mediaTypes?: ReadonlyArray<string>;
}

/**
 * The permission REQUEST decision (`setPermissionRequestHandler`). `media` is
 * granted only for an audio-only request from our own top frame; any other
 * permission keeps Electron's default (granted) — see the header.
 */
export function decidePermissionRequest(permission: string, facts: MediaRequestFacts, devServerUrl: string): boolean {
  if (permission !== 'media') return true;
  if (facts.isMainFrame === false) return false;
  if (!isOwnRendererOrigin(facts.requestingUrl, devServerUrl)) return false;
  const types = facts.mediaTypes ?? [];
  // An empty list is not an audio request; a list with 'video' asks for the camera.
  return types.length > 0 && types.every((t) => t === 'audio');
}

/**
 * The permission CHECK decision (`setPermissionCheckHandler`: what
 * `enumerateDevices` labels and `navigator.permissions` consult). Same rule:
 * `media` answers yes only for audio from our own origin.
 */
export function decidePermissionCheck(
  permission: string,
  requestingOrigin: string,
  facts: { mediaType?: string; isMainFrame?: boolean },
  devServerUrl: string,
): boolean {
  if (permission !== 'media') return true;
  if (facts.isMainFrame === false) return false;
  if (!isOwnRendererOrigin(requestingOrigin, devServerUrl)) return false;
  return facts.mediaType === 'audio';
}

/** The OS microphone switch, as far as this platform reports one. */
export function microphoneStatus(): MicAccessStatus {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('microphone') as MicAccessStatus;
  } catch {
    return 'unknown';
  }
}

/** Install the session's permission handlers and the two mic IPC channels. Call once, after `app.whenReady`. */
export function registerMediaAccess(opts: { devServerUrl: string }): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const d = details as { requestingUrl?: string; isMainFrame?: boolean; mediaTypes?: string[] };
    const ok = decidePermissionRequest(permission, d, opts.devServerUrl);
    if (!ok && permission === 'media') console.warn(`[media] refused a media request from ${d.requestingUrl ?? 'an unknown frame'} (${(d.mediaTypes ?? []).join(',') || 'no types'})`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const d = details as { mediaType?: string; isMainFrame?: boolean };
    return decidePermissionCheck(permission, requestingOrigin, d, opts.devServerUrl);
  });

  /** The OS switch's state (no prompt). */
  handle('mic:status', () => microphoneStatus());
  /**
   * Ask the OS for the microphone. macOS shows its prompt once (then answers
   * from Settings); elsewhere there is no prompt to show, so this is the status.
   */
  handle('mic:request', async () => {
    if (process.platform === 'darwin') {
      try {
        return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : microphoneStatus();
      } catch {
        return 'unknown';
      }
    }
    return microphoneStatus();
  });
}
