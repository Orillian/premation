/**
 * The editor's project-level operations, for Claude (src/core/ai/mcp/): the
 * same edits the menus and panels run — New Composition, opening a comp's tab,
 * Save, Import, New / Open Project — so a call from Claude does exactly what
 * the user's click would, undo entries and all.
 *
 * Here and not in src/core because these live in the editor's layout code,
 * which the core may not import.
 */

import { asCommandId } from '@app-types/common';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getProjectManager } from '@core/services/coreServices';
import { openProjectPath } from '@core/project/openProjectPath';
import { compRecordFromSettings } from '@core/mirror/compFacts';
import type { McpEditorOps } from '@core/ai/mcp/mcpHost';
import type { EditorProjectOps } from '@core/ai/mcp/frontDesk';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import { cloudProjectsEnabled } from '@core/config/edition';
import { createCompositionEdit } from '@layout/Composition/compositionEdits';
import { importPathsEdit } from '@layout/Assets/assetEdits';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';
import { activeCompIdNow } from './useMirror';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const mcpEditorOps: McpEditorOps = {
  async listCompositions() {
    const m = documentMirror();
    const active = activeCompIdNow();
    return {
      active: active ?? null,
      compositions: m.compIds.map((id) => {
        const c = m.comp(id);
        if (!c) return { id };
        const r = compRecordFromSettings(id, c.settings);
        return {
          id,
          name: r.name,
          width: r.width,
          height: r.height,
          fps: r.fps,
          durationSeconds: r.durationSeconds,
          background: r.background,
          layers: c.layers.length,
          active: id === active,
        };
      }),
    };
  },

  async createComposition(o) {
    try {
      const id = await createCompositionEdit({ ...o, transparent: false });
      return id ? { id } : { error: 'Premation refused to create the composition (check the size and frame rate).' };
    } catch (err) {
      return { error: `Could not create the composition: ${errText(err)}` };
    }
  },

  async setActiveComposition(compId) {
    const c = documentMirror().comp(compId);
    if (!c) {
      const ids = documentMirror().compIds.join(', ');
      return { error: `No composition '${compId}'. The project has: ${ids || 'none'} (list_compositions).` };
    }
    const name = compRecordFromSettings(compId, c.settings).name;
    useProjectStore.getState().actions.openTab(compId, [compId], name);
    return { ok: true, name };
  },

  async save() {
    try {
      await getCommandSystem().execute(asCommandId('project.save'));
      return {
        ok: true,
        message: cloudProjectsEnabled()
          ? 'Saved (cloud projects also save themselves as you go).'
          : 'Saved. If the project had never been saved, Premation asked the user where.',
      };
    } catch (err) {
      return { error: `Could not save: ${errText(err)}` };
    }
  },

  async importMedia(paths, placeOnTimeline) {
    try {
      const r = await importPathsEdit(paths);
      const lines: string[] = [];
      if (r.imported.length) {
        lines.push(`Imported ${r.imported.length}: ${r.imported.map((a) => `${a.name} (${a.id})`).join(', ')}.`);
        if (placeOnTimeline) {
          const layers = await insertMediaEdit(r.imported, { atPlayhead: true });
          if (layers?.length) lines.push(`Placed on the active composition as layers ${layers.join(', ')}.`);
        }
      }
      for (const f of r.failed) lines.push(`Could not import ${f}${r.reasons?.[f] ? `: ${r.reasons[f]}` : ''}.`);
      return r.imported.length ? { ok: true, message: lines.join('\n') } : { error: lines.join('\n') || 'Nothing was imported.' };
    } catch (err) {
      return { error: `Could not import: ${errText(err)}` };
    }
  },
};

/** New / open project for the local edition (the start screen's own commands). */
export const mcpEditorProjectOps: EditorProjectOps = {
  async newProject(o) {
    const before = getProjectManager().getState().current?.id ?? null;
    await getCommandSystem().execute(asCommandId('project.new'));
    const after = getProjectManager().getState().current;
    // The user kept their unsaved project when asked to discard it.
    if (!after || after.id === before) return { error: 'The user kept the project that was open (Premation asked before discarding unsaved changes).' };
    const comp = await createCompositionEdit({ ...o, transparent: false });
    if (!comp) return { error: 'The project was created but its composition was refused.' };
    return { id: after.id };
  },

  async openPath(path) {
    try {
      const ref = await openProjectPath(path);
      return ref ? { id: ref.id, name: ref.name } : { error: `Could not open ${path}.` };
    } catch (err) {
      return { error: `Could not open ${path}: ${errText(err)}` };
    }
  },
};
