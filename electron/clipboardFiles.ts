/**
 * Files copied in the OS file manager (Explorer, Finder, a Linux file manager),
 * read from the clipboard for Edit ▸ Paste — AE pastes copied footage files as
 * layers. The renderer's Clipboard API offers images and text but not a file
 * list, so main reads it: Electron's `clipboard.read()` (44+) exposes the
 * platform's file list as `text/uri-list`, one file:// URL per line, every
 * copied file (measured on Windows: the `FileName` flavour beside it holds only
 * the first file).
 *
 * Read only; nothing is written. The parser is pure (tested without Electron).
 */

import { fileURLToPath } from 'node:url';

/** `text/uri-list` → paths (comments and non-file URLs skipped). */
export function parseUriList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.startsWith('file:')) continue;
    try {
      out.push(fileURLToPath(s));
    } catch {
      // not a local file URL
    }
  }
  return out;
}

/** The part of Electron's `clipboard` this needs (so tests can pass a fake). */
export interface ClipboardLike {
  read(): Promise<ReadonlyArray<{ readonly types: readonly string[]; getType(type: string): Promise<unknown> }>>;
}

/** Paths of the files on the OS clipboard, [] when there are none. Never throws. */
export async function readClipboardFilePaths(clip: ClipboardLike): Promise<string[]> {
  try {
    for (const item of await clip.read()) {
      if (!item.types.includes('text/uri-list')) continue;
      const blob = (await item.getType('text/uri-list')) as { text?: () => Promise<string> };
      if (typeof blob?.text === 'function') return parseUriList(await blob.text());
    }
  } catch {
    // an unreadable clipboard holds no files for us
  }
  return [];
}
