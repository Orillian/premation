/**
 * Essential Graphics — the panel a template is edited in (AE's Essential
 * Graphics panel). Its subject is the ACTIVE composition's template fields,
 * read from the document mirror (`CompSettings.templateFields`), so a template
 * inserted from the Library, one authored here and one reopened from disk all
 * edit the same way, and the controls survive a reload.
 *
 *   Edit  — one control per field, grouped: text, font, colour, number (with a
 *           slider when the field has a range), show / hide, media slot. Each
 *           row resets to the template's default; Reset All puts every field back.
 *   Build — make controls: pick a property of the selected layer (its text,
 *           font, size, any colour, position / scale / rotation / opacity, an
 *           effect's number, its visibility, its media), then rename, group,
 *           reorder, range or remove the controls.
 *
 * Every write goes through the engine API (templateFieldEdits.ts,
 * templateAuthoringEdits.ts): a typing session or a scrub is ONE undo entry.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { Button } from '@components/Button';
import { EmptyState } from '@components/EmptyState';
import { Input } from '@components/Input';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Segmented } from '@components/Segmented';
import { Slider } from '@components/Slider';
import { Switch } from '@components/Switch';
import { FontPicker } from '@layout/Inspector/FontPicker';
import { useActiveMirrorComp, useMirrorLayer, useMirrorLayersWatch, useMirrorStructRevision } from '@hooks/useMirror';
import { useGesture } from '@hooks/useGesture';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';
import { edit } from '@core/engine/uiEdits';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useLayoutStore } from '@stores/layoutStore';
import type { TemplateField } from '@core/template/templateTypes';
import type { Command } from '@motion/engine-api';
import { t } from '@core/i18n';
import { DataFillSection } from './DataFillSection';
import { fillMediaFieldEdit, isMediaField, templateFieldEditCommands, templateFieldValues } from './templateFieldEdits';
import {
  exposableProperties,
  exposePropertyAsFieldEdit,
  mirrorAuthoredFields,
  moveAuthoredFieldEdit,
  patchAuthoredFieldEdit,
  removeAuthoredFieldEdit,
  renameAuthoredFieldEdit,
  type ExposableProperty,
} from './templateAuthoringEdits';
import styles from './EssentialGraphicsPanel.module.css';

type Mode = 'edit' | 'build';
type FieldValues = Record<string, string | number>;
type Send = (label: string, cmds: Command[]) => void;

/** The active composition's id, name and fields (a new array only when the manifest changes). */
function useCompFields(): { compId: string | undefined; name: string; fields: TemplateField[] } {
  const comp = useActiveMirrorComp();
  const json = comp?.settings.templateFields ?? '';
  const compId = comp?.id;
  const fields = useMemo(() => (compId && json ? mirrorAuthoredFields(compId) : []), [compId, json]);
  return { compId, name: comp?.settings.name ?? '', fields };
}

/**
 * What each field shows now, asked of the engine at the playhead — again
 * whenever one of the fields' layers changes (an undo, an edit elsewhere).
 * `setLocal` keeps a control live while its own write is in flight.
 */
function useFieldValues(fields: readonly TemplateField[]): { values: FieldValues; setLocal: (id: string, v: string | number) => void } {
  const [values, setValues] = useState<FieldValues>({});
  const layers = useMemo(() => [...new Set(fields.flatMap((f) => [f.target.nodeId, ...(f.alsoTargets ?? []).map((a) => a.nodeId)]))], [fields]);
  const watch = useMirrorLayersWatch(layers);
  useEffect(() => {
    let live = true;
    // Debounced: a scrub writes on every pointer move; one read after it settles is enough.
    const timer = setTimeout(() => {
      void templateFieldValues(fields, getTime()).then((v) => { if (live) setValues(v); });
    }, 80);
    return () => { live = false; clearTimeout(timer); };
  }, [fields, watch]);
  const setLocal = useCallback((id: string, v: string | number) => setValues((s) => ({ ...s, [id]: v })), []);
  return { values, setLocal };
}

