/**
 * The Author / Library chip: it shows the mode the next run will take, it
 * writes the user's pick into the direction the run reads, and the
 * alternatives chip — re-seeded caster emits — only exists in Library mode.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { AiDirection, UseAiChat } from '@layout/Workspace/useAiChat';
import { authorModeDefault } from '@core/config/flags';

let direction: AiDirection = { variants: 1 };
const setDirection = jest.fn((patch: Partial<AiDirection>) => { direction = { ...direction, ...patch }; });

jest.mock('./AiChatContext', () => ({
  useAiChatContext: (): Partial<UseAiChat> => ({
    messages: [],
    busy: false,
    streaming: '',
    activity: '',
    pipelineStages: null,
    planItems: [],
    ready: true,
    conversations: [],
    activeConversationId: null,
    submit: jest.fn(),
    cancel: jest.fn(),
    newChat: jest.fn(),
    openConversation: jest.fn(),
    removeConversation: jest.fn(),
    hasPendingTx: false,
    pendingChanges: [],
    acceptPending: jest.fn(),
    discardPending: jest.fn(),
    isManualMode: false,
    toggleManualMode: jest.fn(),
    direction,
    setDirection,
    packs: [],
    filmstrip: [],
  }),
}));

jest.mock('@core/engine/engineStill', () => ({ engineCompStill: jest.fn(async () => null) }));

import { AiChatPanel } from './AiChatPanel';
import { TooltipProvider } from '@components/Tooltip';

/** The panel's buttons are the system's (<Button>), whose tooltips need the provider the editor shell mounts. */
const renderPanel = () => render(<TooltipProvider><AiChatPanel /></TooltipProvider>);

beforeEach(() => {
  direction = { variants: 1 };
  setDirection.mockClear();
});

describe('the mode chip', () => {
  it('shows the default mode when the user has not picked one', () => {
    renderPanel();
    expect(screen.getByTestId('ai-mode-chip').textContent).toContain(authorModeDefault() === 'author' ? 'Author' : 'Library');
  });

  it('writes the pick into the direction', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('ai-mode-chip'));
    fireEvent.click(screen.getByRole('button', { name: /^Library/ }));
    expect(setDirection).toHaveBeenCalledWith({ mode: 'library' });
  });

  it('offers alternatives only in Library mode', () => {
    direction = { variants: 1, mode: 'author' };
    const { unmount } = renderPanel();
    expect(screen.queryByText('1 direction')).toBeNull();
    unmount();
    direction = { variants: 1, mode: 'library' };
    renderPanel();
    expect(screen.getByText('1 direction')).toBeTruthy();
  });
});
