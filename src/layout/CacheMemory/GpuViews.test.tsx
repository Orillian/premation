import { render, screen, fireEvent } from '@testing-library/react';
import type { RenderStats } from '@motion/engine-api';
import { readMemory } from '@core/perf/memoryHealth';
import { useSelectionStore } from '@stores/selectionStore';
import { GraphicsMemory, HeaviestLayers } from './GpuViews';

const wanted = { n: 0 };
jest.mock('./engineMemory', () => ({
  wantLayerCosts: () => {
    wanted.n++;
    return () => { wanted.n--; };
  },
}));
const NAMES: Record<string, string> = { layer_7: 'Particles burst', layer_2: 'Logo precomp' };
jest.mock('@stores/documentMirror', () => ({
  documentMirror: () => ({
    layer: (id: string) => (NAMES[id] ? { id, name: NAMES[id] } : undefined),
    hasLayer: (id: string) => id in NAMES,
  }),
}));

const GiB = 1024 ** 3;
const base: RenderStats = {
  gpuFrameMs: 0, cpuFrameMs: 0, fps: 0, droppedFrames: 0, vramBytes: 0,
  ramCacheBytes: 0, diskCacheBytes: 0, cacheHitRate: 0, decodeMs: 0, layerCosts: [],
};

describe('HeaviestLayers', () => {
  beforeEach(() => useSelectionStore.getState().clear());

  it('asks for samples only while mounted, and says how to get one', () => {
    const { unmount } = render(<HeaviestLayers stats={base} budgetMs={33.3} />);
    expect(wanted.n).toBe(1);
    expect(screen.getByText(/Play or scrub to measure/)).toBeInTheDocument();
    unmount();
    expect(wanted.n).toBe(0);
  });

  it('lists layers heaviest first by name, flags one over the frame budget, and selects on click', () => {
    const stats: RenderStats = {
      ...base,
      layerCostsFrameMs: 41.5,
      layerCostsAgoMs: 400,
      layerCosts: [
        { layer: 'layer_7', kind: 'layer', gpuMs: 36.2, passes: 12 },
        { layer: 'layer_2', kind: 'layer', gpuMs: 4.1, passes: 5 },
        { layer: '', kind: 'frame', gpuMs: 1.2, passes: 3 },
      ],
    };
    render(<HeaviestLayers stats={stats} budgetMs={33.3} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Particles burst');
    expect(rows[0]).toHaveTextContent('36.2 ms');
    expect(rows[1]).toHaveTextContent('Logo precomp');
    expect(rows[2]).toHaveTextContent('Frame setup');
    expect(screen.getByText('36.2 ms')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText(/41\.50 ms GPU · just now/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Logo precomp/ }));
    expect(useSelectionStore.getState().ids).toEqual(['layer_2']);
    // The frame's own work is not a layer: nothing to select.
    expect(screen.getByRole('button', { name: /Frame setup/ })).toBeDisabled();
  });
});

describe('GraphicsMemory', () => {
  it('shows the frame cache alone where the OS does not report the card', () => {
    render(<GraphicsMemory readout={readMemory({ ...base, vramCacheBytes: GiB, vramCacheBudget: 2 * GiB })} />);
    expect(screen.getByText('Video memory')).toBeInTheDocument();
    expect(screen.getByText('1.0 GB / 2.0 GB')).toBeInTheDocument();
  });

  it('splits the card into Premation, its line and other apps, and warns near the line', () => {
    const r = readMemory({ ...base, vramCacheBytes: GiB, gpuMemoryBudget: 2 * GiB, gpuMemoryUsed: 1.9 * GiB, gpuMemoryTotal: 8 * GiB });
    render(<GraphicsMemory readout={r} />);
    expect(screen.getByText('Graphics memory')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /other apps hold 6\.0 GB of 8\.0 GB/ })).toBeInTheDocument();
    expect(screen.getByText('Other apps 6.0 GB of 8.0 GB')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('oldest cached frames move to RAM');
  });

  it('says what was given back under pressure once it is calm again', () => {
    const r = readMemory({ ...base, gpuMemoryBudget: 6 * GiB, gpuMemoryUsed: 2 * GiB, gpuMemoryTotal: 8 * GiB, gpuMemoryTrimmed: 700 * 1024 ** 2 });
    render(<GraphicsMemory readout={r} />);
    expect(screen.getByText(/700 MB given back to other apps this session/)).toBeInTheDocument();
  });
});
