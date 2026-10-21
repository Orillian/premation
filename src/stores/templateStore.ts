/**
 * Template store — the active fill-in-the-blanks template and its field values.
 * `apply` builds a template's scene and seeds the value map from field defaults;
 * `setField` writes the change through the engine API (templateFieldEdits.ts —
 * the caller's `send` puts it in a typing / scrub gesture) and keeps the value
 * map in sync so the panel's controls stay live.
 */

import { create } from 'zustand';
import type { TemplateDefinition, TemplateField } from '@core/template/templateTypes';
import { getTemplate } from '@core/template/registry';
import { mergedFields, mirrorAuthoredFields } from '@layout/Templates/templateAuthoringEdits';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import type { Command } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { buildTemplateFragment } from '@/engine-client/templateFragment';
import { layerIdsOfComp } from '@core/mirror/docFacts';
import { compTime } from '@core/engine/propRefs';
import { hexToColor } from '@core/engine/model';
import { fillMediaFieldEdit, isMediaField, templateFieldEditCommands, templateFieldValues } from '@layout/Templates/templateFieldEdits';
import { useLayoutStore } from './layoutStore';
import { getTime } from './playbackClockStore';
import { useSelectionStore } from './selectionStore';
import { useProjectStore } from './projectStore';
import type { TemplatePayload } from '@core/library/premium/packFormat';
import { elementRoot, preparedLayers, type ImportedRef, type PlacementTarget } from '@core/library/premium/templatePayload';
import { encodeFragmentLayers } from '@/engine-client/fragmentBuilder';
import { mirrorPristineCompToAdopt, settingsFps } from '@core/mirror/compFacts';
import { itemAsset } from '@core/mirror/itemAssets';

/** A pack asset's base64 bytes. */
function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Where a field's commands go: a gesture of the caller's control, else one `edit`. */
export type TemplateFieldSend = (label: string, cmds: Command[]) => void;

const editNow: TemplateFieldSend = (label, cmds) => { void edit(label, cmds); };

interface TemplateState {
  /** The template currently loaded for fill-in editing, or null (gallery view). */
  active: TemplateDefinition | null;
  /** Current value per field id (controlled-input source of truth). */
  values: Record<string, string | number>;
  /**
   * Replace the active composition's contents with a template (one undo
   * entry): its layers go, the template's comp settings and layers come in.
   */
  apply: (id: string) => Promise<void>;
  /**
   * Insert a premium template payload (one undo entry). A `scene` lands in a
   * NEW composition made to its settings (or the fresh project's untouched
   * placeholder comp) and never touches the user's existing work; an `element`
   * lands in the active composition, centred, scaled to its height, starting
   * at the playhead. Either way its fields open for fill-in. Resolves to
   * whether it landed (a refusal is already reported).
   */
  applyPayload: (item: { id: string; name: string }, payload: TemplatePayload) => Promise<boolean>;
  /** Enter fill-in mode for the CURRENT composition using the fields the user
   *  authored on it (no rebuild — the scene already exists). No-op if none. */
  previewAuthored: () => void;
  /**
   * Write one field (one undo entry, or into the caller's gesture through
   * `send`). A field the engine does not address is left as it is.
   */
  setField: (fieldId: string, value: string | number, send?: TemplateFieldSend) => void;
  /**
   * Fill a MEDIA field with a picked file: imported, then the slot layer's
   * source swapped and reframed (templateFieldEdits.fillMediaFieldEdit).
   */
  fillMediaField: (fieldId: string, file: File) => Promise<void>;
  /** Leave fill-in mode (back to the gallery); the built scene stays as-is. */
  exit: () => void;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  active: null,
  values: {},
  apply: async (id) => {
    const t = getTemplate(id);
    if (!t) return;
    // B3z: ONE gesture = one undo entry, through the engine. The legacy
    // `build()` cleared the WHOLE scene graph (every composition's layers) and
    // wrote the comp record; here the ACTIVE composition's layers are deleted,
    // the template's settings sent as `setCompositionSettings`, and its layout +
    // choreography laid into a pasteLayers fragment by the engine client
    // (engine-client/templateFragment.ts — no scratch run of the TypeScript
    // scene graph) and pasted.
    const comp = activeCompIdNow() ?? 'comp_root';
    const label = `Apply ${t.name}`;
    const client = engine();
    const opened = await client.beginGesture(label);
    if (!opened.ok) {
      reportEngineError(label, opened.error);
      return;
    }
    let fields = t.fields;
    const run = async (): Promise<boolean> => {
      const old = layerIdsOfComp(comp);
      if (old.length > 0) {
        const del = await client.batch(label, [{ type: 'deleteLayers', layers: old } as Command]);
        if (!del.ok) { reportEngineError(label, del.error); return false; }
      }
      let built;
      try {
        built = buildTemplateFragment(t, comp);
      } catch (err) {
        reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
        return false;
      }
      const cmds: Command[] = [];
      if (t.settings) {
        cmds.push({
          type: 'setCompositionSettings', comp,
          patch: {
            width: t.width, height: t.height,
            frameRate: { num: t.settings.fps, den: 1 },
            duration: compTime(t.settings.durationSeconds),
            background: hexToColor(t.settings.background),
          },
        } as Command);
      }
      if (built) cmds.push({ type: 'pasteLayers', comp, fragment: built.fragment, index: 0 } as Command);
      const res = await client.batch(label, cmds);
      if (!res.ok) { reportEngineError(label, res.error); return false; }
      if (built) {
        // The fields target the template's authored ids; the engine minted new ones.
        const ids = ((res.value.at(-1) as { layers?: string[] } | undefined)?.layers) ?? [];
        const map = new Map(built.scratchIds.map((s, i) => [s, ids[i]!]));
        fields = t.fields.map((f) => (map.has(f.target.nodeId) ? { ...f, target: { ...f.target, nodeId: map.get(f.target.nodeId)! } } : f));
        useSelectionStore.getState().set([]);
      }
      // The fields live on the composition, so Essential Graphics finds them after a reload.
      const saved = await client.batch(label, [{ type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify(fields) } } as Command]);
      if (!saved.ok) { reportEngineError(label, saved.error); return false; }
      return true;
    };
    const ok = await run();
    const closed = await client.endGesture(opened.value.gesture, ok);
    if (!closed.ok) reportEngineError(label, closed.error);
    if (!ok) return;

