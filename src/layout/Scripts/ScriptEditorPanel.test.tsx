/**
 * The Script Editor panel: Tab indents, Ctrl+Enter runs, the console shows a
 * run's output and its error line; and the consent dialog answers the core's
 * prompt with what the user chose.
 */

const runScript = jest.fn();
const setScriptConsentPrompt = jest.fn();
jest.mock('@core/scripting/scriptHost', () => ({ runScript, setScriptConsentPrompt }));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScriptEditorPanel } from './ScriptEditorPanel';
import { askScriptConsent, installScriptConsentPrompt } from './scriptConsent';
import { useScriptsStore } from '@stores/scriptsStore';
import { ModalHost } from '@layout/overlays/ModalHost';

beforeEach(() => {
  runScript.mockReset();
  useScriptsStore.setState({ source: 'var a = 1;', fileName: 'Test.jsx', console: [], running: false, dirty: false });
});

describe('ScriptEditorPanel', () => {
  it('Tab inserts two spaces at the caret', () => {
    render(<ScriptEditorPanel />);
    const code = screen.getByLabelText('Script source') as HTMLTextAreaElement;
    code.setSelectionRange(0, 0);
    fireEvent.keyDown(code, { key: 'Tab' });
    expect(useScriptsStore.getState().source).toBe('  var a = 1;');
  });

  it('Ctrl+Enter runs the buffer; logs, the error and its line reach the console and gutter', async () => {
    runScript.mockImplementation(async (_src: string, opts: { onLog: (l: string, t: string) => void }) => {
      opts.onLog('log', 'hello from the script');
      return { ok: false, error: 'boom', errorLine: 1, outcome: 'rolledBack', logs: ['hello from the script'] };
    });
    const { container } = render(<ScriptEditorPanel />);
    const code = screen.getByLabelText('Script source');
    await act(async () => {
      fireEvent.keyDown(code, { key: 'Enter', ctrlKey: true });
    });
    await waitFor(() => expect(screen.getByText('boom (line 1)')).toBeTruthy());
    expect(runScript).toHaveBeenCalledWith('var a = 1;', expect.objectContaining({ name: 'Test', permissions: ['document.read', 'document.write'] }));
    expect(screen.getByText('hello from the script')).toBeTruthy();
    expect(container.querySelector('[data-error]')?.textContent).toBe('1');
  });
});

describe('script consent', () => {
  it('registers once as the core prompt', () => {
    installScriptConsentPrompt();
    installScriptConsentPrompt();
    expect(setScriptConsentPrompt).toHaveBeenCalledTimes(1);
    expect(setScriptConsentPrompt).toHaveBeenCalledWith(askScriptConsent);
  });

  it('shows the name and permissions; Allow Once resolves true, Cancel false', async () => {
    render(<ModalHost />);
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => { answer = askScriptConsent({ name: 'Rename Layers', permissions: ['document.read', 'document.write'] }); });
    expect(await screen.findByText('Run “Rename Layers”?')).toBeTruthy();
    expect(screen.getByText('Read the project')).toBeTruthy();
    expect(screen.getByText('Change the project')).toBeTruthy();
    act(() => { fireEvent.click(screen.getByText('Allow Once')); });
    await expect(answer).resolves.toBe(true);

    act(() => { answer = askScriptConsent({ name: 'Other', permissions: ['document.read'] }); });
    await screen.findByText('Run “Other”?');
    act(() => { fireEvent.click(screen.getByText('Cancel')); });
    await expect(answer).resolves.toBe(false);
  });
});
