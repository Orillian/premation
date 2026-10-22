/**
 * The Preview panel, laid out as After Effects' (2026-10): the timecode, the
 * transport row (with loop and audio), then one labelled row per setting this
 * app has — Range, Step, Resolution, Draft — under group rows, and the cache
 * readout. No keyboard cheat-sheet, no second master meter (the Audio panel
 * has it).
 */

import { act, cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useProjectStore } from '@stores/projectStore';
import { getTime } from '@stores/playbackClockStore';
import { secondsToFlicks } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { audioEngine } from '@core/audio/AudioEngine';

function renderPanel() {
  return render(
    <TooltipProvider>
      <PreviewPanel />
    </TooltipProvider>,
  );
}

let h: Harness;

describe('PreviewPanel', () => {
  beforeEach(async () => {
    // The active composition, through the engine — the panel reads the mirror.
    h = await setupAppEngine();
    const s = useProjectStore.getState();
    const compId = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
    await act(async () => {
      await h.run({
        type: 'setCompositionSettings',
        comp: compId ?? 'comp_root',
        patch: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(10) },
      });
      await engineIdle();
    });
    // Reset quality store
    useRenderQualityStore.setState({
      adaptive: true,
      resolution: 1,
      draft: false,
    });
    // Reset mute state
    audioEngine.setMasterMuted(false);
  });

  afterEach(async () => {
    cleanup();
    await h.dispose();
  });

  it('is the transport row, then labelled setting rows under group rows — no HUD, cheat-sheet or meter', async () => {
    const { container } = renderPanel();
    const transport = screen.getByRole('toolbar', { name: 'Preview transport controls' });
    // The transport comes first.
    expect(container.querySelector('[role="toolbar"]')).toBe(transport);
    for (const name of ['First frame (Home)', 'Previous frame', 'Play', 'Next frame', 'Last frame (End)', /^(Enable|Disable) loop$/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    for (const name of ['Range', 'Step', 'Resolution']) expect(screen.getByRole('radiogroup', { name })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Include audio' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Draft quality' })).toBeInTheDocument();
    for (const name of ['Playback', 'Quality']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'true');
    }

    expect(screen.queryByText('Pro Keyboard Shortcuts')).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    expect(screen.queryByText('Audio Monitoring')).not.toBeInTheDocument();
    expect(screen.queryByText(/1920×1080/)).not.toBeInTheDocument();
  });

  it('toggles playback via the play button', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('sets the range from its segments', async () => {
    renderPanel();
    const range = screen.getByRole('radiogroup', { name: 'Range' });
    const radios = within(range).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Work area', 'Comp', 'From now']);

    for (const name of ['Comp', 'From now', 'Work area']) {
      fireEvent.click(within(range).getByRole('radio', { name }));
      expect(within(range).getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('the Step row sets how far the step buttons move', async () => {
    renderPanel();
    const step = screen.getByRole('radiogroup', { name: 'Step' });
    fireEvent.click(within(step).getByRole('radio', { name: '2 frames' }));
    expect(within(step).getByRole('radio', { name: '2 frames' })).toHaveAttribute('aria-checked', 'true');

    const before = getTime();
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    // Two frames at 30 fps.
    expect(getTime() - before).toBeCloseTo(2 / 30, 5);

    fireEvent.click(within(step).getByRole('radio', { name: '6 frames' }));
    expect(within(step).getByRole('radio', { name: '6 frames' })).toHaveAttribute('aria-checked', 'true');
  });

  it('sets the resolution and the draft quality', async () => {
    renderPanel();
    const resolution = screen.getByRole('radiogroup', { name: 'Resolution' });
    fireEvent.click(within(resolution).getByRole('radio', { name: 'Half' }));
    expect(useRenderQualityStore.getState().resolution).toBe(2);
    expect(useRenderQualityStore.getState().adaptive).toBe(false);

    fireEvent.click(within(resolution).getByRole('radio', { name: 'Auto' }));
    expect(useRenderQualityStore.getState().adaptive).toBe(true);

    const draft = screen.getByRole('switch', { name: 'Draft quality' });
    fireEvent.click(draft);
    expect(useRenderQualityStore.getState().draft).toBe(true);
    expect(draft).toBeChecked();

    fireEvent.click(draft);
    expect(useRenderQualityStore.getState().draft).toBe(false);
  });

  it('Include ▸ audio mutes and unmutes the preview', async () => {
    renderPanel();
    const audio = screen.getByRole('button', { name: 'Include audio' });
    expect(audio).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(audio);
    expect(audioEngine.isMasterMuted()).toBe(true);
    expect(audio).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(audio);
    expect(audioEngine.isMasterMuted()).toBe(false);
  });
});
