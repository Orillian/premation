/**
 * Edit ▸ Cut / Copy / Paste through the engine API (B3z, docs/B3_PATTERNS.md §6).
 *
 *   Copy   a Direct Selection path → the path clipboard (`copyPathFromSelection`);
 *          selected keyframes → the keyframe clipboard the timeline's Ctrl+C
 *          fills (`copyKeyframes`); otherwise the selected layers → a
 *          `copyLayers` fragment, captured NOW (a later edit or delete of the
 *          originals does not change what pastes).
 *   Cut    Copy, then delete what was copied (keyframes: `deleteKeyframes`;
 *          layers: the Delete command's `deleteLayers`).
 *   Paste  the path onto the selected path; else the copied keyframes at the
 *          playhead on every selected layer (`pasteKeyframes`); else the copied
 *          layers as ONE `pasteLayers` at the top of the active composition,
 *          each copy named "<name> copy", in place (AE pastes where the layer
 *          was copied from); else SVG markup on the OS
 *          clipboard, built off-document and sent as one `pasteLayers`.
 *
 * Expressions (After Effects' Copy Expression Only): a selected property's
 * expression is copied as its source — also onto the OS clipboard as text —
 * and pastes onto the selected property rows, or onto the same property of the
 * selected layers. Text copied outside the app and pasted onto selected
 * property rows becomes their expression.
 *
 * Each paste is ONE undo entry. The legacy module (`core/commands/clipboard`)
 * kept its own snapshot of nodes and tracks and wrote them with the graph.
 */

import type { Command, DocumentFragment } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { expressionTargets } from '@core/animation/expressionEditorRequests';
import { trackExpressionFacts } from '@core/mirror/memberExpressions';
import { expressionCommands, trackRef } from '@layout/Inspector/inspectorEdits';
import { linkablePaths, linkCommands } from './propertyLinks';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { apiParentOf, compOfLayer, isLayer, layerIdsOfComp } from '@core/mirror/docFacts';
import { copyKeyframes } from '@core/animation/keyframeClipboard';
import { readOsClipboardSvg } from '@core/commands/clipboard';
import { copyPathFromSelection, pastePathEdit } from '@core/workspace/pathCommands';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import { insertSvgDocumentEdit } from '@/engine-client/insertEdits';
import { documentMirror } from '@stores/documentMirror';
import { deleteKeyframesUi, pasteKeyframesAt } from '@layout/Timeline/keyframeEdits';
import { deleteSelectedLayersEdit } from '@layout/Workspace/layerMenuEdits';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { getTime } from '@stores/playbackClockStore';
import type { ImportedAsset } from '@stores/assetStore';
import { importBrowserFilesEdit, importPathsEdit } from '@layout/Assets/assetEdits';
import { isMediaFile } from '@layout/Assets/mediaBrowserTree';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';

export type CopyKind = 'path' | 'keyframes' | 'layers' | 'expression' | null;
export type PasteResult = 'keyframes' | 'layers' | 'svg' | 'path' | 'expression' | 'media' | null;

interface HeldLayers {
  fragment: Promise<DocumentFragment | null>;
  /** The copied top-level layers' names, in fragment order. */
  names: string[];
}

/**
 * An expression's source and the track it came from (Edit ▸ Copy Expression
 * Only, or Copy on a selected property that has one): a paste with no property
 * selected lands on that same track of every selected layer, as in AE.
 */
interface HeldExpression {
  source: string;
  track: string;
}

/**
 * Edit ▸ Copy with Property Links: the copied layers (pasted as linked copies)
 * or the copied property rows (pasted as links on the selected layers).
 */
type HeldLinks =
  | ({ source: 'layers'; layers: string[] } & HeldLayers)
  | { source: 'props'; refs: Array<{ layer: string; path: string }> };

/** What Copy put on the app clipboard last (keyframes live in the keyframe clipboard). */
let held:
  | { kind: 'keyframes' }
  | ({ kind: 'layers' } & HeldLayers)
  | ({ kind: 'expression' } & HeldExpression)
  | ({ kind: 'links' } & HeldLinks)
  | null = null;

