/**
 * TemplateFieldsPanel — the strict "fill-in-the-blanks" surface. When no
 * template is loaded it shows the gallery; once one is applied it shows ONLY
 * that template's exposed fields (text / colour / number), grouped. Editing a
 * field writes straight through the scene graph via the template store, so the
 * design and animation stay locked and only the data changes.
 *
 * The gallery is the Library's Templates shelf: premium templates (Premation
 * Cloud, server-delivered — LibraryCards.tsx) beside the bundled scenes and
 * animated presets, in one searchable, filterable grid. Bundled cards go
 * through the shared preview controller (the ENGINE's still of the real scene,
 * playing while hovered or focused); premium cards play the server's rendered
 * loop. Every scene — bundled or premium — opens in a NEW composition, so
 * picking one never replaces the work in the current one.
 */

import { useCallback, useMemo, useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { EmptyState } from '@components/EmptyState';
import { Input } from '@components/Input';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, useActiveMirrorComp } from '@hooks/useMirror';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import type { TemplateField } from '@core/template/templateTypes';
import { publishCurrentTemplate } from '@core/automation/publishTemplate';
import { isPublicFieldId } from '@core/automation/fieldIds';
import { cloudProjectsEnabled } from '@core/config/edition';
import { customPrompt } from '@components/Modal';
import { useUIStore } from '@stores/uiStore';
import { useTemplateStore } from '@stores/templateStore';
import { useLayoutStore } from '@stores/layoutStore';
import { TemplateControls } from './EssentialGraphicsPanel';
import { exposeLayerAsFieldEdit, mirrorAuthoredFields, removeAuthoredFieldEdit, renameAuthoredFieldEdit, renameAuthoredFieldIdEdit } from './templateAuthoringEdits';
import { useSelectionStore } from '@stores/selectionStore';
import styles from './TemplateFieldsPanel.module.css';
import cardStyles from '@layout/EditorLayout/LibraryCards.module.css';
import { PremiumCard, PremiumSheet, Segmented, ShelfNote, usePremiumSheet, usePremiumShelf } from '@layout/EditorLayout/LibraryCards';
import { LibraryBrowser } from '@layout/EditorLayout/LibraryBrowser';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';
import { t } from '@core/i18n';

export function TemplateFieldsPanel(): JSX.Element {
  const active = useTemplateStore((s) => s.active);
  return active ? <ActiveTemplateFields /> : <TemplateGallery />;
}

/** One tile in the Templates grid — a library template (free or Pro). */
interface TemplateEntry {
  id: string;
  name: string;
  cat: string;
  tier: 'cloud' | 'free';
  tags: readonly string[];
  aspect?: string;
  item: PremiumCatalogItem;
}

/** The shelf's category order; a category outside it is appended. */
const TEMPLATE_CATEGORIES = ['openers', 'titles', 'lower-thirds', 'social', 'promo', 'slideshow', 'logo', 'typography', 'data'] as const;

const categoryId = (label: string): string => label.trim().toLowerCase().replace(/\s+/g, '-');

function templateCategoryLabel(cat: string): string {
  switch (cat) {
    case 'openers': return t('templates.gallery.cat.openers', 'Openers');
    case 'titles': return t('templates.gallery.cat.titles', 'Titles');
    case 'lower-thirds': return t('templates.gallery.cat.lowerThirds', 'Lower thirds');
    case 'social': return t('templates.gallery.cat.social', 'Social');
    case 'promo': return t('templates.gallery.cat.promo', 'Promo');
    case 'slideshow': return t('templates.gallery.cat.slideshow', 'Slideshow');
    case 'logo': return t('templates.gallery.cat.logo', 'Logo');
    case 'typography': return t('templates.gallery.cat.typography', 'Typography');
    case 'data': return t('templates.gallery.cat.data', 'Data');
    default: return cat.charAt(0).toUpperCase() + cat.slice(1).replace(/-/g, ' ');
  }
}

type AspectFilter = 'all' | '16:9' | '9:16' | '1:1';

