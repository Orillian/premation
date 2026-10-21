/**
 * Authored template-field edits through the engine API (B3): the manifest
 * lives on the composition (`CompSettings.templateFields`, JSON), and
 * `setCompositionSettings.templateFields` replaces it as one undoable entry.
 * The list is read from the document mirror (B4) and transformed here.
 */
import { edit } from '@core/engine/uiEdits';
import { isPublicFieldId, slugFieldId, uniqueFieldId } from '@core/automation/fieldIds';
import type { TemplateField } from '@core/template/templateTypes';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import type { Command } from '@motion/engine-api';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { channelsToHex } from '@core/mirror/paintFields';
import { apiUnitFactor } from '@core/engine/props';
import { trackRef } from '@layout/Inspector/inspectorEdits';
import { getTime } from '@stores/playbackClockStore';
import { propertyValuesAt, templateFieldValues } from './templateFieldEdits';

/** The comp's authored fields, from the mirror (empty when none or malformed). */
export function mirrorAuthoredFields(comp: string): TemplateField[] {
  const json = documentMirror().comp(comp)?.settings.templateFields;
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v as TemplateField[] : [];
  } catch {
    return [];
  }
}

/** `fields` without `fieldId`. */
export function withoutField(fields: readonly TemplateField[], fieldId: string): TemplateField[] {
  return fields.filter((f) => f.id !== fieldId);
}

/** `fields` with `fieldId` relabelled. */
export function withFieldLabel(fields: readonly TemplateField[], fieldId: string, label: string): TemplateField[] {
  return fields.map((f) => (f.id === fieldId ? { ...f, label } : f));
}

/**
 * `fields` with the public input id n8n will send changed. Null when the
 * rename is rejected: a collision, or an id that is not a public slug.
 */
export function withFieldId(fields: readonly TemplateField[], fieldId: string, nextId: string): TemplateField[] | null {
  const id = nextId.trim();
  if (!isPublicFieldId(id)) return null;
  if (fields.some((f) => f.id === id && f.id !== fieldId)) return null;
  return fields.map((f) => (f.id === fieldId ? { ...f, id } : f));
}

async function saveFields(label: string, change: (fields: TemplateField[]) => TemplateField[] | null): Promise<boolean> {
  const comp = activeCompIdNow();
  if (!comp) return false;
  const next = change(mirrorAuthoredFields(comp));
  if (!next) return false;
  const res = await edit(label, { type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify(next) } });
  return res.ok;
}

export function removeAuthoredFieldEdit(fieldId: string): Promise<boolean> {
  return saveFields('Remove Template Field', (fields) => withoutField(fields, fieldId));
}

export function renameAuthoredFieldEdit(fieldId: string, label: string): Promise<boolean> {
  return saveFields('Rename Template Field', (fields) => withFieldLabel(fields, fieldId, label));
}

/** False when the id is rejected (collision / not a public slug) or the edit failed. */
export function renameAuthoredFieldIdEdit(fieldId: string, nextId: string): Promise<boolean> {
  return saveFields('Change Template Input Id', (fields) => withFieldId(fields, fieldId, nextId));
}

/** `fields` with `fieldId` moved by `delta` places (clamped). */
export function withFieldMoved(fields: readonly TemplateField[], fieldId: string, delta: number): TemplateField[] {
  const from = fields.findIndex((f) => f.id === fieldId);
  if (from < 0) return [...fields];
  const to = Math.max(0, Math.min(fields.length - 1, from + delta));
  const next = [...fields];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** `fields` with `fieldId` patched (group, range, default…). */
export function withFieldPatch(fields: readonly TemplateField[], fieldId: string, patch: Partial<TemplateField>): TemplateField[] {
  return fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f));
}

/**
 * `existing` + `incoming`, an incoming id that collides renamed (`title` →
 * `title2`) — what a second inserted element's fields need to sit beside the
 * first's in the same composition.
 */
export function mergedFields(existing: readonly TemplateField[], incoming: readonly TemplateField[]): TemplateField[] {
  const taken = new Set(existing.map((f) => f.id));
  const out = [...existing];
  for (const f of incoming) {
    const id = taken.has(f.id) ? uniqueFieldId(f.id, taken) : f.id;
    taken.add(id);
    out.push(id === f.id ? f : { ...f, id });
  }
  return out;
}

