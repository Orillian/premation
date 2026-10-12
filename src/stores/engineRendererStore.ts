/**
 * What the running engine renders WITH — editor state, read once per engine
 * from `getCapabilities` (E8, docs/PROGRAM_3D_PERF_UX.md): a GPU engine draws
 * the 3D ground grid itself (depth-tested against the scene, setViewport
 * `groundGrid`), so the SVG overlay grid stands down; the headless / no-GPU
 * engine draws no frames of its own and the overlay keeps drawing it.
 *
 * `gpu` is null until the first answer: the overlay treats "unknown" as "no
 * engine grid" so a viewport never sits without a floor while the query is in
 * flight.
 */

import { create } from 'zustand';

interface EngineRendererState {
  /** The engine renders on a GPU adapter (getCapabilities.gpuAdapter non-empty); null = not asked yet. */
  gpu: boolean | null;
  setGpu(gpu: boolean | null): void;
}

export const useEngineRendererStore = create<EngineRendererState>((set) => ({
  gpu: null,
  setGpu: (gpu) => set((s) => (s.gpu === gpu ? s : { gpu })),
}));

/** True when the engine draws the ground grid into its frames (a GPU engine). */
export function engineDrawsGroundGrid(): boolean {
  return useEngineRendererStore.getState().gpu === true;
}