function TemplateGallery(): JSX.Element {
  const shelf = usePremiumShelf('template');
  const { sheetItem, openSheet, closeSheet } = usePremiumSheet();
  const [aspect, setAspect] = useState<AspectFilter>('all');

  const entries = useMemo<TemplateEntry[]>(() => shelf.items.map((item) => ({
    id: item.id, name: item.name, cat: categoryId(item.category), tier: item.tier, tags: item.tags,
    // An element (a lower third, a title) fits any composition, so it has no aspect.
    ...(item.mode === 'element' ? {} : { aspect: item.aspect }), item,
  })), [shelf.items]);

  const categories = useMemo(() => {
    const known: string[] = [...TEMPLATE_CATEGORIES];
    for (const e of entries) if (!known.includes(e.cat)) known.push(e.cat);
    return known.filter((c) => entries.some((e) => e.cat === c));
  }, [entries]);

  const byAspect = useCallback((e: TemplateEntry) => aspect === 'all' || !e.aspect || e.aspect === aspect, [aspect]);

  const aspectFilter = (
    <Segmented
      value={aspect}
      onChange={setAspect}
      label={t('templates.gallery.aspect', 'Aspect ratio')}
      options={[
        { value: 'all', label: t('templates.gallery.aspectAll', 'Any') },
        { value: '16:9', label: '16:9' },
        { value: '9:16', label: '9:16' },
        { value: '1:1', label: '1:1' },
      ]}
    />
  );

  // No shelf yet: say why instead of an empty grid.
  const shelfEmpty = entries.length === 0 ? (
    <div className={cardStyles.shelfNote} role="status">
      <Icon name="info" size="sm" />
      <span>
        {shelf.access === 'local'
          ? t('templates.gallery.local', 'Templates come with a Premation account — sign in from the Premation app to browse them.')
          : shelf.status === 'loading' || shelf.status === 'idle'
            ? t('templates.gallery.loading', 'Loading templates…')
            : t('templates.gallery.none', 'No templates are available right now.')}
      </span>
    </div>
  ) : null;

  return (
    <div className={cardStyles.section}>
      <LibraryBrowser
        items={entries}
        categories={categories}
        categoryLabel={templateCategoryLabel}
        noun="template"
        showTier={entries.some((e) => e.tier === 'cloud') && entries.some((e) => e.tier !== 'cloud')}
        filters={aspectFilter}
        predicate={byAspect}
        toolbar={<>{shelfEmpty}<ShelfNote shelf={shelf} /></>}
        after={<TemplateAuthoringSection />}
      >
        {(items) => (
          <div className={cardStyles.grid}>
            {items.map((e) => <PremiumCard key={e.id} item={e.item} access={shelf.access} onLocked={openSheet} />)}
          </div>
        )}
      </LibraryBrowser>
      {sheetItem && <PremiumSheet item={sheetItem} access={shelf.access} onClose={closeSheet} />}
    </div>
  );
}

function fieldKindLabel(kind: TemplateField['kind']): string {
  switch (kind) {
    case 'media': return t('templates.fields.kindMedia', 'Media');
    case 'image': return t('templates.fields.kindImage', 'Image');
    case 'text': return t('templates.fields.kindText', 'Text');
    case 'color': return t('templates.fields.kindColor', 'Color');
    case 'number': return t('templates.fields.kindNumber', 'Number');
    default: return kind;
  }
}

/**
 * "Make this composition a template" — expose selected layers as fields.
 *
 * Exported for the same reason `ActiveTemplateFields` is: this lived only
 * inside `TemplateFieldsPanel`, which nothing mounts, so the one button that
 * reaches `POST /v1/templates` — "Save as Animation Template" — could not be
 * clicked in a shipped build. The Automation API had keys, quotas and an admin
 * console, and no way to put a template into it.
 *
 * Renders nothing while a template is being FILLED IN: authoring and filling
 * are opposite modes, and `ActiveTemplateFields` owns the latter.
 */