export function moveAuthoredFieldEdit(fieldId: string, delta: number): Promise<boolean> {
  return saveFields('Reorder Template Field', (fields) => withFieldMoved(fields, fieldId, delta));
}

export function patchAuthoredFieldEdit(fieldId: string, patch: Partial<TemplateField>, label = 'Change Template Field'): Promise<boolean> {
  return saveFields(label, (fields) => withFieldPatch(fields, fieldId, patch));
}

/** Remove every field of the active composition (the layers stay as they are). */
export function clearAuthoredFieldsEdit(): Promise<boolean> {
  return saveFields('Clear Template Fields', () => []);
}

// ── Expose a chosen property (Essential Graphics ▸ Build) ─────────────

/** One property of a layer that can become a template field. */
export interface ExposableProperty {
  /** Stable key for the picker (`text`, `font`, `x`, an API path…). */
  key: string;
  /** What the picker shows. */
  label: string;
  /** The picker's section: Text, Colour, Transform, Effects, Layer. */
  section: string;
  kind: TemplateField['kind'];
  target: TemplateField['target'];
  alsoTargets?: TemplateField['target'][];
  min?: number;
  max?: number;
  step?: number;
  displayScale?: number;
  unit?: string;
}

const TRANSFORM_PICKS: ReadonlyArray<{ track: string; label: string; also?: string; displayScale?: number; unit?: string; min?: number; max?: number; step?: number }> = [
  { track: 'x', label: 'Position X', unit: 'px' },
  { track: 'y', label: 'Position Y', unit: 'px' },
  { track: 'scaleX', label: 'Scale', also: 'scaleY', displayScale: 100, unit: '%', min: 0, max: 4, step: 0.01 },
  { track: 'rotation', label: 'Rotation', unit: '°', min: -360, max: 360, step: 1 },
  { track: 'opacity', label: 'Opacity', unit: '%' },
];

/** A finite range from a property's soft / hard limits, in stored units. */
function rangeOf(info: { min?: number; max?: number; softMin?: number; softMax?: number }, factor: number): { min?: number; max?: number } {
  const lo = info.softMin ?? info.min;
  const hi = info.softMax ?? info.max;
  return {
    ...(lo !== undefined && Number.isFinite(lo) ? { min: lo / factor } : {}),
    ...(hi !== undefined && Number.isFinite(hi) ? { max: hi / factor } : {}),
  };
}

/**
 * Everything on `layerId` that can become a template field, read from the
 * mirror (its property tree loaded first): a text layer's Source Text, Font and
 * Font Size, a source layer's media slot, every colour property (Fill Color,
 * a text colour, an effect's colour), the transform's everyday members, the
 * effects' number parameters, and the layer's Video switch.
 */