/** The first of `refs` (default: the focused inspector row, else the selected property rows) that carries an expression. */
function selectedExpression(refs: ReadonlyArray<{ nodeId: string; prop: string }> = expressionTargets()): HeldExpression | null {
  const m = documentMirror();
  for (const ref of refs) {
    const facts = trackExpressionFacts(m, ref.nodeId, ref.prop);
    if (facts) return { source: facts.source, track: ref.prop };
  }
  return null;
}

/**
 * The OS clipboard's text when the app last copied: a paste whose OS text
 * differs was copied elsewhere AFTER that, and is the newer clipboard.
 */
let osTextAtCopy: string | null = null;

function noteOsClipboardAtCopy(): void {
  osTextAtCopy = null;
  void navigator.clipboard?.readText().then(
    (s) => { osTextAtCopy = s.trim(); },
    () => { /* unreadable: any text found at paste time counts as newer */ },
  );
}

/** Whether Copy Expression Only has something to copy. */
export function canCopyExpression(): boolean {
  return selectedExpression() !== null;
}

/**
 * Edit ▸ Copy Expression Only (After Effects): the selected property's
 * expression source goes on the app clipboard — and, as text, on the OS
 * clipboard, so it can be pasted into a forum post or another project.
 */
export async function copyExpressionOnlyEdit(row?: { nodeId: string; prop: string }): Promise<CopyKind> {
  const refs = row ? [row] : expressionTargets();
  await documentMirror().loadTrees(refs.map((r) => r.nodeId));
  const e = selectedExpression(refs);
  if (!e) return null;
  held = { kind: 'expression', ...e };
  try {
    await navigator.clipboard?.writeText(e.source);
    osTextAtCopy = e.source.trim();
  } catch {
    /* no OS clipboard access (headless, denied): the app clipboard still holds it */
  }
  return 'expression';
}

/**
 * Paste an expression: onto every selected property row; with none, onto the
 * copied track of every selected layer. ONE entry. Null when nothing took it.
 */
async function pasteExpressionEdit(source: string, track: string | null): Promise<PasteResult> {
  const rows = expressionTargets();
  const pairs = rows.length > 0
    ? rows.map((r) => ({ nodeId: r.nodeId, track: r.prop, source }))
    : track
      ? useSelectionStore.getState().ids.filter((id) => isLayer(id)).map((nodeId) => ({ nodeId, track, source }))
      : [];
  // A layer that is selected but not shown in any panel has no tree in the mirror yet.
  await documentMirror().loadTrees(pairs.map((p) => p.nodeId));
  const cmds = pairs.length > 0 ? expressionCommands(pairs, true) : null;
  if (!cmds || cmds.length === 0) return null;
  const res = await edit(pairs.length === 1 ? 'Paste Expression' : 'Paste Expressions', cmds);
  return res.ok ? 'expression' : null;
}

/**
 * Plain text on the OS clipboard pasted while property rows are selected: an
 * expression copied from a browser, a forum or AE itself. Null when the
 * clipboard holds no text, or SVG (which pastes as layers).
 */
