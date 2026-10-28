/**
 * The AE commands the engine carried without a door (tier 2): Trim Comp to
 * Work Area, Crop Comp to Region of Interest, Remove Unused Footage and Copy
 * with Property Links — each ONE entry, each doing what AE does.
 */

import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels, settleEdits, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { getCommandRegistry } from '@core/commands/Command';
import { ensureCommandsRegistered } from '@core/commands/ensureCommandsRegistered';
import { copyWithPropertyLinksEdit, pasteEdit } from '../clipboardEdits';
import { cropRegion } from './compUtilityCommands';
import { linkablePaths, linkCommands } from '../propertyLinks';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  await settleEdits();
  await documentMirror().loadTrees(documentMirror().layerIds());
  useSelectionStore.getState().clear();
  usePropertySelectionStore.getState().clear();
  ensureCommandsRegistered();
});
afterEach(async () => { await h.dispose(); });

const run = async (id: string): Promise<void> => {
  const cmd = getCommandRegistry().get(id as never);
  if (!cmd) throw new Error(`no command ${id}`);
  // These commands read nothing from the context: the editor's state is in the stores and the mirror.
  await cmd.execute({ state: {}, services: {} } as unknown as Parameters<typeof cmd.execute>[0]);
  await settleEdits();
};

describe('Remove Unused Footage', () => {
  it('removes only footage nothing names — an expression that spells the id keeps it', async () => {
    // V uses `footage`; `footage2` is unused, until an expression names it.
    await h.run({ type: 'setExpression', prop: { layer: s.A, path: 'transform/opacity' }, source: `// reads ${s.footage2}\nvalue`, enabled: true });
    await engineIdle();
    let res = await h.run({ type: 'removeUnusedItems' });
    expect(res.items).toEqual([]);
    await h.run({ type: 'setExpression', prop: { layer: s.A, path: 'transform/opacity' }, source: '', enabled: false });
    res = await h.run({ type: 'removeUnusedItems' });
    expect(res.items).toEqual([s.footage2]);
    expect((await historyLabels()).at(-1)).toBe('Remove Unused Footage');
  });
});

describe('Trim Comp to Work Area', () => {
  it('shortens the comp to its work area in one entry', async () => {
    // The scene's work area is 1 s → 4 s.
    useSelectionStore.getState().clear();
    await run('comp.trimToWorkArea');
    expect((await historyLabels()).at(-1)).toBe('Trim Comp to Work Area');
    expect(documentMirror().comp(s.comp)?.settings.duration).toBe(sec(3));
  });
});

describe('Crop Comp to Region of Interest', () => {
  it('only offers a region inside the frame that is not the whole frame', () => {
    const frame = { width: 1920, height: 1080 };
    expect(cropRegion(null, frame)).toBeNull();
    expect(cropRegion({ x: 0, y: 0, width: 1920, height: 1080 }, frame)).toBeNull();
    expect(cropRegion({ x: -50, y: 100, width: 600, height: 2000 }, frame)).toEqual({ x: 0, y: 100, width: 550, height: 980 });
    expect(cropRegion({ x: 3000, y: 0, width: 10, height: 10 }, frame)).toBeNull();
  });

  it('crops to the region and clears it', async () => {
    useGuidesStore.getState().setRoi({ x: 100, y: 50, width: 800, height: 600 });
    await run('comp.cropToRoi');
    expect((await historyLabels()).at(-1)).toBe('Crop Comp to Region of Interest');
    const settings = documentMirror().comp(s.comp)?.settings;
    expect([settings?.width, settings?.height]).toEqual([800, 600]);
    expect(useGuidesStore.getState().roi).toBeNull();
  });
});

describe('Copy with Property Links', () => {
  it('links every numeric property of a pasted copy to its original, in the paste entry', async () => {
    useSelectionStore.getState().set([s.A]);
    expect(await copyWithPropertyLinksEdit()).toBe('layers');
    const entries = (await historyLabels()).length;
    expect(await pasteEdit()).toBe('layers');
    await settleEdits();
    expect((await historyLabels()).length).toBe(entries + 1);
    const copy = useSelectionStore.getState().ids[0]!;
    expect(copy).not.toBe(s.A);
    await documentMirror().loadTrees([copy]);
    const opacity = documentMirror().tree(copy)?.nodes.get('transform/opacity');
    expect(opacity?.expression).toContain(s.A);
    // Moving the original moves the copy.
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 25 } });
    const v = await h.query({ type: 'getPropertyValues', props: [{ layer: copy, path: 'transform/opacity' }], time: 0, evaluated: true });
    expect(v.values[0]!.value).toEqual({ kind: 'scalar', value: 25 });
    // Past the opacity edit, ONE more undo takes the copy and its links away together.
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await settleEdits();
    expect(await h.doc()).not.toContain(`"${copy}"`);
  });

  it('copied property rows link onto the selected layers', async () => {
    usePropertySelectionStore.getState().select({ nodeId: s.A, prop: 'opacity' });
    expect(await copyWithPropertyLinksEdit()).toBe('layers');
    usePropertySelectionStore.getState().clear();
    useSelectionStore.getState().set([s.B]);
    expect(await pasteEdit()).toBe('layers');
    await settleEdits();
    expect((await historyLabels()).at(-1)).toBe('Paste Property Links');
    await documentMirror().loadTrees([s.B]);
    expect(documentMirror().tree(s.B)?.nodes.get('transform/opacity')?.expression).toContain(s.A);
  });

  it('never links a path or a property the other layer does not have', async () => {
    await documentMirror().loadTrees([s.A, s.T]);
    const a = documentMirror().tree(s.A)!;
    const tx = documentMirror().tree(s.T)!;
    const paths = linkablePaths(a);
    expect(paths).toContain('transform/opacity');
    expect(paths.some((p) => p.endsWith('/path'))).toBe(false);
    const cmds = linkCommands(a, tx, [...paths, 'effects/nope/radius']);
    expect(cmds.every((c) => c.type === 'linkProperty' && tx.nodes.has(c.prop.path))).toBe(true);
  });
});