/** Fields grouped by `group`, in first-seen order. */
function groupFields(fields: readonly TemplateField[]): Array<[string, TemplateField[]]> {
  const map = new Map<string, TemplateField[]>();
  for (const f of fields) {
    const key = f.group || t('templates.fields.defaultGroup', 'Fields');
    const arr = map.get(key) ?? [];
    arr.push(f);
    map.set(key, arr);
  }
  return [...map.entries()];
}

export function EssentialGraphicsPanel(): JSX.Element {
  const { compId, name, fields } = useCompFields();
  const [mode, setMode] = useState<Mode>('edit');

  if (!compId) {
    return (
      <div className={styles.root}>
        <EmptyState icon="component" title={t('eg.noComp.title', 'No composition open')} message={t('eg.noComp.message', 'Open a composition to edit its template controls.')} />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headText}>
          <div className={styles.compName} title={name}>{name || t('eg.untitled', 'Composition')}</div>
          <div className={styles.hint}>
            {fields.length === 0
              ? t('eg.noControls', 'No template controls yet')
              : t('eg.controlCount', '{n} template controls', { n: fields.length })}
          </div>
        </div>
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          aria-label={t('eg.mode', 'Mode')}
          options={[
            { value: 'edit', label: t('eg.edit', 'Edit'), icon: 'sliders-h' },
            { value: 'build', label: t('eg.build', 'Build'), icon: 'pencil' },
          ]}
        />
      </div>
      {mode === 'edit'
        ? <EditMode fields={fields} onBuild={() => setMode('build')} />
        : <BuildMode fields={fields} />}
    </div>
  );
}

// ── Edit ────────────────────────────────────────────────────────────────

/**
 * The template's controls, grouped — mounted by Essential Graphics and by the
 * Properties panel under an applied template.
 */
export function TemplateControls({ onBuild }: { onBuild?: () => void }): JSX.Element {
  const { fields } = useCompFields();
  return <EditMode fields={fields} onBuild={onBuild} />;
}

