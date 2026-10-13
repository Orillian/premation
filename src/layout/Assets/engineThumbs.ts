/**
 * engineThumbs — an image asset's picture from the ENGINE, for files the page
 * cannot decode.
 *
 * The Assets panel draws an image by handing its file to an `<img>`; that is
 * fine for PNG / JPEG / WebP, and broken for anything only the engine reads:
 * a format a native plugin imports (ppmio's `.ppm`, 2026-10-13 QA: a broken
 * image in the Project panel), EXR, a camera raw. The engine decodes those
 * through the same importer the render uses, so the thumbnail is its
 * `getThumbnail { item }` (source frame 0). One request per asset per session;
 * a failure (a data item such as a LUT or a model, an engine without a
 * renderer) is remembered as `null` and the panel shows the type glyph.
 */

import { engine } from '@core/engine/engineInstance';

const THUMB_MAX = 160;

type Listener = (url: string | null) => void;

const thumbs = new Map<string, string | null>();
const waiting = new Map<string, Listener[]>();

/** Extensions an `<img>` decodes: anything else asks the engine first. */
const BROWSER_IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

/** Whether the page can decode the asset's file itself (by its name or source). */
export function browserDecodes(nameOrSrc: string): boolean {
  const clean = nameOrSrc.split(/[?#]/)[0] ?? '';
  return BROWSER_IMAGE.test(clean);
}

/** The cached thumbnail (an object URL), `null` when the engine had none, `undefined` when not asked yet. */
export function peekEngineThumb(itemId: string): string | null | undefined {
  return thumbs.get(itemId);
}

/** Ask the engine for `itemId`'s thumbnail; `onReady` fires once (synchronously when known). Returns an unsubscribe. */
export function requestEngineThumb(itemId: string, onReady: Listener): () => void {
  const known = thumbs.get(itemId);
  if (known !== undefined) {
    onReady(known);
    return () => {};
  }
  const list = waiting.get(itemId);
  if (list) list.push(onReady);
  else {
    waiting.set(itemId, [onReady]);
    void fetchThumb(itemId);
  }
  return () => {
    const cur = waiting.get(itemId);
    if (!cur) return;
    const i = cur.indexOf(onReady);
    if (i >= 0) cur.splice(i, 1);
  };
}

async function fetchThumb(itemId: string): Promise<void> {
  let url: string | null = null;
  try {
    const res = await engine().query({ type: 'getThumbnail', item: itemId, time: 0, maxSize: THUMB_MAX });
    if (res.ok && res.value.data.length > 0) {
      const blob = new Blob([res.value.data as BlobPart], { type: `image/${res.value.format || 'png'}` });
      url = URL.createObjectURL(blob);
    }
  } catch {
    url = null;  // no engine (yet): the glyph
  }
  thumbs.set(itemId, url);
  const list = waiting.get(itemId) ?? [];
  waiting.delete(itemId);
  for (const f of list) f(url);
}

/** Tests: forget every thumbnail. */
export function resetEngineThumbsForTest(): void {
  thumbs.clear();
  waiting.clear();
}
