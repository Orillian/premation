/**
 * The compiler: deterministic, complete, and design-free.
 *
 * "Design-free" is tested the only way it can be: every literal value in the
 * output must be traceable to the script. The tests build a script, compile
 * it, and check that each call carries exactly what the script said — and
 * that a property the script left out does not appear at all.
 */

import { ALL_TOOL_DEFS, validate } from '@motion/ai-tools';
import { coerceScript } from './coerce';
import { TAIL_ROOT, beatRootId, compileScript, rebuildCalls, sameFrameKeys, trimHandle } from './compile';
import { AUTHOR_EXEMPLARS } from './exemplars';
import type { SceneScript, ToolCall } from './types';

const CTX = { durationSec: 6, width: 1920, height: 1080 };

const base = (over: Partial<SceneScript> = {}): SceneScript => ({
  title: 't', intent: 'i', durationSec: 6, background: '$bg',
  palette: { bg: '#101014', ink: '#fafafa', hot: '#ff3355' },
  grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
  type: { h1: { family: 'Inter', weight: 700, size: 120, tracking: -3, leading: 0.95 } },
  globals: [],
  beats: [],
  ...over,
});

const calls = (c: ToolCall[], name: string) => c.filter((x) => x.name === name);

describe('compileScript', () => {
  it('is deterministic: the same script compiles to the same calls', () => {
    for (const ex of AUTHOR_EXEMPLARS) {
      expect(JSON.stringify(compileScript(ex.script).calls)).toBe(JSON.stringify(compileScript(ex.script).calls));
    }
  });

  it('emits only calls the registry schemas accept', () => {
    // A call the schema rejects is a call that never runs — every exemplar must pass validation whole.
    const defs = new Map(ALL_TOOL_DEFS.map((d) => [d.name, d]));
    for (const ex of AUTHOR_EXEMPLARS) {
      for (const c of compileScript(ex.script).calls) {
        const d = defs.get(c.name);
        expect([c.name, !!d]).toEqual([c.name, true]);
        const r = validate(d!.inputSchema, c.args);
        expect([c.name, r.ok ? 'ok' : r.errors]).toEqual([c.name, 'ok']);
      }
    }
  });

  it('gives every beat a root null at the origin, timed to the beat, and parents its layers to it', () => {
    const s = base({
      beats: [
        { name: 'A', purpose: '', startSec: 0, endSec: 2, layers: [{ id: 'a', kind: 'shape', name: 'A', shape: 'rect', props: { x: 100, y: 100, width: 50, height: 50 } }] },
        { name: 'B', purpose: '', startSec: 2, endSec: 6, layers: [{ id: 'b', kind: 'null', name: 'B' }] },
      ],
    });
    const out = compileScript(s);
    expect(out.byBeat.map((r) => r.rootId)).toEqual([beatRootId(0), beatRootId(1)]);
    const beat1 = out.calls.slice(out.byBeat[1]!.start, out.byBeat[1]!.end);
    expect(beat1[0]).toEqual({ name: 'create_layer', args: { id: 'beat_1', kind: 'null', name: 'Beat 2 — B', x: 0, y: 0 } });
    expect(beat1).toContainEqual({ name: 'reparent_layer', args: { nodeId: 'b', parentId: 'beat_1' } });
    const timing = calls(beat1, 'set_layer_timing')[0]!.args.items;
    expect(timing).toEqual([{ nodeId: 'beat_1', inSec: 2, outSec: 6 }, { nodeId: 'b', inSec: 2, outSec: 6 }]);
    expect(out.beatOfLayer.get('a')).toBe(0);
    expect(out.beatOfLayer.get('b')).toBe(1);
  });

  it('converts beat-local times to composition seconds everywhere', () => {
    const s = base({
      beats: [
        { name: 'A', purpose: '', startSec: 0, endSec: 2.1, layers: [] },
        {
          name: 'B', purpose: '', startSec: 2.1, endSec: 6,
          layers: [{
            id: 't', kind: 'text', name: 'T', text: 'Hi', inSec: 0.3, outSec: 3.5,
            keys: { opacity: [{ t: 0.3, v: 0, ease: 'easeOut' }, { t: 0.8, v: 100 }] },
            textAnimators: [{ opacity: 0, sweep: { from: 0.3, to: 1.2 }, keys: { blur: [{ t: 0.3, v: 10 }, { t: 1, v: 0 }] } }],
            effects: [{ id: 'g', type: 'glow', keys: { radius: [{ t: 0, v: 10 }, { t: 1, v: 40 }] } }],
          }],
        },
      ],
    });
    const out = compileScript(s);
    const kf = calls(out.calls, 'set_keyframes').flatMap((c) => c.args.keyframes as Array<{ prop: string; t: number }>);
    expect(kf.filter((k) => k.prop === 'opacity').map((k) => k.t)).toEqual([2.4, 2.9]);
    expect(kf.filter((k) => k.prop === 'ta.0.blur').map((k) => k.t)).toEqual([2.4, 3.1]);
    expect(kf.filter((k) => k.prop === 'effect.g.radius').map((k) => k.t)).toEqual([2.1, 3.1]);
    expect(calls(out.calls, 'text_animator')[0]!.args.sweep).toEqual({ fromSec: 2.4, toSec: 3.3, fromOffset: 0, toOffset: 100 });
    const bar = (calls(out.calls, 'set_layer_timing').at(-1)!.args.items as Array<{ nodeId: string }>).find((i) => i.nodeId === 't');
    expect(bar).toEqual({ nodeId: 't', inSec: 2.4, outSec: 5.6 });
  });

  it('spells every sweep out as one crossing of the text (offset 0 → 100), unless the script says otherwise (B3)', () => {
    const s = base({
      beats: [{
        name: 'A', purpose: '', startSec: 1, endSec: 6,
        layers: [
          { id: 'in', kind: 'text', name: 'In', text: 'Hi', textAnimators: [{ opacity: 0, sweep: { from: 0, to: 1 } }] },
          { id: 'out', kind: 'text', name: 'Out', text: 'Bye', textAnimators: [{ opacity: 0, sweep: { from: 2, to: 3, fromOffset: 100, toOffset: 0 } }] },
        ],
      }],
    });
    const sweeps = calls(compileScript(s).calls, 'text_animator').map((c) => c.args.sweep);
    expect(sweeps).toEqual([
      { fromSec: 1, toSec: 2, fromOffset: 0, toOffset: 100 },
      { fromSec: 3, toSec: 4, fromOffset: 100, toOffset: 0 },
    ]);
    // Never the old −100 → 100, which covers the text only mid-sweep.
    for (const sw of sweeps as Array<{ fromOffset: number; toOffset: number }>) expect(sw.fromOffset).not.toBe(-100);
  });

  it('leaves an unplaced adjustment layer to create_layer, which centres full-frame layers on the comp (B1)', () => {
    const s = base({
      beats: [{
        name: 'A', purpose: '', startSec: 0, endSec: 6,
        layers: [
          { id: 'rain', kind: 'adjustment', name: 'Rain', effects: [{ id: 'fx', type: 'rainfall' }] },
          { id: 'grade', kind: 'adjustment', name: 'Grade', props: { x: 480, y: 270, width: 960, height: 540 } },
        ],
      }],
    });
    const out = compileScript(s);
    const created = calls(out.calls, 'create_layer');
    // No x/y of its own: the compiler pins nothing (and never 0,0 — the origin is the comp's corner).
    expect(created.find((c) => c.args.id === 'rain')).toEqual({ name: 'create_layer', args: { id: 'rain', kind: 'adjustment', name: 'Rain' } });
    // A placed, sized one keeps what the script said.
    expect(created.find((c) => c.args.id === 'grade')!.args).toMatchObject({ x: 480, y: 270, width: 960, height: 540 });
    expect(calls(out.calls, 'update_layer').filter((c) => c.args.nodeId === 'rain')).toEqual([]);
  });

  it('resolves palette references and type styles, and writes nothing the script did not say', () => {
    const s = base({
      beats: [{
        name: 'A', purpose: '', startSec: 0, endSec: 6,
        layers: [
          { id: 'title', kind: 'text', name: 'Title', text: 'Hello', typeStyle: 'h1', props: { fill: '$ink', x: 960, y: 500, fontSize: 140 } },
          { id: 'dot', kind: 'shape', name: 'Dot', shape: 'ellipse' },
        ],
      }],
    });
    const out = compileScript(s);
    expect(calls(out.calls, 'update_composition')[0]!.args).toEqual({ background: '#101014' });
    const create = calls(out.calls, 'create_layer').find((c) => c.args.id === 'title')!.args;
    expect(create).toEqual({ id: 'title', kind: 'text', name: 'Title', text: 'Hello', fill: '#fafafa', x: 960, y: 500 });
    const upd = calls(out.calls, 'update_layer').find((c) => c.args.nodeId === 'title')!.args;
    // The explicit fontSize wins over the style's; the rest comes from the style.
    expect(upd).toEqual({ nodeId: 'title', fontFamily: 'Inter', fontWeight: 700, fontSize: 140, letterSpacing: -3, lineHeight: 0.95 });
    // The dot said nothing about size, colour or place — so nothing is sent.
    expect(calls(out.calls, 'create_layer').find((c) => c.args.id === 'dot')!.args).toEqual({ id: 'dot', kind: 'shape', name: 'Dot', shape: 'ellipse' });
    expect(calls(out.calls, 'update_layer').find((c) => c.args.nodeId === 'dot')).toBeUndefined();
  });

  it('gives trims, repeaters and path operators handles so their keys land in the same batch', () => {
    const s = base({
      beats: [{
        name: 'A', purpose: '', startSec: 1, endSec: 6,
        layers: [{
          id: 'ring', kind: 'shape', name: 'Ring', shape: 'ellipse',
          trim: { keys: { end: [{ t: 0, v: 0 }, { t: 1, v: 100 }] } },
          repeaters: [{ copies: 6, rotation: 60, keys: { offset: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } }],
          pathOps: [{ op: 'roughen', amount: 4, keys: { amount: [{ t: 0, v: 0 }, { t: 2, v: 8 }] } }],
        }],
      }],
    });
    const out = compileScript(s);
    // A trim the script only keyed opens at its first key's value — the script's number, not a default.
    expect(calls(out.calls, 'set_trim_path')[0]!.args).toEqual({ nodeId: 'ring', id: trimHandle('ring'), end: 0 });
    expect(calls(out.calls, 'add_repeater')[0]!.args).toEqual({ nodeId: 'ring', id: 'ring__rep0', copies: 6, rotation: 60 });
    expect(calls(out.calls, 'add_path_operator')[0]!.args).toEqual({ nodeId: 'ring', id: 'ring__op0', op: 'roughen', amount: 4 });
    const props = calls(out.calls, 'set_keyframes').flatMap((c) => (c.args.keyframes as Array<{ prop: string }>).map((k) => k.prop));
    expect(new Set(props)).toEqual(new Set(['pathop.ring__trim.end', 'pathop.ring__rep0.offset', 'pathop.ring__op0.amount']));
  });

  it('puts front globals under their own root after the beats, and back globals first', () => {
    const s = base({
      globals: [
        { id: 'bg', kind: 'gradient', name: 'BG', gradient: { stops: ['$bg', '#000000'] } },
        { id: 'grain', kind: 'adjustment', name: 'Grain', stack: 'front', effects: [{ type: 'noise', params: { amount: 4 } }] },
      ],
      beats: [{ name: 'A', purpose: '', startSec: 0, endSec: 6, layers: [] }],
    });
    const out = compileScript(s);
    expect(out.calls.slice(out.head.start, out.head.end).map((c) => c.name)).toEqual(['update_composition', 'create_gradient']);
    const tail = out.calls.slice(out.tail.start, out.tail.end);
    expect(tail[0]!.args.id).toBe(TAIL_ROOT);
    expect(tail).toContainEqual({ name: 'update_effect_param', args: { nodeId: 'grain', effectId: 'noise', key: 'amount', value: 4 } });
    expect(calls(out.calls, 'create_gradient')[0]!.args).toMatchObject({ stops: ['#101014', '#000000'], placement: 'top' });
  });

  it('turns a uniform scale into the two axes and a camera depth into its opening key', () => {
    const s = base({
      beats: [{
        name: 'A', purpose: '', startSec: 0, endSec: 6,
        layers: [
          { id: 'n', kind: 'null', name: 'N', props: { scale: 1.5, scaleY: 2 } },
          { id: 'cam', kind: 'camera', name: 'Cam', props: { z: -1800, focalLength: 1600 } },
        ],
      }],
    });
    const out = compileScript(s);
    expect(calls(out.calls, 'update_layer').find((c) => c.args.nodeId === 'n')!.args).toEqual({ nodeId: 'n', scaleX: 1.5, scaleY: 2 });
    expect(calls(out.calls, 'update_layer').find((c) => c.args.nodeId === 'cam')!.args).toEqual({ nodeId: 'cam', focalLength: 1600 });
    const kf = calls(out.calls, 'set_keyframes')[0]!.args.keyframes;
    expect(kf).toEqual([{ nodeId: 'cam', prop: 'z', t: 0, value: -1800 }]);
  });

  it('rebuilds only the beats asked for: wipe their roots and the tail, replay, then the tail', () => {
    const ex = AUTHOR_EXEMPLARS.find((e) => e.id === 'product_reveal')!.script;
    const out = compileScript(ex);
    const rebuilt = rebuildCalls(out, [1]);
    expect(rebuilt[0]).toEqual({ name: 'delete_layer', args: { nodeIds: ['beat_1', TAIL_ROOT] } });
    const r = out.byBeat[1]!;
    expect(rebuilt.slice(1, 1 + (r.end - r.start))).toEqual(out.calls.slice(r.start, r.end));
    expect(rebuilt.slice(1 + (r.end - r.start))).toEqual(out.calls.slice(out.tail.start, out.tail.end));
    expect(rebuildCalls(out, [])).toEqual([]);
  });

  it('places a generated clip at its in point and keeps the call inside the schema', () => {
    const s = base({
      beats: [{
        name: 'A', purpose: '', startSec: 2, endSec: 6,
        layers: [{ id: 'plate', kind: 'video', name: 'Plate', inSec: 0.5, video: { prompt: 'slow drift over a misty pine forest', durationSec: 5, aspect: 'landscape', fit: 'cover' }, props: { opacity: 80 } }],
      }],
    });
    const out = compileScript(s);
    const gen = calls(out.calls, 'generate_video')[0]!;
    expect(gen.args).toEqual({ id: 'plate', prompt: 'slow drift over a misty pine forest', durationSec: 5, aspect: 'landscape', fit: 'cover', startSec: 2.5 });
    const def = ALL_TOOL_DEFS.find((d) => d.name === 'generate_video')!;
    expect(validate(def.inputSchema, gen.args).ok).toBe(true);
    const bar = (calls(out.calls, 'set_layer_timing').at(-1)!.args.items as Array<Record<string, unknown>>).find((i) => i.nodeId === 'plate');
    expect(bar).toEqual({ nodeId: 'plate', inSec: 2.5, outSec: 6, startSec: 2.5 });
  });

  it('batches keyframes at the schema limit', () => {
    const keys = Array.from({ length: 250 }, (_, i) => ({ t: i * 0.01, v: i }));
    const s = base({ beats: [{ name: 'A', purpose: '', startSec: 0, endSec: 6, layers: [{ id: 'n', kind: 'null', name: 'N', keys: { x: keys } }] }] });
    const kf = calls(compileScript(s).calls, 'set_keyframes');
    expect(kf.map((c) => (c.args.keyframes as unknown[]).length)).toEqual([200, 50]);
  });

  it('compiles a coerced script exactly as it compiles the original when nothing needed repair', () => {
    for (const ex of AUTHOR_EXEMPLARS) {
      const c = coerceScript(JSON.parse(JSON.stringify(ex.script)), { ...CTX, durationSec: ex.script.durationSec });
      expect(c.repairs).toEqual([]);
      expect(compileScript(c.value).calls).toEqual(compileScript(ex.script).calls);
    }
  });
});