function EditMode({ fields, onBuild }: { fields: TemplateField[]; onBuild?: () => void }): JSX.Element {
  const { values, setLocal } = useFieldValues(fields);
  const groups = useMemo(() => groupFields(fields), [fields]);

  const resetAll = (): void => {
    const cmds = fields.flatMap((f) => (isMediaField(f) ? [] : templateFieldEditCommands(f, f.default, getTime()) ?? []));
    if (cmds.length > 0) void edit('Reset Template Controls', cmds); // undo labels stay English
  };

  if (fields.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyState
          icon="component"
          title={t('eg.empty.title', 'This composition has no template controls')}
          message={t('eg.empty.message', 'Insert a template from the Library, or build controls from this composition’s layers — its text, fonts, colours, sizes and media.')}
        />
        <div className={styles.emptyActions}>
          <Button variant="secondary" size="sm" leftIcon={<Icon name="component" size="sm" />} onClick={() => useLayoutStore.getState().openPanel('library')}>
            {t('eg.browse', 'Browse templates')}
          </Button>
          {onBuild && (
            <Button variant="primary" size="sm" leftIcon={<Icon name="plus" size="sm" />} onClick={onBuild}>
              {t('eg.buildControls', 'Build controls')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.body}>
      {groups.map(([group, list]) => (
        <section key={group} className={styles.group}>
          <div className={styles.groupLabel}>{group}</div>
          {list.map((f) => (
            <FieldControl key={f.id} field={f} value={values[f.id]} onLocal={setLocal} />
          ))}
        </section>
      ))}
      <div className={styles.footerRow}>
        <Button variant="ghost" size="sm" leftIcon={<Icon name="history" size="sm" />} onClick={resetAll}>
          {t('eg.resetAll', 'Reset all to template')}
        </Button>
      </div>
      {/* Batch fill fills THESE fields, so it sits under them. */}
      <DataFillSection fields={fields} />
    </div>
  );
}

/** One field's control, by kind. */
function FieldControl({ field, value, onLocal }: { field: TemplateField; value: string | number | undefined; onLocal: (id: string, v: string | number) => void }): JSX.Element {
  const eng = useEngineEdit();
  const typing = useGesture();
  const fileRef = useRef<HTMLInputElement>(null);
  const label = `Edit ${field.label}`;
  const missing = value === undefined && !isMediaField(field);

  const write = (v: string | number, send: Send): void => {
    const cmds = templateFieldEditCommands(field, v, getTime());
    if (!cmds) return;
    send(label, cmds);
    onLocal(field.id, v);
  };
  const once: Send = (l, cmds) => { void edit(l, cmds); };
  const typeInto: Send = (l, cmds) => {
    if (!typing.isActive()) typing.begin(l);
    typing.send(cmds);
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // allow re-picking the same file
    void fillMediaFieldEdit(field, file, getTime()).then((asset) => { if (asset) onLocal(field.id, asset.src); });
  };
  const atDefault = value !== undefined && String(value) === String(field.default);
  const scale = field.displayScale ?? 1;
  const hasRange = field.min !== undefined && field.max !== undefined && field.max > field.min;

  return (
    <div className={styles.field} data-kind={field.kind}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{field.label}</span>
        {!isMediaField(field) && !missing && !atDefault && (
          <IconButton
            size="sm"
            variant="ghost"
            aria-label={t('eg.resetField', 'Reset to template value')}
            tooltip={t('eg.resetField', 'Reset to template value')}
            onClick={() => write(field.default, once)}
          >
            <Icon name="history" size="sm" />
          </IconButton>
        )}
      </div>
      {missing && <div className={styles.missing}>{t('eg.missing', 'The layer this control drives is gone.')}</div>}
      {!missing && field.kind === 'text' && (
        <textarea
          className={styles.textArea}
          rows={String(value ?? '').includes('\n') ? 3 : 1}
          value={String(value ?? '')}
          onChange={(e) => write(e.target.value, typeInto)}
          onBlur={() => { void typing.end(); }}
          aria-label={field.label}
        />
      )}
      {!missing && field.kind === 'font' && (
        <FontPicker value={String(value ?? '')} onChange={(family) => write(family, once)} />
      )}
      {!missing && field.kind === 'color' && (
        <span className={styles.contents} {...eng.press(label)}>
          <ColorPicker value={String(value ?? field.default)} onChange={(hex) => write(hex, eng.send)} className={styles.colorTrigger} aria-label={field.label} />
        </span>
      )}
      {!missing && field.kind === 'number' && (
        <div className={styles.numberRow}>
          {hasRange && (
            <span className={styles.slider} {...eng.press(label)}>
              <Slider
                size="sm"
                min={field.min! * scale}
                max={field.max! * scale}
                step={(field.step ?? (field.max! - field.min! > 10 ? 1 : 0.01)) * scale}
                value={Number(value ?? 0) * scale}
                onChange={(v) => write(v / scale, eng.send)}
                aria-label={field.label}
              />
            </span>
          )}
          <ValueField
            value={Number(value ?? 0) * scale}
            {...eng.scrub(label)}
            onChange={(v) => write(v / scale, eng.send)}
            {...(field.min !== undefined ? { min: field.min * scale } : {})}
            {...(field.max !== undefined ? { max: field.max * scale } : {})}
            {...(field.unit ? { unit: field.unit } : {})}
            aria-label={field.label}
          />
        </div>
      )}
      {!missing && field.kind === 'toggle' && (
        <Switch
          checked={Number(value ?? 0) !== 0}
          onChange={(e) => write(e.target.checked ? 1 : 0, once)}
          label={Number(value ?? 0) !== 0 ? t('eg.shown', 'Shown') : t('eg.hidden', 'Hidden')}
        />
      )}
      {isMediaField(field) && (
        <div className={styles.mediaField}>
          <span className={styles.mediaThumb} aria-hidden>
            {value && !/\.(mp4|mov|webm|mkv)(\?|$)/i.test(String(value)) ? <img src={String(value)} alt="" /> : <Icon name="media" size="md" />}
          </span>
          <Button variant="secondary" size="sm" leftIcon={<Icon name="media" size="sm" />} onClick={() => fileRef.current?.click()}>
            {value ? t('eg.replaceMedia', 'Replace media') : t('eg.chooseMedia', 'Choose media')}
          </Button>
          <input ref={fileRef} type="file" accept={field.kind === 'image' ? 'image/*' : 'image/*,video/*'} hidden onChange={onPick} aria-label={field.label} />
        </div>
      )}
    </div>
  );
}

// ── Build ───────────────────────────────────────────────────────────────

function kindLabel(kind: TemplateField['kind']): string {
  switch (kind) {
    case 'text': return t('templates.fields.kindText', 'Text');
    case 'font': return t('eg.kind.font', 'Font');
    case 'color': return t('templates.fields.kindColor', 'Color');
    case 'number': return t('templates.fields.kindNumber', 'Number');
    case 'toggle': return t('eg.kind.toggle', 'Show / Hide');
    case 'image': return t('templates.fields.kindImage', 'Image');
    case 'media': return t('templates.fields.kindMedia', 'Media');
    default: return kind;
  }
}

function BuildMode({ fields }: { fields: TemplateField[] }): JSX.Element {
  return (
    <div className={styles.body}>
      <PropertyPicker fields={fields} />
      <section className={styles.group}>
        <div className={styles.groupLabel}>{t('eg.controls', 'Controls')}</div>
        {fields.length === 0
          ? <div className={styles.note}>{t('eg.controlsEmpty', 'Controls you add appear here. Each one is what a person using this template may change.')}</div>
          : fields.map((f, i) => <ControlCard key={f.id} field={f} first={i === 0} last={i === fields.length - 1} />)}
      </section>
    </div>
  );
}

/** The selected layer's properties that can become controls, by section. */
function PropertyPicker({ fields }: { fields: TemplateField[] }): JSX.Element {
  const layerId = useSelectionStore((s) => s.ids[0]);
  const layer = useMirrorLayer(layerId);
  const struct = useMirrorStructRevision();
  const [picks, setPicks] = useState<ExposableProperty[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!layerId || !layer) { setPicks([]); return; }
    void exposableProperties(layerId).then((p) => { if (live) setPicks(p); });
    return () => { live = false; };
  }, [layerId, layer, struct]);

  const exposed = useMemo(() => new Set(fields.map((f) => `${f.target.nodeId}|${f.target.prop}`)), [fields]);
  const sections = useMemo(() => {
    const map = new Map<string, ExposableProperty[]>();
    for (const p of picks) map.set(p.section, [...(map.get(p.section) ?? []), p]);
    return [...map.entries()];
  }, [picks]);

  const add = async (p: ExposableProperty): Promise<void> => {
    if (!layerId) return;
    setBusy(p.key);
    try {
      await exposePropertyAsFieldEdit(layerId, p);
    } finally {
      setBusy(null);
    }
  };

  if (!layerId || !layer) {
    return (
      <section className={styles.group}>
        <div className={styles.groupLabel}>{t('eg.addControl', 'Add a control')}</div>
        <div className={styles.note}>{t('eg.selectLayer', 'Select a layer in the timeline or viewer to list what it can expose.')}</div>
      </section>
    );
  }

  return (
    <section className={styles.group}>
      <div className={styles.groupLabel}>{t('eg.addFrom', 'Add from “{name}”', { name: layer.name })}</div>
      {sections.map(([section, list]) => (
        <div key={section} className={styles.pickSection}>
          <div className={styles.pickSectionLabel}>{section}</div>
          <div className={styles.pickList}>
            {list.map((p) => {
              const already = exposed.has(`${layerId}|${p.target.prop}`);
              return (
                <button
                  key={p.key}
                  type="button"
                  className={styles.pick}
                  data-added={already || undefined}
                  disabled={already || busy !== null}
                  onClick={() => void add(p)}
                  title={already ? t('eg.alreadyAdded', 'Already a control') : t('eg.addThis', 'Add as a template control')}
                >
                  <Icon name={already ? 'check' : 'plus'} size="sm" />
                  <span className={styles.pickLabel}>{p.label}</span>
                  <span className={styles.kindBadge}>{kindLabel(p.kind)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

/** One control's settings: label, group, range, order, removal. */
function ControlCard({ field, first, last }: { field: TemplateField; first: boolean; last: boolean }): JSX.Element {
  const layerName = documentMirror().layer(field.target.nodeId)?.name;
  const num = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() !== '' && Number.isFinite(n) ? n : undefined;
  };
  const scale = field.displayScale ?? 1;
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <Input
          key={`${field.id}-label-${field.label}`}
          defaultValue={field.label}
          onBlur={(e) => { if (e.target.value.trim() && e.target.value !== field.label) void renameAuthoredFieldEdit(field.id, e.target.value.trim()); }}
          aria-label={t('templates.authoring.fieldLabel', 'Field label')}
          className={styles.cardLabel}
        />
        <IconButton size="sm" variant="ghost" aria-label={t('eg.moveUp', 'Move up')} disabled={first} onClick={() => void moveAuthoredFieldEdit(field.id, -1)}>
          <Icon name="chevron-up" size="sm" />
        </IconButton>
        <IconButton size="sm" variant="ghost" aria-label={t('eg.moveDown', 'Move down')} disabled={last} onClick={() => void moveAuthoredFieldEdit(field.id, 1)}>
          <Icon name="chevron-down" size="sm" />
        </IconButton>
        <IconButton size="sm" variant="ghost" aria-label={t('templates.authoring.removeField', 'Remove field')} onClick={() => void removeAuthoredFieldEdit(field.id)}>
          <Icon name="trash" size="sm" />
        </IconButton>
      </div>
      <div className={styles.cardMeta}>
        <span className={styles.kindBadge}>{kindLabel(field.kind)}</span>
        <span className={styles.target} title={layerName ?? ''}>
          {layerName ?? t('eg.layerGone', 'missing layer')}
        </span>
      </div>
      <div className={styles.cardRow}>
        <span className={styles.cardKey}>{t('eg.group', 'Group')}</span>
        <Input
          key={`${field.id}-group-${field.group ?? ''}`}
          defaultValue={field.group ?? ''}
          placeholder={t('templates.fields.defaultGroup', 'Fields')}
          onBlur={(e) => { if (e.target.value.trim() !== (field.group ?? '')) void patchAuthoredFieldEdit(field.id, { group: e.target.value.trim() || undefined }, 'Group Template Field'); }}
          aria-label={t('eg.group', 'Group')}
        />
      </div>
      {field.kind === 'number' && (
        <div className={styles.cardRow}>
          <span className={styles.cardKey}>{t('eg.range', 'Range')}</span>
          <Input
            key={`${field.id}-min-${field.min ?? ''}`}
            defaultValue={field.min !== undefined ? String(field.min * scale) : ''}
            placeholder={t('eg.min', 'Min')}
            onBlur={(e) => { const v = num(e.target.value); void patchAuthoredFieldEdit(field.id, { min: v === undefined ? undefined : v / scale }, 'Template Field Range'); }}
            aria-label={t('eg.min', 'Min')}
          />
          <Input
            key={`${field.id}-max-${field.max ?? ''}`}
            defaultValue={field.max !== undefined ? String(field.max * scale) : ''}
            placeholder={t('eg.max', 'Max')}
            onBlur={(e) => { const v = num(e.target.value); void patchAuthoredFieldEdit(field.id, { max: v === undefined ? undefined : v / scale }, 'Template Field Range'); }}
            aria-label={t('eg.max', 'Max')}
          />
        </div>
      )}
    </div>
  );
}

export default EssentialGraphicsPanel;
