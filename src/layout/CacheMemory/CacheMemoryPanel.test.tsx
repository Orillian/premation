import { render, screen, fireEvent } from '@testing-library/react';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { CacheMemoryPanel } from './CacheMemoryPanel';
import { healthCopy } from './memoryCopy';
import { setCacheMemoryView } from './cacheMemoryView';
import { readMemory } from '@core/perf/memoryHealth';

// No engine in a unit test: the sampler's query rejects and the panel shows
// what it shows before the first answer.
jest.mock('@core/engine/engineInstance', () => ({
  engine: () => ({ query: () => Promise.reject(new Error('no engine')) }),
  subscribeEngine: () => () => {},
}));
// Nor a document: no active composition (30 fps), an empty cache lane.
jest.mock('@hooks/useMirror', () => ({
  useActiveMirrorComp: () => null,
  compFps: () => 30,
  useActiveCompId: () => undefined,
  useMirror: () => ({}),
  useMirrorKeys: () => 0,
}));
jest.mock('@layout/Timeline/CacheActions', () => ({
  usePreviewCacheStats: () => ({ stats: { cached: 0, onDisk: 0, total: 0, workArea: true, ramMb: 0, diskMb: null }, refresh: () => {} }),
}));
jest.mock('@layout/Timeline/previewCacheCommands', () => ({
  cacheWorkAreaNow: jest.fn(),
  cacheWorkAreaUnavailable: () => 'No composition',
  canCacheWorkArea: () => false,
  purgeDiskCache: jest.fn(),
  purgeRamPreview: jest.fn(),
}));

describe('CacheMemoryPanel', () => {
  beforeEach(() => {
    setCacheMemoryView('overview');
    usePreferenceStore.getState().set('cacheBeforePlayback', false);
    usePreferenceStore.getState().set('idleRenderAhead', true);
  });

  it('says it is waiting for the engine, then switches between its three views', () => {
    render(<CacheMemoryPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading the engine');
    expect(screen.getByText('RAM previews')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Location' }));
    expect(screen.getByText('Disk Cache')).toBeInTheDocument();
    expect(screen.getByText('Drives')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Diagnostics' }));
    expect(screen.getByText('Engine memory')).toBeInTheDocument();
    expect(screen.getByText('No restarts or memory warnings.')).toBeInTheDocument();
  });

  it('opens on Health when asked (the status bar dot) and says when no composition is open', () => {
    setCacheMemoryView('health');
    render(<CacheMemoryPanel />);
    expect(screen.getByRole('radio', { name: 'Health' })).toBeChecked();
    expect(screen.getByText('Open a composition to see its health.')).toBeInTheDocument();
    expect(screen.getByText('Suggestions')).toBeInTheDocument();
  });

  it('writes the preview switches and the resolution choice', () => {
    render(<CacheMemoryPanel />);
    fireEvent.click(screen.getByRole('switch', { name: 'Cache before playback' }));
    expect(usePreferenceStore.getState().cacheBeforePlayback).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Fill the cache while idle' }));
    expect(usePreferenceStore.getState().idleRenderAhead).toBe(false);

    fireEvent.click(screen.getByRole('radio', { name: 'Half' }));
    expect(useRenderQualityStore.getState()).toMatchObject({ adaptive: false, resolution: 2 });
    fireEvent.click(screen.getByRole('radio', { name: 'Auto' }));
    expect(useRenderQualityStore.getState()).toMatchObject({ adaptive: true, resolution: 1 });
  });
});

describe('healthCopy', () => {
  const stats = { gpuFrameMs: 0, cpuFrameMs: 0, fps: 0, droppedFrames: 0, vramBytes: 0, ramCacheBytes: 2 * 1024 ** 3, diskCacheBytes: 0, cacheHitRate: 0, decodeMs: 0, ramCacheBudget: 12 * 1024 ** 3, engineMemoryBytes: 6 * 1024 ** 3 };

  it('names the budget when healthy and the growth when growing', () => {
    const r = readMemory(stats);
    expect(healthCopy({ kind: 'healthy' }, r).body).toContain('2.0 GB of 12 GB');
    const growing = healthCopy({ kind: 'growing', growthPerMin: 80 * 1024 ** 2 }, r);
    expect(growing.title).toBe('Engine memory keeps growing');
    expect(growing.body).toContain('80 MB');
  });
});