async function readOsClipboardExpression(): Promise<string | null> {
  if (expressionTargets().length === 0) return null;
  try {
    const text = (await navigator.clipboard?.readText())?.trim() ?? '';
    if (text === '' || /^<(\?xml|svg)\b/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * The selected layers without those whose ancestor is also selected (the
 * fragment carries descendants), in STACK order, front-most first — the order
 * a pasted fragment stacks in. AE pastes layers in their stacking order, not
 * the order they were clicked.
 */
function topLayers(ids: readonly string[]): string[] {
  const picked = new Set(ids.filter((id) => isLayer(id)));
  const stackIndex = new Map<string, number>();
  for (const id of picked) {
    const comp = compOfLayer(id);
    if (comp && !stackIndex.has(id)) layerIdsOfComp(comp).forEach((l, i) => stackIndex.set(l, i));
  }
  return [...picked]
    .filter((id) => {
      for (let p = apiParentOf(id); p; p = apiParentOf(p)) if (picked.has(p)) return false;
      return true;
    })
    .sort((a, b) => (stackIndex.get(a) ?? 0) - (stackIndex.get(b) ?? 0));
}

/**
 * Edit ▸ Copy. Resolves to what was copied — the layer fragment is captured by
 * the time it resolves (a Cut awaits it before deleting the originals).
 */
export async function copyEdit(): Promise<CopyKind> {
  // A Direct Selection vertex selection copies the PATH, not the layer (AE);
  // otherwise this drops a stale path clipboard so it cannot shadow the paste.
  if (copyPathFromSelection()) return 'path';
  noteOsClipboardAtCopy();
  const kf = useKeyframeSelectionStore.getState().ids;
  if (kf.size > 0) {
    await copyKeyframes(kf);
    held = { kind: 'keyframes' };
    return 'keyframes';
  }
  // A selected property that carries an expression copies the expression (AE
  // copies the property; its keys are copied by selecting them).
  if (usePropertySelectionStore.getState().entries.length > 0) {
    const kind = await copyExpressionOnlyEdit();
    if (kind) return kind;
  }
  const layers = topLayers(useSelectionStore.getState().ids);
  if (layers.length === 0) return null;
  const fragment = engine()
    .query({ type: 'copyLayers', layers })
    .then((res) => {
      if (res.ok) return { version: res.value.version, data: res.value.data };
      reportEngineError('Copy', res.error);
      return null;
    });
  // The copy's names, read now: the originals may be renamed or deleted before the paste.
  const names = layers.map((id) => documentMirror().layer(id)?.name ?? '');
  held = { kind: 'layers', fragment, names };
  return (await fragment) ? 'layers' : null;
}

/** Whether Copy with Property Links has something to copy: property rows, else layers. */
export function canCopyWithPropertyLinks(): boolean {
  return usePropertySelectionStore.getState().entries.length > 0 || topLayers(useSelectionStore.getState().ids).length > 0;
}

/**
 * Edit ▸ Copy with Property Links (AE): the selected property rows, else the
 * selected layers, held so the paste LINKS rather than copies values.
 */
export async function copyWithPropertyLinksEdit(): Promise<CopyKind> {
  noteOsClipboardAtCopy();
  const rows = usePropertySelectionStore.getState().entries;
  if (rows.length > 0) {
    await documentMirror().loadTrees([...new Set(rows.map((r) => r.nodeId))]);
    const refs = new Map<string, { layer: string; path: string }>();
    for (const r of rows) {
      const ref = trackRef(r.nodeId, r.prop);
      if (ref) refs.set(`${r.nodeId}|${ref.ref.path}`, { layer: r.nodeId, path: ref.ref.path });
    }
    if (refs.size === 0) return null;
    held = { kind: 'links', source: 'props', refs: [...refs.values()] };
    return 'layers';
  }
  const layers = topLayers(useSelectionStore.getState().ids);
  if (layers.length === 0) return null;
  const fragment = engine()
    .query({ type: 'copyLayers', layers })
    .then((res) => {
      if (res.ok) return { version: res.value.version, data: res.value.data };
      reportEngineError('Copy with Property Links', res.error);
      return null;
    });
  const names = layers.map((id) => documentMirror().layer(id)?.name ?? '');
  held = { kind: 'links', source: 'layers', layers, fragment, names };
  return (await fragment) ? 'layers' : null;
}

/**
 * Paste what Copy with Property Links held: linked copies of the layers, or
 * the copied properties linked onto every selected layer. ONE entry.
 */
async function pasteLinksEdit(h: HeldLinks): Promise<PasteResult> {
  const m = documentMirror();
  if (h.source === 'props') {
    const targets = useSelectionStore.getState().ids.filter((id) => isLayer(id));
    const sources = [...new Set(h.refs.map((r) => r.layer))].filter((id) => m.layer(id));
    await m.loadTrees([...targets, ...sources]);
    const cmds: Command[] = [];
    for (const target of targets) {
      const follower = m.tree(target);
      if (!follower) continue;
      for (const leaderId of sources) {
        if (leaderId === target) continue;  // a property cannot follow itself
        const leader = m.tree(leaderId);
        if (!leader) continue;
        cmds.push(...linkCommands(leader, follower, h.refs.filter((r) => r.layer === leaderId).map((r) => r.path)));
      }
    }
    if (cmds.length === 0) return null;
    const res = await edit('Paste Property Links', cmds);
    return res.ok ? 'layers' : null;
  }
  // The links ride the paste's own entry: one undo removes the copies and their links together.
  const copies = await pasteLayersEdit(h, async (tops) => {
    const originals = h.layers.filter((id) => m.layer(id));
    await m.loadTrees([...tops, ...originals]);
    const cmds: Command[] = [];
    tops.forEach((copy, i) => {
      const leader = m.tree(h.layers[i] ?? '');
      const follower = m.tree(copy);
      if (leader && follower) cmds.push(...linkCommands(leader, follower, linkablePaths(leader)));
    });
    return cmds;
  });
  return copies && copies.length > 0 ? 'layers' : null;
}

/** Edit ▸ Cut: Copy, then delete the originals (a path is only copied). */
export async function cutEdit(): Promise<CopyKind> {
  const kfIds = [...useKeyframeSelectionStore.getState().ids];
  const kind = await copyEdit();
  if (kind === 'keyframes') {
    await deleteKeyframesUi(kfIds, 'Cut keyframes');
    useKeyframeSelectionStore.getState().set(new Set());
  } else if (kind === 'layers') {
    await deleteSelectedLayersEdit();
  }
  return kind;
}

/**
 * The copied layers into the active composition (into the open group when the
 * tab is a group), at the top of the stack — ONE entry named "Paste". The paste
 * returns the new ids, so the renames run in the same engine
 * gesture. Resolves to the new top-level ids.
 */
async function pasteLayersEdit(
  h: HeldLayers,
  /** More commands for the pasted top-level layers, in the paste's own entry (Copy with Property Links). */
  extra?: (tops: string[]) => Promise<Command[]>,
): Promise<string[] | null> {
  const fragment = await h.fragment;
  if (!fragment) return null;
  const target = activeInsertTarget();
  if (!target) return null;
  const label = 'Paste';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let ok = true;
  let tops: string[] = [];
  const res = await client.execute({ type: 'pasteLayers', comp: target.comp, fragment, index: 0, ...(target.parent ? { parent: target.parent } : {}) });
  if (!res.ok) {
    reportEngineError(label, res.error);
    ok = false;
  } else {
    const ids = (res.value as { layers?: string[] }).layers ?? [];
    // The new layers' parents and Position come from the mirror once it has the paste.
    await documentMirror().whenAt(res.revision);
    const made = new Set(ids);
    tops = ids.filter((id) => !made.has(apiParentOf(id) ?? ''));
    const follow: Command[] = [];
    for (const [i, id] of tops.entries()) {
      const name = h.names[i];
      if (name) follow.push({ type: 'renameLayer', layer: id, name: `${name} copy` });
    }
    if (follow.length > 0) {
      const r = await client.batch(label, follow);
      if (!r.ok) {
        reportEngineError(label, r.error);
        ok = false;
      }
    }
    const more = ok && extra ? await extra(tops) : [];
    if (more.length > 0) {
      const r = await client.batch(label, more);
      if (!r.ok) {
        reportEngineError(label, r.error);
        ok = false;
      }
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  if (!ok) return null;
  if (tops.length > 0) useSelectionStore.getState().set(tops);
  return tops;
}

/**
 * Edit ▸ Paste — the path, the keyframes or the layers Copy took (in that
 * order), else SVG markup from the OS clipboard (AE 26.3). Resolves to what
 * was pasted, or null when there was nothing to paste.
 */
export async function pasteEdit(): Promise<PasteResult> {
  // A path paste (Direct Selection vertices copied): one engine edit onto the target outlines.
  if (pastePathEdit()) return 'path';
  if (held?.kind === 'expression') {
    const done = await pasteExpressionEdit(held.source, held.track);
    if (done) return done;
  }
  // Text copied OUTSIDE the app since its last Copy, pasted onto selected
  // property rows: a pasted expression (from a browser, a forum, AE itself).
  const text = await readOsClipboardExpression();
  if (text !== null && text !== osTextAtCopy) {
    const done = await pasteExpressionEdit(text, null);
    if (done) return done;
  }
  if (held?.kind === 'links') {
    const done = await pasteLinksEdit(held);
    if (done) return done;
  }
  if (held?.kind === 'keyframes') {
    const targets = useSelectionStore.getState().ids.filter((id) => isLayer(id));
    if (targets.length === 0) return null;
    await pasteKeyframesAt(targets, getTime());
    return 'keyframes';
  }
  if (held?.kind === 'layers') {
    const ids = await pasteLayersEdit(held);
    return ids && ids.length > 0 ? 'layers' : null;
  }
  // Footage copied in the OS (files in Explorer / Finder, or an image such as a
  // screenshot): imported and added as layers at the playhead, every file in
  // one entry — AE pastes copied files the same way. Checked once the app's own
  // clipboard is empty, before SVG text.
  const media = await pasteOsMediaEdit();
  if (media) return media;
  // Checked LAST, and built by the importer a dropped .svg file takes, so both
  // land identically.
  const svg = await readOsClipboardSvg();
  if (!svg) return null;
  const comp = activeInsertTarget()?.comp;
  if (!comp) return null;
  const ids = await pasteSvgDocument(comp, svg);
  return ids && ids.length > 0 ? 'svg' : null;
}

/**
 * Footage on the OS clipboard → layers at the playhead in the composition in
 * view, as ONE entry per step (import, then insert). Files copied in the file
 * manager come as paths (imported like File ▸ Import); an image on the clipboard
 * (a screenshot, a browser's Copy Image) as PNG bytes. Null when there is none.
 */
async function pasteOsMediaEdit(): Promise<PasteResult> {
  if (!activeInsertTarget()?.comp) return null;
  let paths: string[] = [];
  try {
    paths = (await window.motionEditor?.shell?.readClipboardFiles?.()) ?? [];
  } catch {
    paths = [];
  }
  const media = paths.filter((p) => isMediaFile(p));
  let imported: ImportedAsset[] = [];
  if (media.length > 0) {
    imported = (await importPathsEdit(media)).imported;
  } else {
    const image = await readOsClipboardImage();
    if (image) imported = (await importBrowserFilesEdit([{ file: image }])).imported;
  }
  if (imported.length === 0) return null;
  const ids = await insertMediaEdit(imported, { atPlayhead: true, label: imported.length === 1 ? `Paste ${imported[0]!.name}` : `Paste ${imported.length} Layers` });
  return ids && ids.length > 0 ? 'media' : null;
}

/** A bitmap on the OS clipboard as a PNG `File`, or null (none, or no clipboard access). */
async function readOsClipboardImage(): Promise<File | null> {
  try {
    const items = (await navigator.clipboard?.read?.()) ?? [];
    for (const item of items) {
      const type = item.types.find((ty) => ty === 'image/png' || ty === 'image/jpeg' || ty === 'image/webp');
      if (!type) continue;
      const blob = await item.getType(type);
      const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
      return new File([blob], `Pasted Image.${ext}`, { type });
    }
  } catch {
    // no permission or nothing readable
  }
  return null;
}

/**
 * Paste an SVG document through the importer's router, laid into a fragment
 * (engine-client/insertEdits.ts): a static one is ONE document layer, an
 * animated one editable keyframes or a Live SVG — exactly what dropping the
 * file makes. One `pasteLayers` entry, selected.
 */
async function pasteSvgDocument(comp: string, svg: string): Promise<string[] | null> {
  return insertSvgDocumentEdit(svg, 'Pasted SVG', 'Paste SVG', { comp });
}

/** Forget what Copy took (tests). */
export function clearHeldClipboard(): void {
  held = null;
}
