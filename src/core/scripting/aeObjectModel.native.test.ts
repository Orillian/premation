/**
 * After Effects scripts (`app.project`, docs/SCRIPTING.md) on the real engine:
 * synchronous ExtendScript-style code runs unchanged through the replay
 * runtime, every engine call is sent once, the run is ONE undo entry, and a
 * refused write throws at its own line.
 */

import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { runScript, type RunScriptOptions } from './scriptHost';
import { InProcessScriptWorker } from './inProcessScriptWorker.testkit';
import { rationalFps } from './aeObjectModel';
import { stripDirectives } from './scriptRuntime';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

const run = (source: string, opts: RunScriptOptions = {}) =>
  runScript(source, {
    consent: () => true,
    permissions: ['document.read', 'document.write'],
    workerFactory: () => new InProcessScriptWorker(),
    context: { activeItem: 'comp_root', time: 0 },
    ...opts,
  });

const S = 705_600_000;

describe('app.project', () => {
  it('builds a comp with a solid, positions it, sets an expression and reads everything back', async () => {
    const r = await run(`
      #target aftereffects
      app.beginUndoGroup('Build');
      var comp = app.project.items.addComp('Shot 010', 640, 360, 1, 4, 24);
      var solid = comp.layers.addSolid([1, 0, 0], 'Red', 200, 100, 1);
      solid.property('Transform').property('Position').setValue([100, 50]);
      solid.transform.rotation.expression = 'time * 90';
      var nul = comp.layers.addNull();
      nul.name = 'Rig';
      var posBefore = solid.property('Position').value;
      solid.parent = nul; // keeps the world transform: Position becomes relative to the null (320, 180)
      var txt = comp.layers.addText('Hello');
      txt.property('Opacity').setValueAtTime(0, 0);
      txt.property('Opacity').setValueAtTime(1, 100);
      app.endUndoGroup();
      $.writeln('layers: ' + comp.numLayers);
      alert(comp.layer(3).name);
      return {
        name: comp.name, w: comp.width, h: comp.height, fps: comp.frameRate, dur: comp.duration,
        numLayers: comp.numLayers,
        top: comp.layer(1).name, topIsText: comp.layer(1) instanceof TextLayer,
        solidIndex: solid.index, solidIsAV: solid instanceof AVLayer,
        posBefore: posBefore,
        pos: solid.property('Position').value,
        rotExpr: solid.transform.rotation.expression,
        rotAt1: solid.transform.rotation.valueAtTime(1),
        rotPre: solid.transform.rotation.valueAtTime(1, true),
        parent: solid.parent.name,
        text: txt.sourceText.value.text,
        keys: txt.opacity.numKeys,
        key2: [txt.opacity.keyTime(2), txt.opacity.keyValue(2)],
        half: txt.opacity.valueAtTime(0.5),
        byName: comp.layer('Rig').index,
        isComp: comp instanceof CompItem,
        items: app.project.numItems,
      };
    `, { name: 'Build' });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, outcome: 'engine' });
    expect(r.value).toEqual({
      name: 'Shot 010', w: 640, h: 360, fps: 24, dur: 4,
      numLayers: 3,
      top: 'Hello', topIsText: true,
      solidIndex: 3, solidIsAV: true,
      posBefore: [100, 50],
      pos: [-220, -130],
      rotExpr: 'time * 90',
      rotAt1: 90,
      rotPre: 0,
      parent: 'Rig',
      text: 'Hello',
      keys: 2,
      key2: [1, 100],
      half: 50,
      byName: 2,
      isComp: true,
      items: 2,
    });
    // Logs are emitted once, in order, however many passes the replay took.
    expect(r.logs).toEqual(['layers: 3', 'Red']);
    expect(await historyLabels()).toEqual(['Script: Build']);

    // The document really holds it.
    const doc = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    const comp = doc.comps.find((c) => c.settings.name === 'Shot 010')!;
    expect(comp.settings.frameRate).toEqual({ num: 24, den: 1 });
    expect(comp.settings.duration).toBe(4 * S);
    const solid = doc.layers.find((l) => l.name === 'Red')!;
    const { values } = await h.query({ type: 'getPropertyValues', props: [{ layer: solid.id, path: 'transform/position' }], time: 0, evaluated: false });
    expect(values[0]!.value).toEqual({ kind: 'vec2', value: { x: -220, y: -130 } });

    // One undo removes the whole run.
    await h.run({ type: 'undo' });
    const after = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    expect(after.comps.map((c) => c.settings.name)).not.toContain('Shot 010');
  });

  it('activeItem is the editor\'s composition, and layers are 1-based', async () => {
    await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'null', name: 'Bottom', init: [] });
    await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'null', name: 'Top', init: [] });
    const r = await run(`
      var comp = app.project.activeItem;
      if (!(comp instanceof CompItem)) throw new Error('no comp');
      var names = [];
      for (var i = 1; i <= comp.numLayers; i++) names.push(comp.layer(i).name);
      return { names: names, viaCollection: comp.layers[2].name, length: comp.layers.length };
    `, { permissions: ['document.read'] });
    expect(r).toMatchObject({ ok: true, value: { names: ['Top', 'Bottom'], viaCollection: 'Bottom', length: 2 } });
    // A read-only run pushes no entry.
    expect((await historyLabels()).filter((l) => l.startsWith('Script'))).toEqual([]);
  });

  it('no active composition reads as null', async () => {
    const r = await run('return app.project.activeItem;', { context: {} });
    expect(r).toMatchObject({ ok: true, value: null });
  });

  it('a refused write throws at its own line and rolls the whole run back', async () => {
    const before = await h.doc();
    const r = await run([
      "var comp = app.project.activeItem;",
      "var l = comp.layers.addNull();",
      "l.name = 'Fine';",
      "comp.layers.addSolid([0, 0, 1], 'Blue', 100, 100, 1).property('Position').setValue('not a vector');",
    ].join('\n'));
    expect(r).toMatchObject({ ok: false, outcome: 'rolledBack' });
    expect(r.errorLine).toBe(4);
    expect(await h.doc()).toBe(before);
  });

  it('a caught refusal is an ordinary exception; the rest commits', async () => {
    const r = await run(`
      var comp = app.project.activeItem;
      var caught = '';
      try { comp.layer('Nope'); } catch (e) { caught = e.message; }
      comp.layers.addNull().name = 'After';
      return caught;
    `, { name: 'Tolerant' });
    expect(r.ok).toBe(true);
    expect(String(r.value)).toContain('no layer of that name');
    expect(await historyLabels()).toEqual(['Script: Tolerant']);
  });

  it('replays deterministically: Math.random and Date agree across passes', async () => {
    const r = await run(`
      var comp = app.project.activeItem;
      var made = [];
      for (var i = 0; i < 3; i++) {
        var n = comp.layers.addNull();
        n.name = 'N' + Math.floor(Math.random() * 1e6);
        made.push(n.name);
      }
      return { made: made, stamp: Date.now() === new Date().getTime() };
    `);
    expect(r.ok).toBe(true);
    const v = r.value as { made: string[]; stamp: boolean };
    expect(v.stamp).toBe(true);
    const doc = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    expect(doc.layers.map((l) => l.name).sort()).toEqual([...v.made].sort());
  });

  it('mixes the async premation API with app', async () => {
    const r = await run(`
      // @permissions document.read, document.write
      const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
      const comp = app.project.activeItem;
      const { layer } = await premation.execute({ type: 'createLayer', comp: doc.comps[0].id, kind: 'null', name: 'Async', init: [] });
      return [comp.numLayers, comp.layer(1).name, layer === comp.layer(1).id];
    `);
    expect(r).toMatchObject({ ok: true, value: [1, 'Async', true] });
  });

  it('a read-only grant refuses app writes', async () => {
    const before = await h.doc();
    const r = await run("app.project.activeItem.layers.addNull();", { permissions: ['document.read'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('document.write');
    expect(await h.doc()).toBe(before);
  });
});

describe('helpers', () => {
  it('maps frame rates to exact rationals', () => {
    expect(rationalFps(25)).toEqual({ num: 25, den: 1 });
    expect(rationalFps(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(rationalFps(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(rationalFps(12.5)).toEqual({ num: 12500, den: 1000 });
  });

  it('comments out ExtendScript directives without moving lines', () => {
    expect(stripDirectives('#target aftereffects\n  #include "x.jsx"\nvar a = 1;')).toBe('//#target aftereffects\n  //#include "x.jsx"\nvar a = 1;');
  });
});
