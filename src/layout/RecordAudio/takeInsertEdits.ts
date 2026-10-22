/**
 * A recorded take into the project, through the same funnel as every other
 * file the page makes (docs/B3_PATTERNS.md; the Library's Sound FX do this):
 *
 *   addTakeToProject       the WAV imported from its bytes (`importBytes`,
 *                          "Import <file>" — one undo entry): an audio item
 *                          in the Project panel, saved with the project like
 *                          any imported audio.
 *   addTakeToComposition   that, then an audio layer through the media insert
 *                          router (`insertMediaEdit`, "Insert <name>" — one
 *                          entry, the layer selected) starting where the take
 *                          was recorded: the playhead at record start, plus
 *                          the edit's trim-in so the words stay where they
 *                          were spoken against the picture.
 *
 * The audio used is the take's EDIT when it has one (rendered here first if
 * the settings changed since the last render), else the original. Once it is
 * a layer it is ordinary footage: Levels, fades, timeline trims all apply.
 */

import { clampEdit, isIdentityEdit, renderTakeEdit, type TakeEditParams } from '@core/audio/recording/dsp';
import { decodeWav, encodeWav } from '@core/audio/recording/wav';
import { takeFileName } from '@core/audio/recording/takes';
import { importBrowserFilesEdit } from '@layout/Assets/assetEdits';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';
import type { ImportedAsset } from '@stores/assetStore';
import { documentMirror } from '@stores/documentMirror';
import { takeAudio, useRecordAudioTakesStore, type TakeMeta } from '@stores/recordAudioTakesStore';

function sameEdit(a: TakeEditParams | null, b: TakeEditParams): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** A Blob's bytes (FileReader where `arrayBuffer` is missing — jsdom). */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

/** The take's edited length and where its audio starts in the take, seconds. */
export function editedSpan(take: TakeMeta): { offsetSec: number; durationSec: number } {
  if (isIdentityEdit(take.edit, take.durationSec)) return { offsetSec: 0, durationSec: take.durationSec };
  const p = clampEdit(take.edit, take.durationSec);
  return { offsetSec: p.trimInSec, durationSec: (p.trimOutSec ?? take.durationSec) - p.trimInSec };
}

/**
 * The audio to play / add for a take: the original when the edit is
 * untouched, the rendered edit when it is current, else a fresh render
 * (stored on the take). Null when the take is gone.
 */
export async function takeBlobForUse(id: string): Promise<Blob | null> {
  const take = useRecordAudioTakesStore.getState().takes.find((tk) => tk.id === id);
  const a = takeAudio(id);
  if (!take || !a) return null;
  if (isIdentityEdit(take.edit, take.durationSec)) return a.original;
  if (a.edited && sameEdit(take.renderedEdit, take.edit)) return a.edited;
  const source = decodeWav(await blobBytes(a.original));
  const rendered = renderTakeEdit(source, take.edit);
  const blob = new Blob([encodeWav(rendered, source.sampleRate, take.format) as BlobPart], { type: 'audio/wav' });
  useRecordAudioTakesStore.getState().setRendered(id, blob, { ...take.edit });
  return blob;
}

async function importTake(take: TakeMeta): Promise<ImportedAsset | null> {
  const blob = await takeBlobForUse(take.id);
  if (!blob) return null;
  const fileName = takeFileName(take.name);
  const file = new File([blob], fileName, { type: 'audio/wav' });
  const { imported: [made] } = await importBrowserFilesEdit([{ file }], `Import ${fileName}`);
  if (!made) return null;
  // A decode path may miss a blob WAV's duration; the take knows it exactly.
  const span = editedSpan(take);
  return made.metadata?.duration ? made : { ...made, metadata: { ...made.metadata, duration: span.durationSec } };
}

/** "Add to Project": the take as an audio item, no layer. Resolves to the item, or null (toasted by the import). */
export function addTakeToProject(take: TakeMeta): Promise<ImportedAsset | null> {
  return importTake(take);
}

/** Whether there is a composition to add a layer to. */
export function hasComposition(): boolean {
  return documentMirror().compIds.length > 0;
}

/**
 * "Add to Composition": the item, then its audio layer at the take's start
 * (+ trim-in). Resolves to the new layer's id, or null when nothing was
 * placed (the refusal is toasted by the import / the insert).
 */
export async function addTakeToComposition(take: TakeMeta): Promise<string | null> {
  const asset = await importTake(take);
  if (!asset) return null;
  const startSec = Math.max(0, take.startSec + editedSpan(take).offsetSec);
  const ids = await insertMediaEdit([asset], { label: `Insert ${take.name}`, startSec });
  return ids?.[0] ?? null;
}