export function TemplateAuthoringSection(): JSX.Element | null {
  // B4: the authored manifest is the active composition's `templateFields`
  // (the document mirror); its record changes when the manifest does.
  const activeComp = useActiveMirrorComp();
  const activeTemplate = useTemplateStore((s) => s.active);
  const selectedId = useSelectionStore((s) => s.ids[0]);
  const previewAuthored = useTemplateStore((s) => s.previewAuthored);
  const notify = useUIStore((s) => s.notify);
  const fields = activeComp ? mirrorAuthoredFields(activeComp.id) : [];

  const exposeSelected = (): void => {
    if (!selectedId) return;
    // B4: inferred from the mirror / engine (Source Text, the source's media URL, the Fill Color); the slot
    // fields and the manifest written as ONE engine entry (templateAuthoringEdits).
    void exposeLayerAsFieldEdit(selectedId);
  };

  const publish = async (): Promise<void> => {
    const name = await customPrompt(
      t('templates.authoring.saveAsTemplate', 'Save as Animation Template'),
      t('templates.authoring.savePrompt', 'n8n will call this template by name and send the input ids below — not Premation layer ids.'),
      'Anime Cooking Reaction',
      { placeholder: t('templates.authoring.templateName', 'Template name'), confirmLabel: t('templates.authoring.saveTemplate', 'Save template') },
    );
    if (!name?.trim()) return;
    // B4: the active composition's fields and settings from the document mirror, read at call time.
    const compId = activeCompIdNow();
    const settings = compId ? documentMirror().comp(compId)?.settings : undefined;
    const result = await publishCurrentTemplate(name.trim(), {
      fields: compId ? mirrorAuthoredFields(compId) : [],
      width: settings?.width ?? DEFAULT_COMPOSITION.width,
      height: settings?.height ?? DEFAULT_COMPOSITION.height,
      fps: settings ? settingsFps(settings) : DEFAULT_COMPOSITION.fps,
      durationSeconds: settings ? settingsDurationSeconds(settings) : DEFAULT_COMPOSITION.durationSeconds,
    });
    notify({
      level: result.ok ? 'success' : 'error',
      message: result.ok
        ? t('templates.authoring.saved', 'Saved template “{name}”', { name: name.trim() })
        : result.error ?? t('templates.authoring.publishFailed', 'Publish failed'),
      durationMs: 3200,
    });
  };

  if (activeTemplate) return null;

  return (
    <div className={styles.authoring}>
      <div className={styles.groupLabel}>{t('templates.authoring.title', 'Make this a template')}</div>
      <div className={styles.introText}>
        {t(
          'templates.authoring.intro',
          'Select a text, image or video layer and expose it as an automation input. n8n sends the ID (e.g. {example1}, {example2}) — not Premation layer ids.',
          { example1: 'character', example2: 'backgroundVideo' },
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<Icon name="plus" size="sm" />}
        onClick={exposeSelected}
        disabled={!selectedId}
      >
        {selectedId ? t('templates.authoring.expose', 'Expose selected layer') : t('templates.authoring.selectFirst', 'Select a layer first')}
      </Button>

      {fields.length === 0 && (
        <EmptyState
          compact
          icon="component"
          title={t('templates.authoring.emptyTitle', 'No fields exposed yet')}
          message={t('templates.authoring.emptyMessage', 'Expose a text, image or video layer above and it becomes an automation input other tools can fill.')}
        />
      )}

      {fields.length > 0 && (
        <>
          {/* Label / id / removal go through `setCompositionSettings.templateFields` (templateAuthoringEdits.ts); each commits once, on blur. */}
          <div className={styles.authoredList}>
            {fields.map((f) => (
              <div key={f.id} className={styles.authoredCard}>
                <div className={styles.authoredHead}>
                  <Input
                    defaultValue={f.label}
                    key={`${f.id}-label-${f.label}`}
                    onBlur={(e) => {
                      if (e.target.value !== f.label) void renameAuthoredFieldEdit(f.id, e.target.value);
                    }}
                    aria-label={t('templates.authoring.fieldLabel', 'Field label')}
                    className={styles.authoredLabel}
                  />
                  <button
                    type="button"
                    className={styles.iconBtn}
                    title={t('templates.authoring.removeField', 'Remove field')}
                    onClick={() => void removeAuthoredFieldEdit(f.id)}
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                </div>
                <div className={styles.authoredMeta}>
                  <span className={styles.authoredMetaLabel}>{t('templates.authoring.automationInput', 'Automation input')}</span>
                  <div className={styles.authoredMetaRow}>
                    <span className={styles.authoredMetaKey}>{t('templates.authoring.id', 'ID')}</span>
                    <Input
                      defaultValue={f.id}
                      key={`${f.id}-id`}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== f.id) void renameAuthoredFieldIdEdit(f.id, v);
                      }}
                      aria-label={t('templates.authoring.inputId', 'Input id')}
                      title={isPublicFieldId(f.id)
                        ? t('templates.authoring.inputIdPublic', 'Public input id for n8n')
                        : t('templates.authoring.inputIdInvalid', 'Must be a camelCase slug like character')}
                    />
                  </div>
                  <div className={styles.authoredMetaRow}>
                    <span className={styles.authoredMetaKey}>{t('templates.authoring.type', 'Type')}</span>
                    <span className={styles.kindBadge}>{fieldKindLabel(f.kind)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Button variant="primary" size="sm" onClick={previewAuthored}>
            {t('templates.authoring.preview', 'Preview fill-in ({n})', { n: fields.length })}
          </Button>
          {cloudProjectsEnabled() && (
            <Button variant="secondary" size="sm" onClick={() => void publish()}>
              {t('templates.authoring.saveAsTemplate', 'Save as Animation Template')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The exposed fields of the applied template.
 *
 * Exported so the inspector can host it. The whole `TemplateFieldsPanel` was
 * only reachable through a renderer id that was never registered — a built
 * MOGRT-style field editor with no way in — and its other half (the gallery)
 * duplicates the Library panel's Templates section, so surfacing THIS half is
 * the part that adds something.
 */
export function ActiveTemplateFields(): JSX.Element {
  const active = useTemplateStore((s) => s.active)!;
  const exit = useTemplateStore((s) => s.exit);
  const openPanel = useLayoutStore((s) => s.openPanel);

  // The controls are the active composition's fields (the mirror), the same
  // list Essential Graphics edits — one editor, two places to reach it.
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <div className={styles.templateName}>{active.name}</div>
          <div className={styles.templateHint}>{t('templates.fields.editing', 'Editing template content')}</div>
        </div>
        <Button variant="ghost" size="sm" leftIcon={<Icon name="layout" size="sm" />} onClick={() => openPanel('essentialGraphics')}>
          {t('templates.fields.openEg', 'Essential Graphics')}
        </Button>
        <Button variant="ghost" size="sm" leftIcon={<Icon name="grid" size="sm" />} onClick={exit}>
          {t('templates.fields.change', 'Change')}
        </Button>
      </div>
      <TemplateControls onBuild={() => openPanel('essentialGraphics')} />
    </div>
  );
}