describe('program M7: precompose, frame-snapped keys, gradient stops', () => {
  const raw = {
    title: 't', intent: 'i', background: '#000000', palette: { ink: '#ffffff' },
    beats: [{
      name: 'Crowd', startSec: 0, endSec: 6,
      layers: [
        { id: 'a', kind: 'shape', name: 'A', props: { x: 100, y: 100 } },
        { id: 'b', kind: 'shape', name: 'B', props: { x: 200, y: 100 } },
        { id: 'c', kind: 'shape', name: 'C', props: { x: 300, y: 100 }, keys: { opacity: [[1.0, 0], [1.01, 100]] } },
      ],
      precompose: [
        { id: 'crowd', name: 'Crowd group', layers: ['a', 'b', 'ghost'], props: { scale: 0.5 }, keys: { x: [[0, 0], [2, 400]] } },
        { id: 'dup', name: 'Dup', layers: ['a'] },
      ],
    }],
  };

  it('pre-composes a beat\'s layers after building them, with the group\'s own props and keys', () => {
    const c = coerceScript(raw, CTX);
    expect(c.value.beats[0]!.precompose).toEqual([{ id: 'crowd', name: 'Crowd group', layers: ['a', 'b'], props: { scale: 0.5 }, keys: { x: [{ t: 0, v: 0 }, { t: 2, v: 400 }] } }]);
    expect(c.repairs.map((r) => r.message).join('\n')).toMatch(/'ghost' is not a layer of this beat/);
    expect(c.repairs.map((r) => r.message).join('\n')).toMatch(/already in another precompose group/);
    const out = compileScript(c.value);
    const names = out.calls.map((x) => x.name);
    const pc = names.indexOf('create_precomp');
    expect(pc).toBeGreaterThan(names.lastIndexOf('create_layer'));
    expect(out.calls[pc]!.args).toEqual({ id: 'crowd', nodeIds: ['a', 'b'], name: 'Crowd group' });
    // Under the beat's root (its wipe takes it), then its own props.
    expect(out.calls[pc + 1]).toEqual({ name: 'reparent_layer', args: { nodeId: 'crowd', parentId: 'beat_0' } });
    expect(out.calls[pc + 2]).toEqual({ name: 'update_layer', args: { nodeId: 'crowd', scaleX: 0.5, scaleY: 0.5 } });
    expect(out.beatOfLayer.get('crowd')).toBe(0);
  });

  it('reports keys of one property that land on one frame', () => {
    const out = compileScript(coerceScript(raw, CTX).value);
    const hits = sameFrameKeys(out, 30);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^c opacity: keys at 1s, 1.01s share frame 30 at 30 fps/);
    expect(sameFrameKeys(out, 240)).toEqual([]);
  });

  it('F5: brush paint and stroke-only shapes compile to calls the schemas accept', () => {
    const c = coerceScript({
      title: 't', intent: 'i', background: '#000', palette: { ink: '#151210' },
      grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
      beats: [{
        name: 'Brush', startSec: 2, endSec: 6,
        layers: [
          { id: 'canvas', kind: 'shape', name: 'Canvas', props: { x: 960, y: 540, width: 1920, height: 1080, fill: 'none' },
            paint: [{ points: [[100, 500, 0.2], [500, 520, 1], [900, 500, 0.2]], color: '$ink', size: 48, minSize: 8, reveal: { from: 0.5, to: 1.5 } }] },
          { id: 'ring', kind: 'shape', shape: 'ellipse', name: 'Ring', props: { width: 300, height: 300, fill: 'none', stroke: '$ink', strokeWidth: 8 },
            trim: { keys: { end: [[0, 0], [1, 100]] } } },
        ],
      }],
    }, CTX);
    expect(c.repairs).toEqual([]);
    const out = compileScript(c.value);
    const paintCall = calls(out.calls, 'paint_strokes')[0]!;
    expect(paintCall.args).toMatchObject({ nodeId: 'canvas', strokes: [{ color: '#151210', size: 48, minSize: 8, reveal: { from: 2.5, to: 3.5 } }] });
    expect(calls(out.calls, 'create_layer').find((x) => x.args.id === 'ring')!.args.fill).toBe('none');
    const defs = new Map(ALL_TOOL_DEFS.map((d) => [d.name, d]));
    for (const call of out.calls) {
      const r = validate(defs.get(call.name)!.inputSchema, call.args);
      expect({ call: call.name, ok: r.ok, errors: r.ok ? [] : r.errors }).toEqual({ call: call.name, ok: true, errors: [] });
    }
  });

  it('takes { color } stop objects for their colour and says offsets are ignored', () => {
    const c = coerceScript({
      title: 't', intent: 'i', background: '#000', palette: {},
      globals: [{ id: 'sky', kind: 'gradient', name: 'Sky', gradient: { stops: [{ color: '#050303', offset: 0 }, { colour: '#5e2415', offset: 1 }] } }],
      beats: [],
    }, CTX);
    expect(c.value.globals[0]!.gradient!.stops).toEqual(['#050303', '#5e2415']);
    expect(c.repairs.some((r) => /offsets ignored/.test(r.message))).toBe(true);
  });
});
