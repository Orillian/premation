/**
 * LibraryPanel — one left-rail tab holding every insertable library.
 *
 * Seven sections, one tab: Templates, Transitions, Sound FX, Lottie,
 * Components, Shapes and Text — seven ideas for the same gesture: pick a thing,
 * drop it in the composition. (Motion GFX was an eighth; its elements left the
 * panel when Templates became the premium shelf.)
 *
 * Templates, Transitions, Sound FX and Lottie each list bundled (free) items
 * beside the premium shelf (Premation Cloud, server-delivered — LibraryCards.tsx
 * and core/library/premium/). Every card PLAYS OR DRAWS ITS OWN CONTENT rather
 * than illustrating it: bundled transition and template cards are the real
 * recipe drawn by the ENGINE from an isolated preview document (a still; the
 * motion plays while hovered or focused, core/template/previewController.ts),
 * Lottie cards render the document `applyImportPlan` will realise, sound
 * waveforms are the clip's actual peaks and every sound auditions before it is
 * added, and premium cards play the loop the server rendered from the same
 * payload the insert applies. A hand-drawn impression of an item can keep
 * looking right long after the item stopped behaving that way; a card driven
 * by the real thing cannot.
 *
 * `ComponentsPanel`, `ShapesPanel` and `TextPanel` are exported as components
 * but are NOT registered panels — they render as sections inside this one.
 *
 * Effects, Presets and Plugins follow them: the add-from libraries whose own
 * panels are on demand, drawn from those panels' bodies (`LibraryAddSections`).
 */

import { useMemo, useState, useRef, useEffect } from 'react';
import { Panel } from '@components/Panel';
import { ScrollableStrip } from '@components/ScrollableStrip';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { EmptyState } from '@components/EmptyState';
import { Icon, type IconName } from '@components/Icon';
import { useSelectionStore } from '@stores/selectionStore';
import { useComponentStore } from '@stores/componentStore';
import { useUIStore } from '@stores/uiStore';
import { getEventBus } from '@core/events/EventBus';
import { insertShapeEdit, insertTextEdit } from '@/engine-client/insertEdits';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { componentThumb, onComponentThumbReady } from '@core/library/componentThumbs';
import { transitionCategoryLabel } from '@core/library/transitionLibrary';
import { importLottieFileEdit } from './lottieInsertEdits';
import { TemplateFieldsPanel } from '@layout/Templates/TemplateFieldsPanel';
import { LibraryBrowser, FavoriteStar } from './LibraryBrowser';
import {
  PremiumCard, ProMark, ShelfNote, Waveform,
  premiumLocked, useAuditioning, usePremiumActivate, usePremiumShelf,
} from './LibraryCards';
import cardStyles from './LibraryCards.module.css';
import { auditionState, auditionUrl, stopAudition } from '@core/library/audition';
import { libraryMediaUrl } from '@core/library/premium/catalog';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';
import type { PremiumAccess } from '@hooks/usePremiumAccess';
import { usePremiumLibraryStore } from '@stores/premiumLibraryStore';
import { TRANSITION_KINDS, TRANSITION_LABEL } from '@core/timeline/transitionModel';
import { startCutTransitionDrag } from '@layout/Timeline/transitionDrag';
import { cutTransitionEffects } from '@layout/Timeline/cutTransitionEffects';
import { MyTransitions } from './MyTransitions';
import { TRANSITION_COMMAND_PREFIX } from '@layout/Timeline/transitionCommands';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { asCommandId } from '@app-types/common';
import styles from './panels.module.css';
import { t } from '@core/i18n';

