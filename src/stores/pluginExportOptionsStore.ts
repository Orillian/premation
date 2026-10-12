/**
 * P7c: the user's option values for native plugin output modules
 * (`plugin:<id>/<module>` export formats, layout/Export/pluginFormats.tsx), per
 * format, for this session. Editor state: never the project document.
 */

import { create } from 'zustand';

export type PluginOptionValues = Record<string, number | boolean>;

interface PluginExportOptionsState {
  values: Record<string, PluginOptionValues>;
  set: (format: string, id: string, value: number | boolean) => void;
}

export const usePluginExportOptions = create<PluginExportOptionsState>((set) => ({
  values: {},
  set: (format, id, value) => set((s) => ({ values: { ...s.values, [format]: { ...s.values[format], [id]: value } } })),
}));
