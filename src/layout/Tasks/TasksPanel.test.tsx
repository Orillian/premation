import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '@stores/uiStore';
import { useLayoutStore } from '@stores/layoutStore';
import { PANEL_DEFS } from '@layout/EditorLayout/panelDefs';
import { JobTray } from '@layout/StatusBar/JobTray';
import { TasksPanel } from './TasksPanel';
import { formatElapsed, formatRemaining } from './taskTime';

const T0 = new Date('2026-10-28T12:00:00Z').getTime();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  useUIStore.setState({ jobs: [], notifications: [] });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('Tasks panel registration', () => {
  it('is an on-demand panel in PANEL_DEFS', () => {
    expect(PANEL_DEFS.find((d) => d.id === 'tasks')).toMatchObject({ title: 'Tasks', onDemand: true, closable: true });
  });
});

describe('taskTime', () => {
  it('formats elapsed time as a clock', () => {
    expect(formatElapsed(5_400)).toBe('0:05');
    expect(formatElapsed(754_000)).toBe('12:34');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
  });

  it('rounds the time left the way a person says it', () => {
    expect(formatRemaining(2_000)).toBe('almost done');
    expect(formatRemaining(41_000)).toBe('about 40 sec left');
    expect(formatRemaining(130_000)).toBe('about 2 min left');
    expect(formatRemaining(60 * 60_000)).toBe('about 1 h left');
    expect(formatRemaining(75 * 60_000)).toBe('about 1 h 15 min left');
  });
});

describe('TasksPanel', () => {
  it('shows an empty state with nothing to list', () => {
    render(<TasksPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing running');
    expect(screen.getByRole('button', { name: 'Clear finished' })).toBeDisabled();
  });

  it('lists running jobs with progress, time left and a cancel that reaches the handle', () => {
    const cancel = jest.fn();
    const ui = useUIStore.getState();
    ui.startJob({ id: 'e', label: 'Exporting promo', progress: 0, kind: 'export', cancel });
    jest.setSystemTime(T0 + 2000);
    ui.updateJob('e', { progress: 0.1, statusLine: 'Frame 30 of 300' });
    jest.setSystemTime(T0 + 12_000);
    ui.updateJob('e', { progress: 0.5 });
    render(<TasksPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('1 running');
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('Frame 30 of 300')).toBeInTheDocument();
    // 40% in 10 s → 50% left = 12.5 s.
    expect(screen.getByText('0:12 · about 15 sec left')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Exporting promo' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0:12 · stopping…')).toBeInTheDocument();
  });

  it('shows no cancel for a job without a handle', () => {
    useUIStore.getState().startJob({ id: 't', label: 'Transcribing' });
    render(<TasksPanel />);
    expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull();
  });

  it('shows finished jobs with their outcome, and clears them', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'ok', label: 'Export A' });
    jest.setSystemTime(T0 + 65_000);
    ui.finishJob('ok', { status: 'done', message: 'Export complete' });
    ui.startJob({ id: 'bad', label: 'Export B' });
    ui.finishJob('bad', { status: 'failed', message: 'Export failed', detail: 'The disk is full' });
    render(<TasksPanel />);
    expect(screen.getByText('Export complete')).toBeInTheDocument();
    expect(screen.getByText('Took 1:05')).toBeInTheDocument();
    expect(screen.getByText('The disk is full')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }));
    expect(useUIStore.getState().jobs).toHaveLength(0);
  });
});

describe('JobTray', () => {
  it('opens the Tasks panel when clicked', () => {
    const openPanel = jest.spyOn(useLayoutStore.getState(), 'openPanel').mockImplementation(() => {});
    const ui = useUIStore.getState();
    ui.startJob({ id: 'a', label: 'A' });
    ui.startJob({ id: 'b', label: 'B' });
    ui.startJob({ id: 'c', label: 'C' });
    render(<JobTray />);
    fireEvent.click(screen.getByText('+1'));
    expect(openPanel).toHaveBeenCalledWith('tasks');
    openPanel.mockRestore();
  });
});