const SHAPE_PRESETS = [
  { id: 'rect',     label: 'Rectangle', svg: <rect x="4" y="4" width="24" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'rect' },
  { id: 'ellipse',  label: 'Ellipse',   svg: <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'ellipse' },
  { id: 'line',     label: 'Line',      svg: <line x1="4" y1="28" x2="28" y2="4" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'line' },
  { id: 'triangle', label: 'Triangle',  svg: <polygon points="16,4 28,26 4,26" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'triangle' },
  { id: 'arrow',    label: 'Arrow',     svg: <polygon points="16,4 28,16 20,16 20,28 12,28 12,16 4,16" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'arrow' },
  { id: 'heart',    label: 'Heart',     svg: <path d="M16,6.5 C16,6.5 12,2 6,2 C1,2 -2,7 2,14 C6,20 16,28 16,28 C16,28 26,20 30,14 C34,7 31,2 26,2 C20,2 16,6.5 16,6.5 Z" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'heart' },
  { id: 'cross',    label: 'Cross',     svg: <polygon points="12,4 20,4 20,12 28,12 28,20 20,20 20,28 12,28 12,20 4,20 4,12 12,12" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'cross' },
  { id: 'diamond',  label: 'Diamond',   svg: <polygon points="16,2 30,16 16,30 2,16" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'diamond' },
  { id: 'crescent', label: 'Crescent',  svg: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="none" stroke="currentColor" strokeWidth="2" transform="scale(1.1) translate(1, 1)" />, primitive: 'crescent' },
  { id: 'star',     label: 'Star',      svg: <polygon points="16,2 20,11 30,12 22,19 24,29 16,24 8,29 10,19 2,12 12,11" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'star' },
  { id: 'polygon',  label: 'Polygon',   svg: <polygon points="16,3 28,10 28,24 16,31 4,24 4,10" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'polygon' },
] as const;

const TEXT_PRESETS = [
  { id: 'title',        label: 'Title',             fontSize: 72,  weight: 700 },
  { id: 'subtitle',     label: 'Subtitle',          fontSize: 48,  weight: 600 },
  { id: 'body',         label: 'Body',              fontSize: 36,  weight: 400 },
  { id: 'caption',      label: 'Caption',           fontSize: 24,  weight: 400 },
  { id: 'neon',         label: 'Neon Glow',         fontSize: 48,  weight: 700,  extra: { fill: '#38bdf8' } },
  { id: 'display',      label: 'Poster Headline',   fontSize: 84,  weight: 900,  extra: { letterSpacing: -2 } },
  { id: 'tag',          label: 'Uppercase Tag',     fontSize: 14,  weight: 700,  extra: { letterSpacing: 4, fill: '#f59e0b' } },
  { id: 'quote',        label: 'Quote',             fontSize: 32,  weight: 300,  extra: { fontStyle: 'italic', fill: '#94a3b8' } },
  { id: 'cyberpunk',    label: 'Cyber Accent',      fontSize: 20,  weight: 800,  extra: { fill: '#f43f5e', letterSpacing: 2 } },
  { id: 'mono',         label: 'Code Monospace',    fontSize: 28,  weight: 500,  extra: { fontFamily: 'monospace', fill: '#10b981' } },
] as const;

/*
 * Display names of the presets above, translated at render time. The `label`
 * fields stay English: they are what the insert writes (the shape layer's
 * name, the text layer's starting text), i.e. document content.
 */
function shapePresetLabel(id: typeof SHAPE_PRESETS[number]['id']): string {
  switch (id) {
    case 'rect': return t('editor.library.shape.rect', 'Rectangle');
    case 'ellipse': return t('editor.library.shape.ellipse', 'Ellipse');
    case 'line': return t('editor.library.shape.line', 'Line');
    case 'triangle': return t('editor.library.shape.triangle', 'Triangle');
    case 'arrow': return t('editor.library.shape.arrow', 'Arrow');
    case 'heart': return t('editor.library.shape.heart', 'Heart');
    case 'cross': return t('editor.library.shape.cross', 'Cross');
    case 'diamond': return t('editor.library.shape.diamond', 'Diamond');
    case 'crescent': return t('editor.library.shape.crescent', 'Crescent');
    case 'star': return t('editor.library.shape.star', 'Star');
    case 'polygon': return t('editor.library.shape.polygon', 'Polygon');
  }
}