    const values: Record<string, string | number> = {};
    for (const f of fields) values[f.id] = f.default;
    set({ active: { ...t, fields }, values });
  },
  applyPayload: async (item, p) => {
    const element = p.mode === 'element';
    const label = element ? `Insert ${item.name}` : `New ${item.name}`;
    const client = engine();
    const opened = await client.beginGesture(label);
    if (!opened.ok) {
      reportEngineError(label, opened.error);
      return false;
    }
    let fields = p.fields;
    let comp = '';
    let pastedTop: string | undefined;
    const run = async (): Promise<boolean> => {
      // 1. The pack's own files (soundtrack, textures) — asset ids are minted here, so
      //    the layers' placeholders are rewritten before the paste.
      const imported: ImportedRef[] = [];
      for (const a of p.assets) {
        const res = await client.execute({ type: 'importBytes', files: [{ name: a.name, data: base64Bytes(a.data), mimeType: a.mime }] } as Command);
        const id = res.ok ? (res.value as { items?: string[] }).items?.[0] : undefined;
        const info = id ? await client.query({ type: 'getItems', items: [id] }) : null;
        const asset = info && info.ok ? itemAsset(info.value.items[0]!) : null;
        if (!asset) { reportEngineError(label, { code: 'internal', message: `could not import ${a.name}` }); return false; }
        imported.push({ ref: a.ref, id: asset.id, src: asset.src });
      }
      // 2. Where it lands.
      let target: PlacementTarget | null = null;
      const s = p.settings;
      if (element) {
        comp = activeCompIdNow() ?? 'comp_root';
        const cs = documentMirror().comp(comp)?.settings;
        target = { width: cs?.width ?? s.width, height: cs?.height ?? s.height, fps: settingsFps(cs, s.fps), t0: getTime() };
      } else {
        const patch = {
          name: item.name, width: s.width, height: s.height,
          frameRate: { num: s.fps, den: 1 },
          duration: compTime(s.durationSeconds),
          background: hexToColor(s.background),
        };
        const adopt = mirrorPristineCompToAdopt(documentMirror());
        if (adopt) {
          const res = await client.batch(label, [{ type: 'setCompositionSettings', comp: adopt, patch } as Command]);
          if (!res.ok) { reportEngineError(label, res.error); return false; }
          comp = adopt;
        } else {
          const res = await client.batch(label, [{ type: 'createComposition', settings: patch, fromItems: [] } as Command]);
          if (!res.ok) { reportEngineError(label, res.error); return false; }
          comp = (res.value[0] as { item: string }).item;
        }
      }
      // 3. The paste — last in its batch, so its answer is the minted ids.
      let layers;
      try {
        layers = preparedLayers(p, imported, target);
      } catch (err) {
        reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
        return false;
      }
      const res = await client.batch(label, [{ type: 'pasteLayers', comp, fragment: encodeFragmentLayers(layers), index: 0 } as Command]);
      if (!res.ok) { reportEngineError(label, res.error); return false; }
      const ids = ((res.value.at(-1) as { layers?: string[] } | undefined)?.layers) ?? [];
      const map = new Map(layers.map((l, i) => [l.row.id, ids[i]!]));
      const remap = (tg: TemplateField['target']): TemplateField['target'] => (map.has(tg.nodeId) ? { ...tg, nodeId: map.get(tg.nodeId)! } : tg);
      fields = p.fields.map((f) => ({ ...f, target: remap(f.target), ...(f.alsoTargets ? { alsoTargets: f.alsoTargets.map(remap) } : {}) }));
      const root = element ? elementRoot(layers) : null;
      pastedTop = root ? map.get(root.row.id) : undefined;
      // The fields are saved on the composition (Essential Graphics reads them there, and
      // they survive a reload). An element's join the fields already there, under its name.
      const own = element ? fields.map((f) => ({ ...f, group: f.group ? `${item.name} · ${f.group}` : item.name })) : fields;
      const all = mergedFields(element ? mirrorAuthoredFields(comp) : [], own);
      fields = all.slice(all.length - own.length);
      const saved = await client.batch(label, [{ type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify(all) } } as Command]);
      if (!saved.ok) { reportEngineError(label, saved.error); return false; }
      return true;
    };
    const ok = await run();
    const closed = await client.endGesture(opened.value.gesture, ok);
    if (!closed.ok) reportEngineError(label, closed.error);
    if (!ok) return false;

    // Editor state: the new scene's tab, the element selected, the fields open.
    if (!element) useProjectStore.getState().actions.openTab(comp, [comp], item.name);
    useSelectionStore.getState().set(pastedTop ? [pastedTop] : []);
    // Where a template is edited: its fields, in their own panel.
    if (fields.length > 0) useLayoutStore.getState().openPanel('essentialGraphics');
    const values: Record<string, string | number> = {};
    for (const f of fields) values[f.id] = f.default;
    set({
      active: { id: item.id, name: item.name, width: p.settings.width, height: p.settings.height, layout: () => {}, fields },
      values,
    });
    return true;
  },
  previewAuthored: async () => {
    // B4: the authored manifest is the active composition's `templateFields` (the mirror).
    const compId = activeCompIdNow() ?? '';
    const fields = mirrorAuthoredFields(compId);
    if (fields.length === 0) return;
    // B4: each field's current value from the engine (`templateFieldValues`: Source Text, the Fill Color, a
    // number, a media slot's `mediaUrl`); the field's default where the engine has none.
    const current = await templateFieldValues(fields, getTime());
    if ((activeCompIdNow() ?? '') !== compId) return;
    const values: Record<string, string | number> = {};
    for (const f of fields) values[f.id] = current[f.id] ?? f.default;
    const settings = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
    const comp = { width: settings?.width ?? 1920, height: settings?.height ?? 1080 };
    set({
      active: {
        id: '__authored', name: 'This composition',
        width: comp.width, height: comp.height,
        layout: () => {}, fields,
      },
      values,
    });
  },
  setField: (fieldId, value, send = editNow) => {
    const t = get().active;
    const field = t?.fields.find((f) => f.id === fieldId);
    if (!field) return;
    // A media field is filled from a File (`fillMediaField`), never from a value.
    // The field's other targets take the same value in the same entry.
    const cmds = templateFieldEditCommands(field, value, getTime());
    if (!cmds) return;
    send(`Edit ${field.label}`, cmds);
    set((s) => ({ values: { ...s.values, [fieldId]: value } }));
  },
  fillMediaField: async (fieldId, file) => {
    const field = get().active?.fields.find((f) => f.id === fieldId);
    if (!field || !isMediaField(field)) return;
    const asset = await fillMediaFieldEdit(field, file, getTime());
    if (asset) set((s) => ({ values: { ...s.values, [fieldId]: asset.src } }));
  },
  exit: () => set({ active: null, values: {} }),
}));
