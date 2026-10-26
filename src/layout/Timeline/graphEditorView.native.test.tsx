/**
 * The graph editor's VALUE-axis navigation (After Effects' vertical zoom and
 * pan, the two fit buttons) and its handles on FLAT segments.
 *
 * Rendered against the real engine rather than unit-tested, because what the
 * features promise is about the picture: a wheel tick must move the diamonds
 * you see, the view must still be where you left it after the engine answers
 * the next edit, and a handle on a flat segment must write influence to the
 * document the engine keeps. jsdom has no layout: `getBoundingClientRect` is
 * all zeros, so svg coordinates ARE client coordinates, which is what makes
 * the pointer positions below readable.
 *
 * Geometry the assertions lean on: the default graph is 200 px tall with a
 * 40 px toolbar and an unmeasured (0 px) numeric strip, so the plot is 160 px;
 * a value graph is auto-fitted to its extent padded 15 % either side.
 */

import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { GraphEditor } from './GraphEditor';
import { TooltipProvider } from '@components/Tooltip';
import { valueToY } from './graphReferenceCurve';
import { easePresetOnKeys } from './keyframeEdits';
import { rowSelectionId } from '@core/engine/__testHelpers__/selectionIds';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { clearHistory, setupAppEngine, settleEdits, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';

const PROP = 'opacity';
const INNER_H = 160;
let NODE = '';
let keyIds: string[] = [];
let h: Harness;

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}

beforeAll(() => {
  globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
});

/** A solid with Opacity keyed to `values` at 0, 1, 2 … seconds, linear. */
async function setup(values: number[]): Promise<void> {
  h = await setupAppEngine({ panels: true });
  useKeyframeSelectionStore.getState().clear();
  NODE = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'G', init: [] })).layer;
  keyIds = (await h.run({
    type: 'addKeyframes',
    keys: values.map((v, t) => ({
      prop: { layer: NODE, path: 'transform/opacity' }, time: sec(t),
      value: { kind: 'scalar' as const, value: v }, easing: 'linear' as const, spatialIn: [], spatialOut: [],
    })),
  })).ids;
  await clearHistory();
}

afterEach(async () => {
  cleanup();
  useKeyframeSelectionStore.getState().clear();
  await h.dispose();
});

let view: ReturnType<typeof render>;

async function settle(): Promise<void> {
  await act(async () => { await settleEdits(); await settleEdits(); });
}

const renderGraph = async (props: { onZoom?: (pps: number) => void } = {}): Promise<void> => {
  view = render(
    <TooltipProvider>
      <GraphEditor
        selectedNodeIds={[NODE]}
        currentTime={0}
        duration={3}
        pixelsPerSecond={60}
        scrollLeft={0}
        onZoom={props.onZoom}
      />
    </TooltipProvider>,
  );
  await waitFor(() => expect(diamonds().length).toBeGreaterThanOrEqual(3));
};

/** The diamonds' hit circles, in track order (only they carry a <title>). */
const diamonds = (): Element[] =>
  [...view.container.querySelectorAll('circle')].filter((c) => c.querySelector('title') !== null);
/** Each diamond's svg y — the plotted value through the current range. */
const diamondYs = (): number[] => diamonds().map((c) => Number(c.getAttribute('cy')));
/** The focused key's tangent handles (untitled hit circles), in → out. */
const handles = (): Element[] =>
  [...view.container.querySelectorAll('circle')].filter((c) => c.querySelector('title') === null && c.getAttribute('r') === '10');
const graphSvg = (): SVGSVGElement => diamonds()[0]!.closest('svg')!;
const canvas = (): HTMLElement => graphSvg().parentElement!;

function pick(index: number, shiftKey = false): void {
  fireEvent.pointerDown(diamonds()[index]!, { button: 0, shiftKey });
  fireEvent.pointerUp(window);
}

/** Drag `el` by (dx, dy) with pointer 1, as a user would. */
async function drag(el: Element, dx: number, dy: number): Promise<void> {
  const svg = graphSvg();
  fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  await settle(); // the drag resolves its engine key ids first
  fireEvent.pointerMove(svg, { clientX: dx / 2, clientY: dy / 2, pointerId: 1 });
  fireEvent.pointerMove(svg, { clientX: dx, clientY: dy, pointerId: 1 });
  await settle();
  fireEvent.pointerUp(svg, { pointerId: 1 });
  await settle();
}

