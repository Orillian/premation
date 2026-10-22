/**
 * The expression editor as a code editor: a pasted multi-line rig gets a line
 * number per line, Tab indents instead of leaving the field, Enter keeps the
 * indentation, and the edited source reaches the engine.
 *
 * jsdom has no layout, so the gutter is checked by its text, not its position.
 */

import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ExpressionEditor } from './ExpressionEditor';
import { clearHistory, setupAppEngine, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';

let NODE = '';
let h: Harness;

const RIG = 'var amp = 20;\nif (time > 1) {\n  wiggle(2, amp)\n} else {\n  value\n}';

beforeEach(async () => {
  h = await setupAppEngine({ panels: true });
  NODE = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] })).layer;
  await h.run({ type: 'setExpression', prop: { layer: NODE, path: 'transform/rotation' }, source: RIG, enabled: true });
  await clearHistory();
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

const editor = (): HTMLTextAreaElement => screen.getByRole('combobox', { name: /Expression for rotation/ }) as HTMLTextAreaElement;

test('a six-line rig shows six line numbers', () => {
  const { container } = render(<ExpressionEditor nodeId={NODE} prop="rotation" />);
  expect(editor().value).toBe(RIG);
  const gutter = container.querySelector('[data-expression-gutter]');
  expect(gutter?.textContent).toBe('123456');
});

test('an expression changed from outside (pick-whip, Paste, a script) replaces the open draft', async () => {
  render(<ExpressionEditor nodeId={NODE} prop="rotation" />);
  const linked = 'thisComp.layer("S").transform.opacity';
  await act(async () => {
    await h.run({ type: 'setExpression', prop: { layer: NODE, path: 'transform/rotation' }, source: linked, enabled: true });
    await settleEdits();
  });
  expect(editor().value).toBe(linked);
});

test('Tab indents the caret line, Enter keeps the indent, and the engine gets the source', async () => {
  render(<ExpressionEditor nodeId={NODE} prop="rotation" />);
  const ta = editor();
  // Caret at the end of line 3 ("  wiggle(2, amp)").
  const end = RIG.indexOf('\n} else');
  ta.setSelectionRange(end, end);
  await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }); await settleEdits(); });
  expect(editor().value).toBe(RIG.slice(0, end) + '\n  ' + RIG.slice(end));

  const at = editor().value.indexOf('wiggle');
  editor().setSelectionRange(at, at);
  await act(async () => { fireEvent.keyDown(editor(), { key: 'Tab' }); await settleEdits(); });
  expect(editor().value).toContain('    wiggle(2, amp)');
  expect((await docView()).getExpressionSrc(NODE, 'rotation')).toContain('    wiggle(2, amp)');
});