export async function exposableProperties(layerId: string): Promise<ExposableProperty[]> {
  const m = documentMirror();
  const layer = m.layer(layerId);
  if (!layer) return [];
  await m.loadTree(layerId);
  const tree = m.tree(layerId);
  const out: ExposableProperty[] = [];
  if (layer.kind === 'text') {
    out.push({ key: 'text', label: 'Text', section: 'Text', kind: 'text', target: { nodeId: layerId, componentType: 'Text', prop: 'content' } });
    out.push({ key: 'font', label: 'Font', section: 'Text', kind: 'font', target: { nodeId: layerId, componentType: 'Text', prop: 'fontFamily' } });
    out.push({ key: 'fontSize', label: 'Font Size', section: 'Text', kind: 'number', unit: 'px', min: 1, max: 400, step: 1, target: { nodeId: layerId, componentType: 'Text', prop: 'fontSize' } });
  }
  if (SLOT_KINDS.has(layer.kind)) {
    out.push({ key: 'media', label: 'Media', section: 'Media', kind: 'media', target: { nodeId: layerId, componentType: 'Transform', prop: 'src' } });
  }
  for (const info of tree?.nodes.values() ?? []) {
    if (info.kind !== 'property' || info.hidden || info.valueType !== 'color') continue;
    const name = info.path === 'layer/fill' ? 'Fill Color' : info.name;
    const effect = /^effects\/([^/]+)\//.exec(info.path);
    const group = effect ? tree?.nodes.get(`effects/${effect[1]}`)?.name : undefined;
    out.push({
      key: info.path, label: group ? `${group} ▸ ${name}` : name, section: 'Colour', kind: 'color',
      target: { nodeId: layerId, componentType: info.path === 'layer/fill' ? 'Style' : 'Property', prop: info.path === 'layer/fill' ? 'fill' : info.path },
    });
  }
  for (const p of TRANSFORM_PICKS) {
    const r = trackRef(layerId, p.track);
    if (!r) continue;
    out.push({
      key: p.track, label: p.label, section: 'Transform', kind: 'number',
      target: { nodeId: layerId, componentType: 'Transform', prop: p.track },
      ...(p.also && trackRef(layerId, p.also) ? { alsoTargets: [{ nodeId: layerId, componentType: 'Transform', prop: p.also }] } : {}),
      ...(p.displayScale ? { displayScale: p.displayScale } : {}),
      ...(p.unit ? { unit: p.unit } : {}),
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.step !== undefined ? { step: p.step } : {}),
    });
  }
  for (const info of tree?.nodes.values() ?? []) {
    if (info.kind !== 'property' || info.hidden || !info.path.startsWith('effects/')) continue;
    if (info.valueType !== 'scalar' || info.dimensions > 1 || !info.animatable) continue;
    const effect = /^effects\/([^/]+)\//.exec(info.path);
    const group = effect ? tree?.nodes.get(`effects/${effect[1]}`)?.name : undefined;
    out.push({
      key: info.path, label: group ? `${group} ▸ ${info.name}` : info.name, section: 'Effects', kind: 'number',
      target: { nodeId: layerId, componentType: 'Property', prop: info.path },
      ...rangeOf(info, 1),
      ...(info.unit ? { unit: info.unit } : {}),
    });
  }
  out.push({ key: 'visible', label: 'Show / Hide', section: 'Layer', kind: 'toggle', target: { nodeId: layerId, componentType: 'Layer', prop: 'visible' } });
  return out;
}

const DEFAULT_GROUP: Readonly<Record<string, string>> = { text: 'Text', font: 'Text', color: 'Colours', media: 'Media', number: 'Controls', toggle: 'Controls', image: 'Media' };

/**
 * Expose one property of `layerId` as a field of the active composition, ONE
 * undo entry: its current value becomes the default, a media slot is declared
 * as `exposeLayerAsFieldEdit` declares it, and re-exposing the same target
 * keeps its id. Resolves to the field, or null when refused.
 */
export async function exposePropertyAsFieldEdit(layerId: string, pick: ExposableProperty, seconds: number = getTime()): Promise<TemplateField | null> {
  if (pick.kind === 'media' || pick.kind === 'image') return exposeLayerAsFieldEdit(layerId, seconds);
  const comp = activeCompIdNow();
  const layer = documentMirror().layer(layerId);
  if (!comp || !layer) return null;
  const existing = mirrorAuthoredFields(comp);
  const label = pick.key === 'text' ? (layer.name || 'Text') : `${layer.name || 'Layer'} ${pick.label}`;
  const { min, max, step, displayScale, unit, alsoTargets } = pick;
  const draft: TemplateField = {
    id: '', label, kind: pick.kind, group: DEFAULT_GROUP[pick.kind] ?? 'Controls', default: '',
    target: pick.target,
    ...(alsoTargets ? { alsoTargets } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(displayScale !== undefined ? { displayScale } : {}),
    ...(unit ? { unit } : {}),
  };
  const current = await templateFieldValues([{ ...draft, id: '__probe' }], seconds);
  const value = current.__probe;
  if (value === undefined) return null;
  const prior = existing.find((f) => f.target.nodeId === layerId && f.target.prop === pick.target.prop);
  const id = prior?.id ?? uniqueFieldId(slugFieldId(label) || 'input', new Set(existing.map((f) => f.id)));
  const field: TemplateField = { ...draft, id, default: value };
  const next = prior ? existing.map((f) => (f.id === prior.id ? { ...field, label: prior.label, group: prior.group } : f)) : [...existing, field];
  const res = await edit('Expose Template Field', { type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify(next) } });
  return res.ok ? field : null;
}

// ── Expose as field (B4 round 5) ──────────────────────────────────────