function textPresetLabel(id: typeof TEXT_PRESETS[number]['id']): string {
  switch (id) {
    case 'title': return t('editor.library.textPreset.title', 'Title');
    case 'subtitle': return t('editor.library.textPreset.subtitle', 'Subtitle');
    case 'body': return t('editor.library.textPreset.body', 'Body');
    case 'caption': return t('editor.library.textPreset.caption', 'Caption');
    case 'neon': return t('editor.library.textPreset.neon', 'Neon Glow');
    case 'display': return t('editor.library.textPreset.display', 'Poster Headline');
    case 'tag': return t('editor.library.textPreset.tag', 'Uppercase Tag');
    case 'quote': return t('editor.library.textPreset.quote', 'Quote');
    case 'cyberpunk': return t('editor.library.textPreset.cyberpunk', 'Cyber Accent');
    case 'mono': return t('editor.library.textPreset.mono', 'Code Monospace');
  }
}

export function ComponentsPanel(): JSX.Element {
  const savedComponents = useComponentStore((s) => s.components);
  const saveComponent = useComponentStore((s) => s.saveFromSelection);
  const insertComponent = useComponentStore((s) => s.insert);
  const removeComponent = useComponentStore((s) => s.remove);
  const hasSelection = useSelectionStore((s) => s.ids.length > 0);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [componentName, setComponentName] = useState(() => t('editor.library.components.defaultName', 'My Component'));
  // Thumbnails are the engine's stills, answered asynchronously — repaint the grid as each lands.
  const [, setThumbTick] = useState(0);
  useEffect(() => onComponentThumbReady(() => setThumbTick((t) => t + 1)), []);

  const handleSave = () => {
    if (!componentName.trim()) return;
    const name = componentName;
    // B4: the component is the engine's copyLayers fragment of the selection (asked, so it lands a moment later).
    void saveComponent(name).then((id) => {
      useUIStore.getState().notify(
        id
          ? { level: 'success', message: t('editor.library.components.saved', 'Saved “{name}”', { name }), durationMs: 1800 }
          : { level: 'warning', message: t('editor.library.components.selectFirst', 'Select layer(s) to save first'), durationMs: 2000 },
      );
    });
    setShowSaveInput(false);
    setComponentName(t('editor.library.components.defaultName', 'My Component'));
  };

  return (
    <div className={styles.libBody}>
      <div className={styles.componentsActionRow}>
        {!showSaveInput ? (
          <Button
            size="sm"
            variant="secondary"
            fullWidth
            leftIcon={<Icon name="plus" size="sm" />}
            disabled={!hasSelection}
            title={hasSelection
              ? t('editor.library.components.saveTitle', 'Save the current selection as a reusable component')
              : t('editor.library.components.selectLayersFirst', 'Select layer(s) first')}
            onClick={() => setShowSaveInput(true)}
          >
            {t('editor.library.components.saveSelection', 'Save selection as component')}
          </Button>
        ) : (
          <div className={styles.componentsSaveRow}>
            <Input
              value={componentName}
              onChange={(e) => setComponentName(e.currentTarget.value)}
              autoFocus
              size="sm"
              fullWidth
              placeholder={t('editor.library.components.namePlaceholder', 'Component name')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') setShowSaveInput(false);
              }}
            />
            <Button size="sm" variant="primary" onClick={handleSave}>
              {t('editor.library.components.save', 'Save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSaveInput(false)}>
              {t('editor.library.components.cancel', 'Cancel')}
            </Button>
          </div>
        )}
      </div>

      {savedComponents.length === 0 ? (
        <EmptyState
          compact
          icon="component"
          message={t('editor.library.components.empty', 'No components yet. Select a layer or group and save it to reuse anywhere.')}
        />
      ) : (
        <div className={styles.libGrid}>
          {savedComponents.map((c) => (
            <div key={c.id} className={styles.componentCardWrap}>
              <button
                type="button"
                className={styles.libChip}
                title={t('editor.library.components.insertTitle', 'Insert a copy of “{name}” — or drag onto the canvas', { name: c.name })}
                draggable
                onDragStart={(e) => setCanvasDrag(e, { kind: 'component', componentId: c.id })}
                onClick={() => {
                  insertComponent(c.id);
                  useUIStore.getState().notify({ level: 'success', message: t('editor.library.components.inserted', 'Inserted {name}', { name: c.name }), durationMs: 1500 });
                }}
              >
                {(() => {
                  const thumb = componentThumb(c);
                  return thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className={styles.componentThumbImg}
                    />
                  ) : (
                    <span className={styles.libChipThumb}>
                      <Icon name="component" size="md" />
                    </span>
                  );
                })()}
                <span className={styles.libChipLabel}>{c.name}</span>
              </button>
              <button
                type="button"
                className={styles.componentDeleteBtn}
                aria-label={t('editor.library.components.deleteNamed', 'Delete {name}', { name: c.name })}
                title={t('editor.library.components.delete', 'Delete component')}
                onClick={() => removeComponent(c.id)}
              >
                <Icon name="close" size="sm" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ShapesPanel(): JSX.Element {
  const handleShapeInsert = (preset: typeof SHAPE_PRESETS[number]) => {
    // The shape builder (outline, tangents, stroke, comp-scaled placement) lays a
    // fragment → ONE pasteLayers entry (engine-client/insertEdits.ts).
    void insertShapeEdit(preset.primitive, preset.label);
  };

  return (
    <div className={styles.libBody}>
      <div className={styles.libGrid}>
        {SHAPE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={styles.libChip}
            title={t('editor.library.shape.insertTitle', 'Insert {name} — or drag onto the canvas', { name: shapePresetLabel(p.id) })}
            draggable
            onDragStart={(e) => setCanvasDrag(e, { kind: 'shape', primitive: p.primitive, label: p.label })}
            onClick={() => handleShapeInsert(p)}
          >
            <span className={styles.libChipThumb}>
              <svg width="24" height="24" viewBox="0 0 32 32" className={styles.shapeSvgIcon}>
                {p.svg}
              </svg>
            </span>
            <span className={styles.libChipLabel}>{shapePresetLabel(p.id)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TextPanel(): JSX.Element {
  const handleTextInsert = (preset: typeof TEXT_PRESETS[number]) => {
    // The text preset builder (size, weight, style extras, placement) lays a
    // fragment → ONE pasteLayers entry (engine-client/insertEdits.ts).
    void insertTextEdit(preset.label, preset.fontSize, preset.weight, (preset as { extra?: Record<string, unknown> }).extra ?? {});
  };

  return (
    <div className={styles.libBody}>
      <div className={styles.libList}>
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={styles.libTextItem}
            title={t('editor.library.textPreset.insertTitle', 'Insert {name} text layer — or drag onto the canvas', { name: textPresetLabel(p.id) })}
            draggable
            onDragStart={(e) => setCanvasDrag(e, { kind: 'text', label: p.label, fontSize: p.fontSize, weight: p.weight, extra: (p as any).extra ?? {} })}
            onClick={() => handleTextInsert(p)}
          >
            <span
              style={{
                fontSize: Math.min(p.fontSize / 3, 20),
                fontWeight: p.weight,
                fontStyle: (p as any).extra?.fontStyle,
                color: (p as any).extra?.fill || 'inherit',
                fontFamily: (p as any).extra?.fontFamily || 'inherit',
                letterSpacing: (p as any).extra?.letterSpacing ? `${(p as any).extra.letterSpacing}px` : 'normal',
                textTransform: (p as any).extra?.transform || 'none',
              }}
            >
              {textPresetLabel(p.id)}
            </span>
            <span className={styles.libTextMeta}>
              {p.fontSize}px · w{p.weight}
              {(p as any).extra?.fill && ` ${t('editor.library.textPreset.styled', '· styled')}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}


// ── Shared shelf helpers ──────────────────────────────────────────

/** A shelf row as LibraryBrowser filters it. */
interface ShelfEntry {
  id: string;
  name: string;
  cat: string;
  tier: 'cloud' | 'free';
  tags: readonly string[];
  item: PremiumCatalogItem;
}

const catId = (label: string): string => label.trim().toLowerCase().replace(/\s+/g, '-');
const titleCase = (cat: string): string => cat.charAt(0).toUpperCase() + cat.slice(1).replace(/-/g, ' ');

function shelfEntries(items: readonly PremiumCatalogItem[]): ShelfEntry[] {
  return items.map((item) => ({ id: item.id, name: item.name, cat: catId(item.category), tier: item.tier, tags: item.tags, item }));
}

/** The shelf's categories in a preferred order, then any others it brings. */
function orderedCategories(order: readonly string[], entries: readonly ShelfEntry[]): string[] {
  const out = [...order];
  for (const e of entries) if (!out.includes(e.cat)) out.push(e.cat);
  return out.filter((c) => entries.some((e) => e.cat === c));
}

/** Says why a shelf is empty instead of showing an empty grid. */
function ShelfEmpty({ shelf, noun }: { shelf: ReturnType<typeof usePremiumShelf>; noun: 'transitions' | 'sounds' | 'animations' }): JSX.Element | null {
  if (shelf.items.length > 0) return null;
  const loading = shelf.status === 'loading' || shelf.status === 'idle';
  const text = shelf.access === 'local'
    ? t('editor.library.shelf.local', 'The library comes with a Premation account — sign in from the Premation app to browse it.')
    : loading
      ? t('editor.library.shelf.loading', 'Loading the library…')
      : noun === 'transitions'
        ? t('editor.library.shelf.noneTransitions', 'No transitions are available right now.')
        : noun === 'sounds'
          ? t('editor.library.shelf.noneSounds', 'No sounds are available right now.')
          : t('editor.library.shelf.noneAnimations', 'No animations are available right now.');
  return (
    <p className={cardStyles.shelfNote} role="status">
      <Icon name="info" size="sm" />
      <span>{text}</span>
    </p>
  );
}

// ── Transitions ───────────────────────────────────────────────────
// The library's transitions are Pro specs keyed onto layers (one undo entry
// through the engine). The cut transitions and effect wipes above them are
// timeline TOOLS, not library items, and are always here.

const TRANSITION_CATEGORIES: readonly string[] = ['seamless', 'zoom', 'whip', 'slide', 'glitch', 'light', 'shape', 'wipe', 'fade'];

function transitionChipLabel(cat: string): string {
  return ['fade', 'slide', 'zoom', 'whip', 'glitch', 'wipe'].includes(cat) ? transitionCategoryLabel(cat) : titleCase(cat);
}

function TransitionTools(): JSX.Element {
  return (
    <>
      {/* Cut transitions: engine transition records between two
          adjacent bars. Drag one onto a cut in the timeline; a click adds
          it at the cut nearest the playhead. */}
      <div className={cardStyles.groupHead}>{t('editor.library.transition.cutSection', 'Cut Transitions — drag onto a cut')}</div>
      <div className={styles.libCutRow}>
        {TRANSITION_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            draggable
            className={styles.libCutItem}
            title={t('editor.library.transition.cutTitle', '{name} — drag onto the cut between two layers in the timeline, or click to add it at the cut nearest the playhead', { name: TRANSITION_LABEL[kind] })}
            aria-label={t('editor.library.transition.cutLabel', '{name} cut transition', { name: TRANSITION_LABEL[kind] })}
            onDragStart={(e) => startCutTransitionDrag(e.dataTransfer, kind)}
            onClick={() => { void getCommandSystem().execute(asCommandId(`${TRANSITION_COMMAND_PREFIX}add.${kind}`)); }}
          >
            {TRANSITION_LABEL[kind]}
          </button>
        ))}
      </div>
      {/* Effect wipes: any Transition effect with a Transition Completion,
          ramped across the cut on the incoming layer. Drag onto a cut;
          its direction, softness and ease are in Transition Settings. */}
      <div className={styles.libCutRow} aria-label={t('editor.library.transition.effectWipes', 'Effect wipes')}>
        {cutTransitionEffects().map((fx) => (
          <button
            key={fx.type}
            type="button"
            draggable
            className={styles.libCutItem}
            title={t('editor.library.transition.wipeTitle', '{name} — drag onto the cut between two layers; double-click the bracket afterwards for direction, softness and ease', { name: fx.label })}
            aria-label={t('editor.library.transition.cutLabel', '{name} cut transition', { name: fx.label })}
            onDragStart={(e) => startCutTransitionDrag(e.dataTransfer, 'wipe', fx.type)}
          >
            {fx.label}
          </button>
        ))}
      </div>
      <MyTransitions />
      <div className={cardStyles.groupHead}>{t('editor.library.transition.layerSection', "Layer Transitions — drag onto a layer's start or end")}</div>
    </>
  );
}

function TransitionsContent(): JSX.Element {
  const shelf = usePremiumShelf('transition');
  const entries = useMemo(() => shelfEntries(shelf.items), [shelf.items]);
  const categories = useMemo(() => orderedCategories(TRANSITION_CATEGORIES, entries), [entries]);
  return (
    <div className={cardStyles.section}>
      <LibraryBrowser
        items={entries}
        categories={categories}
        categoryLabel={transitionChipLabel}
        noun="transition"
        toolbar={<><TransitionTools /><ShelfEmpty shelf={shelf} noun="transitions" /><ShelfNote shelf={shelf} /></>}
      >
        {(items) => (
          <div className={cardStyles.grid}>
            {items.map((e) => <PremiumCard key={e.id} item={e.item} access={shelf.access} />)}
          </div>
        )}
      </LibraryBrowser>
    </div>
  );
}

// ── Sound FX ──────────────────────────────────────────────────────
// Mixed stereo sound design from the library; every sound auditions (its
// public preview) before it is added, one at a time.

const formatSeconds = (s: number): string => (s < 1 ? `${s.toFixed(2)} s` : `${s.toFixed(1)} s`);

const SFX_CATEGORIES: readonly string[] = ['impact', 'whoosh', 'riser', 'ui', 'glitch', 'foley', 'magic', 'music'];

function sfxCategoryLabel(cat: string): string {
  switch (cat) {
    case 'whoosh': return t('editor.library.sfx.catWhoosh', 'Whoosh');
    case 'impact': return t('editor.library.sfx.catImpact', 'Impact');
    case 'riser': return t('editor.library.sfx.catRiser', 'Riser');
    case 'ui': return t('editor.library.sfx.catUi', 'UI');
    case 'glitch': return t('editor.library.sfx.catGlitch', 'Glitch');
    case 'foley': return t('editor.library.sfx.catFoley', 'Foley');
    case 'music': return t('editor.library.sfx.catMusic', 'Music');
    case 'magic': return t('editor.library.sfx.catMagic', 'Magic');
    default: return titleCase(cat);
  }
}

function SoundRow({ item, access, onAudition }: {
  item: PremiumCatalogItem;
  access: PremiumAccess;
  onAudition: () => void;
}): JSX.Element {
  const playing = useAuditioning(item.id);
  const busy = usePremiumLibraryStore((s) => s.busy.has(item.id));
  const add = usePremiumActivate(item, access);
  const locked = premiumLocked(item, access);
  const name = item.name;
  return (
    <div
      className={cardStyles.soundRow}
      data-playing={playing}
      title={t('editor.library.sfx.rowTitle', '{name} — click to listen; + or drag to add at the playhead', { name })}
      draggable={!locked}
      onDragStart={(e) => { if (!locked) setCanvasDrag(e, { kind: 'premium', itemId: item.id, name }); }}
      onClick={onAudition}
      onDoubleClick={() => { if (!busy) add(); }}
    >
      <button
        type="button"
        className={cardStyles.play}
        aria-pressed={playing}
        aria-label={playing
          ? t('editor.library.sfx.stop', 'Stop {name}', { name })
          : t('editor.library.sfx.play', 'Play {name}', { name })}
        onClick={(e) => { e.stopPropagation(); onAudition(); }}
      >
        <Icon name={playing ? 'stop' : 'play'} size="sm" />
      </button>
      <Waveform id={item.id} peaks={item.peaks ?? []} />
      <span className={cardStyles.metaText}>
        <span className={cardStyles.name}>{busy ? t('editor.library.sfx.adding', 'Adding…') : name}</span>
        <span className={cardStyles.meta}>{`${sfxCategoryLabel(catId(item.category))} · ${formatSeconds(item.durationSec)}`}</span>
      </span>
      <span className={cardStyles.rowAction}>
        {item.tier === 'cloud' && <ProMark locked={access !== 'pro'} />}
        <FavoriteStar id={item.id} label={name} />
        <button
          type="button"
          className={cardStyles.add}
          aria-label={t('editor.library.sfx.add', 'Add {name} at the playhead', { name })}
          title={t('editor.library.sfx.add', 'Add {name} at the playhead', { name })}
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); if (!busy) add(); }}
        >
          <Icon name="plus" size="sm" />
        </button>
      </span>
    </div>
  );
}

function SoundFXContent(): JSX.Element {
  const notify = useUIStore((s) => s.notify);
  const shelf = usePremiumShelf('sfx');
  const entries = useMemo(() => shelfEntries(shelf.items), [shelf.items]);
  const categories = useMemo(() => orderedCategories(SFX_CATEGORIES, entries), [entries]);

  // Leaving the tab (or the panel) stops the audition.
  useEffect(() => () => stopAudition(), []);

  const toggle = (item: PremiumCatalogItem): void => {
    if (auditionState().id === item.id) {
      stopAudition();
      return;
    }
    const audio = libraryMediaUrl(item.audio);
    if (!audio) return;
    auditionUrl(item.id, audio, item.durationSec, () => notify({ level: 'warning', message: t('editor.library.sfx.previewFailed', 'Could not play the preview of {name}', { name: item.name }), durationMs: 2400 }));
  };

  return (
    <div className={cardStyles.section}>
      <LibraryBrowser
        items={entries}
        categories={categories}
        categoryLabel={sfxCategoryLabel}
        noun="sound"
        toolbar={<><ShelfEmpty shelf={shelf} noun="sounds" /><ShelfNote shelf={shelf} /></>}
      >
        {(items) => (
          <div className={cardStyles.soundList}>
            {items.map((e) => (
              <SoundRow key={e.id} item={e.item} access={shelf.access} onAudition={() => toggle(e.item)} />
            ))}
          </div>
        )}
      </LibraryBrowser>
    </div>
  );
}

// ── Lottie ────────────────────────────────────────────────────────
// Vector micro-interactions from the library, landing as editable shape
// layers; plus importing the user's own .json / .lottie file.

const LOTTIE_CATEGORIES: readonly string[] = ['feedback', 'loaders', 'icons', 'social', 'celebration'];

function lottieCategoryLabel(cat: string): string {
  switch (cat) {
    case 'feedback': return t('editor.library.lottie.catFeedback', 'Feedback');
    case 'loaders': return t('editor.library.lottie.catLoaders', 'Loaders');
    case 'icons': return t('editor.library.lottie.catIcons', 'Icons');
    case 'social': return t('editor.library.lottie.catSocial', 'Social');
    case 'celebration': return t('editor.library.lottie.catCelebration', 'Celebration');
    default: return titleCase(cat);
  }
}

function LottieContent(): JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const shelf = usePremiumShelf('lottie');
  const entries = useMemo(() => shelfEntries(shelf.items), [shelf.items]);
  const categories = useMemo(() => orderedCategories(LOTTIE_CATEGORIES, entries), [entries]);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // The importer's layer tree lands as ONE pasteLayers entry (lottieInsertEdits.ts).
    await importLottieFileEdit(file);
  };

  const toolbar = (
    <>
      <div className={cardStyles.importRow}>
        <Button size="sm" variant="secondary" fullWidth
          leftIcon={<Icon name="download" size="sm" />}
          onClick={() => fileRef.current?.click()}>
          {t('editor.library.lottie.import', 'Import .json / .lottie File…')}
        </Button>
        <input ref={fileRef} type="file" accept=".json,.lottie,application/json,application/x-lottie" hidden
          onChange={(e) => { void onPickFile(e); }} />
      </div>
      <ShelfEmpty shelf={shelf} noun="animations" />
      <ShelfNote shelf={shelf} />
    </>
  );

  return (
    <div className={cardStyles.section}>
      <LibraryBrowser
        items={entries}
        categories={categories}
        categoryLabel={lottieCategoryLabel}
        noun="animation"
        toolbar={toolbar}
      >
        {(items) => (
          <div className={cardStyles.gridTight}>
            {items.map((e) => <PremiumCard key={e.id} item={e.item} access={shelf.access} square />)}
          </div>
        )}
      </LibraryBrowser>
    </div>
  );
}

// ── Library Panel — ONE home for asset libraries ──────────────────
// Templates / Transitions / Sound FX / Lottie / Components / Shapes / Text live as sections inside a single sidebar tab.

type LibrarySection =
  | 'templates' | 'transitions' | 'sfx' | 'lottie' | 'components' | 'shapes' | 'text';

/** A function, not a constant: `t()` must run at render time, never at module scope. */
function librarySections(): ReadonlyArray<{ id: LibrarySection; label: string; icon: IconName }> {
  return [
    /*
      Templates leads: it is the library's premium shelf. Motion GFX used to
      sit here; its elements are no longer offered in the panel (the AI recipes
      and documents that already use them still resolve through
      mographLibrary.ts).
    */
    { id: 'templates',   label: t('editor.library.section.templates', 'Templates'),     icon: 'layout' },
    { id: 'transitions', label: t('editor.library.section.transitions', 'Transitions'), icon: 'scissors' },
    { id: 'sfx',         label: t('editor.library.section.sfx', 'Sound FX'),            icon: 'voice' },
    { id: 'lottie',      label: t('editor.library.section.lottie', 'Lottie'),           icon: 'video' },
    { id: 'components',  label: t('editor.library.section.components', 'Components'),   icon: 'component' },
    { id: 'shapes',      label: t('editor.library.section.shapes', 'Shapes'),           icon: 'shape' },
    { id: 'text',        label: t('editor.library.section.text', 'Text'),               icon: 'type' },
  ];
}

export function LibraryPanel(): JSX.Element {
  const [section, setSection] = useState<LibrarySection>('templates');
  return (
    <Panel id="library" title={t('panel.library', 'Library')} icon="sparkles" hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'library' })}>
      {/* The bottom rule lives in `.libTabs`. The inline copy that was here
          drew a SECOND hairline under the stylesheet's, and carried a
          `var(--color-border, rgba(255,255,255,0.08))` fallback for a token
          that has always been defined — a white-ish line hardcoded for dark. */}
      <ScrollableStrip
        role="tablist"
        ariaLabel={t('editor.library.sections', 'Library sections')}
        className={styles.libTabsWrap}
        scrollClassName={styles.libTabs}
      >
        {librarySections().map((s) => (
          <button key={s.id} type="button"
            role="tab"
            aria-selected={section === s.id}
            // Was `libTab` PLUS `libTabActive`, but `libTabActive` already
            // `composes: libTab` — so the base class landed twice.
            className={section === s.id ? styles.libTabActive : styles.libTab}
            title={s.label}
            onClick={() => setSection(s.id)}>
            <Icon name={s.icon} size="sm" />
            <span>{s.label}</span>
          </button>
        ))}
      </ScrollableStrip>
      {section === 'transitions' && <TransitionsContent />}
      {section === 'sfx' && <SoundFXContent />}
      {section === 'lottie' && <LottieContent />}
      {section === 'components' && <ComponentsPanel />}
      {section === 'shapes' && <ShapesPanel />}
      {section === 'text' && <TextPanel />}
      {section === 'templates' && <TemplateFieldsPanel />}
    </Panel>
  );
}