const kfAt = async (t: number) =>
  (await docView()).getTrackKeyframes(NODE, PROP)!.find((k) => Math.abs(k.t - t) < 1e-6)!;

const closeTo = (a: number[], b: number[]): void => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));
};

describe('the value axis zooms and pans', () => {
  // 0 → 50 → 100 auto-fits to −15 … 115.
  const AUTO = [0, 50, 100].map((v) => valueToY(v, -15, 115, INNER_H));

  it('Alt + wheel zooms about the value under the pointer', async () => {
    await setup([0, 50, 100]);
    await renderGraph();
    closeTo(diamondYs(), AUTO);

    // Wheel up over the middle key (y = 80): zoom in; it stays put, the others spread 1.15×.
    fireEvent.wheel(canvas(), { deltaY: -100, altKey: true, clientY: 80 });
    const zoomed = diamondYs();
    expect(zoomed[1]).toBeCloseTo(80, 6);
    expect(zoomed[0]! - zoomed[2]!).toBeCloseTo((AUTO[0]! - AUTO[2]!) * 1.15, 6);

    // Wheel down undoes it.
    fireEvent.wheel(canvas(), { deltaY: 100, altKey: true, clientY: 80 });
    closeTo(diamondYs(), AUTO);
  });

  it('keeps the zoomed view while the document changes under it', async () => {
    await setup([0, 50, 100]);
    await renderGraph();
    fireEvent.wheel(canvas(), { deltaY: -100, altKey: true, clientY: 80 });
    const zoomed = diamondYs();
    // An engine edit re-samples every curve; the auto-fit would have run again.
    await easePresetOnKeys([rowSelectionId(NODE, PROP, 1)], 'Ease');
    await settle();
    expect((await kfAt(1)).easing).toBe('bezier');
    closeTo(diamondYs(), zoomed);
  });

  it('Shift + wheel pans: wheel down shows the lower values', async () => {
    await setup([0, 50, 100]);
    await renderGraph();
    fireEvent.wheel(canvas(), { deltaY: 32, shiftKey: true });
    // The content moved UP by the wheel's 32 px.
    closeTo(diamondYs(), AUTO.map((y) => y - 32));
    // Shift + wheel that the platform already turned horizontal pans too.
    fireEvent.wheel(canvas(), { deltaX: -32, deltaY: 0, shiftKey: true });
    closeTo(diamondYs(), AUTO);
  });

  it('a middle drag pans both axes', async () => {
    await setup([0, 50, 100]);
    await renderGraph();
    const svg = graphSvg();
    canvas().scrollLeft = 40;
    fireEvent.pointerDown(svg, { button: 1, clientX: 100, clientY: 50, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: 70, clientY: 60, pointerId: 2 });
    // The curves follow the pointer: 10 px down, and 30 px to the left (scrollLeft grows).
    closeTo(diamondYs(), AUTO.map((y) => y + 10));
    expect(canvas().scrollLeft).toBe(70);
    fireEvent.pointerUp(svg, { pointerId: 2 });
    await settle();
    // Release does not snap back to the auto-fit.
    closeTo(diamondYs(), AUTO.map((y) => y + 10));
  });

  it('Fit all graphs to view drops the manual view and fits the composition in time', async () => {
    await setup([0, 50, 100]);
    const onZoom = jest.fn();
    await renderGraph({ onZoom });
    fireEvent.wheel(canvas(), { deltaY: -100, altKey: true, clientY: 80 });
    fireEvent.wheel(canvas(), { deltaY: 32, shiftKey: true });
    expect(diamondYs()[1]).not.toBeCloseTo(AUTO[1]!, 3);

    fireEvent.click(screen.getByRole('button', { name: 'Fit all graphs to view' }));
    closeTo(diamondYs(), AUTO);
    // 3 s of composition across the 800 px jsdom viewport.
    expect(onZoom).toHaveBeenCalledWith(800 / 3);
  });

  it('Fit selection to view fits the selected keys’ values and span', async () => {
    await setup([0, 50, 100]);
    const onZoom = jest.fn();
    await renderGraph({ onZoom });
    pick(0);
    pick(1, true);
    fireEvent.click(screen.getByRole('button', { name: 'Fit selection to view' }));
    // 0 … 50 padded 15 % → −7.5 … 57.5; the third key is off the top.
    const ys = diamondYs();
    expect(ys[0]).toBeCloseTo(valueToY(0, -7.5, 57.5, INNER_H), 6);
    expect(ys[1]).toBeCloseTo(valueToY(50, -7.5, 57.5, INNER_H), 6);
    expect(ys[2]).toBeLessThan(0);
    // Keys at 0 s and 1 s, padded → 0 … 1.15 s across 800 px.
    expect(onZoom).toHaveBeenCalledWith(800 / 1.15);
  });

  it('Fit selection with nothing selected is Fit all', async () => {
    await setup([0, 50, 100]);
    await renderGraph();
    fireEvent.wheel(canvas(), { deltaY: 32, shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Fit selection to view' }));
    closeTo(diamondYs(), AUTO);
  });
});

describe('a flat segment (dv = 0) still carries its ease timing', () => {
  // 0 → 50 → 50: the second segment is flat.
  it('draws both handles of the key between a ramp and a flat segment, on the line', async () => {
    await setup([0, 50, 50]);
    await renderGraph();
    pick(1);
    const hs = handles();
    expect(hs).toHaveLength(2);
    // The out handle sits a third of the way along the flat segment, at the key's own y.
    const out = hs[1]!;
    expect(Number(out.getAttribute('cx'))).toBeCloseTo(60 + 60 / 3, 6);
    expect(Number(out.getAttribute('cy'))).toBeCloseTo(diamondYs()[1]!, 6);
  });

  it('dragging the out handle edits influence only; the y stays linear and the neighbours are untouched', async () => {
    await setup([0, 50, 50]);
    // Linked handles: the drag would otherwise re-solve the ramp's arrival to a slope of 0.
    await h.run({ type: 'updateKeyframes', patches: [{ id: keyIds[1]!, easing: 'bezier', bezier: { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 }, continuous: true, spatialIn: [], spatialOut: [] }] });
    await clearHistory();
    await renderGraph();
    pick(1);
    // +20 px along a 60 px segment → influence ⅓ + ⅓, capped just short of the incoming handle; the −10 px up is ignored.
    await drag(handles()[1]!, 20, -10);
    const k1 = await kfAt(1);
    expect(k1.easing).toBe('bezier');
    expect(k1.bezier?.[0]).toBeCloseTo(2 / 3 - 0.01, 6);
    expect(k1.bezier?.[1]).toBeCloseTo(1 / 3, 6);
    expect(k1.bezier?.[2]).toBeCloseTo(2 / 3, 6);
    expect(k1.bezier?.[3]).toBeCloseTo(2 / 3, 6);
    expect((await kfAt(0)).easing).toBe('linear');
    expect((await kfAt(2)).easing).toBe('linear');
  });

  it('in the speed graph the handle edits influence and the speed stays 0', async () => {
    await setup([0, 50, 50]);
    await renderGraph();
    fireEvent.click(screen.getByTitle('Speed graph (edit velocity & influence %)'));
    pick(1);
    const hs = handles();
    expect(hs).toHaveLength(2);
    // Speed 0 draws on the floor of the graph.
    expect(Number(hs[1]!.getAttribute('cy'))).toBeCloseTo(INNER_H, 6);
    await drag(hs[1]!, 20, -40);
    const k1 = await kfAt(1);
    expect(k1.easing).toBe('bezier');
    expect(k1.bezier?.[0]).toBeCloseTo(2 / 3 - 0.01, 6);
    expect(k1.bezier?.[1]).toBeCloseTo(1 / 3, 6);
    expect((await kfAt(2)).easing).toBe('linear');
  });

  it('Easy Ease on the key stores influence on its flat side', async () => {
    await setup([0, 50, 50]);
    await easePresetOnKeys([rowSelectionId(NODE, PROP, 1)], 'Ease');
    await settle();
    const k1 = await kfAt(1);
    expect(k1.easing).toBe('bezier');
    expect(k1.bezier?.[0]).toBeCloseTo(1 / 3, 6);  // departure into the flat segment: 33.33 % influence …
    expect(k1.bezier?.[1]).toBeCloseTo(0, 6);      // … at speed 0, as AE stores it
    expect((await kfAt(0)).bezier?.[3]).toBeCloseTo(1, 6);  // arrival from the ramp eased too
  });
});