/** Layers that show a source: a MEDIA slot (templateAuthoring.ts `inferFieldForNode`'s kinds). */
const SLOT_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'svg', 'precomp']);

/**
 * Expose `layerId` as a template field of the active composition — templateAuthoring.ts
 * `exposeNodeAsField` through the engine: the field is inferred from the layer as the mirror and the
 * engine state it (a text layer's Source Text, a layer that shows a source as a MEDIA slot, else its Fill
 * Color), a media slot is declared with its fit (`layer/slotFit`, contain) and — the first time — its
 * current box captured as the authored slot rect (`layer/slotWidth|slotHeight`: re-filling must never
 * compound), and the manifest is replaced (`setCompositionSettings.templateFields`), ONE undo entry.
 * Re-exposing the same target keeps its id. Resolves to the field, or null when the layer has nothing
 * exposable or the engine refused.
 */
export async function exposeLayerAsFieldEdit(layerId: string, seconds: number = getTime()): Promise<TemplateField | null> {
  const comp = activeCompIdNow();
  const m = documentMirror();
  const layer = m.layer(layerId);
  if (!comp || !layer) return null;
  // The slot rect's Width / Height resolve on the layer's property tree.
  await m.loadTree(layerId);
  const label = layer.name || 'Field';
  const existing = mirrorAuthoredFields(comp);
  const id = uniqueFieldId(slugFieldId(label) || 'input', new Set(existing.map((f) => f.id)));
  const cmds: Command[] = [];
  let field: TemplateField;
  if (layer.kind === 'text') {
    const v = (await propertyValuesAt(layerId, ['text/sourceText'], seconds)).get('text/sourceText');
    field = {
      id, label, kind: 'text', group: 'Text',
      default: v?.kind === 'textDocument' ? v.value.text : '',
      target: { nodeId: layerId, componentType: 'Text', prop: 'content' },
    };
  } else if (SLOT_KINDS.has(layer.kind)) {
    const slot = await propertyValuesAt(layerId, ['layer/slotWidth'], seconds);
    cmds.push({ type: 'setProperty', prop: { layer: layerId, path: 'layer/slotFit' }, value: { kind: 'choice', value: 'contain' } });
    if (!((numbersOfValue(slot.get('layer/slotWidth'))[0] ?? 0) > 0)) {
      // Capture the placeholder's box as the slot rect NOW, while it is still the authored design.
      const wRef = trackRef(layerId, 'width');
      const hRef = trackRef(layerId, 'height');
      const box = await propertyValuesAt(layerId, [wRef?.ref.path, hRef?.ref.path].filter((x): x is string => !!x), seconds);
      const w = wRef ? (numbersOfValue(box.get(wRef.ref.path))[0] ?? 0) / apiUnitFactor('width') : 0;
      const h = hRef ? (numbersOfValue(box.get(hRef.ref.path))[0] ?? 0) / apiUnitFactor('height') : 0;
      if (w > 0 && h > 0) {
        cmds.push(
          { type: 'setProperty', prop: { layer: layerId, path: 'layer/slotWidth' }, value: { kind: 'scalar', value: w } },
          { type: 'setProperty', prop: { layer: layerId, path: 'layer/slotHeight' }, value: { kind: 'scalar', value: h } },
        );
      }
    }
    const source = layer.source ? m.item(layer.source) : undefined;
    field = {
      id, label, kind: 'media', group: 'Media', fit: 'contain',
      default: source?.mediaUrl ?? '',
      target: { nodeId: layerId, componentType: 'Transform', prop: 'src' },
    };
  } else {
    const r = trackRef(layerId, 'layer/fill');
    if (!r) return null;
    const v = (await propertyValuesAt(layerId, [r.ref.path], seconds)).get(r.ref.path);
    field = {
      id, label, kind: 'color', group: 'Colours',
      default: v?.kind === 'color' ? channelsToHex(v.value) : '#000000',
      target: { nodeId: layerId, componentType: 'Style', prop: 'fill' },
    };
  }
  const prior = existing.find((f) => f.target.nodeId === field.target.nodeId && f.target.prop === field.target.prop);
  const next = prior ? { ...field, id: prior.id } : field;
  cmds.push({ type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify([...existing.filter((f) => f.id !== next.id), next]) } });
  const res = await edit('Expose Template Field', cmds);
  return res.ok ? next : null;
}
