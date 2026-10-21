/**
 * Shared browsing chrome for the asset-library sections.
 *
 * Each of Motion GFX / Transitions / Sound FX / Lottie had grown its own copy
 * of the same category strip and its own footer count, and none of them had a
 * search box: the only way to find "Glitch" was to know which of the four
 * sections it lived in and which category chip filtered to it. Sixty-odd items
 * behind two levels of tab is a browsing problem, and it was being solved four
 * times, badly.
 *
 * One toolbar, one filter pipeline, one empty state — sections supply their
 * items and render their own cards. Templates, Transitions, Sound FX and Lottie
 * mix bundled items with the premium shelf, so the toolbar also carries the
 * All / Free / Pro filter (`showTier`) and any section filter (`filters`).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { ScrollableStrip } from '@components/ScrollableStrip';
import { usePreferenceStore } from '@stores/preferenceStore';
import styles from './panels.module.css';
import cardStyles from './LibraryCards.module.css';
import { Segmented as SystemSegmented } from '@components/Segmented';
import { t } from '@core/i18n';

/** The least a library item must expose to be browsable. */
export interface BrowsableItem {
  id: string;
  name: string;
  cat: string;
  /** `cloud` = a premium item (Premation Cloud); absent = bundled and free. */
  tier?: 'free' | 'cloud';
  /** Searched alongside the name and category. */
  tags?: readonly string[];
}

export interface LibraryBrowserProps<T extends BrowsableItem> {
  items: readonly T[];
  /** Category ids in display order (without `all`, which is added). */
  categories: readonly string[];
  /** Display name for a category chip. */
  categoryLabel?: (cat: string) => string;
  /** Which kind of item is listed — picks the search / empty / count wording. */
  noun: LibraryNoun;
  /** Extra controls above the list — the Lottie import button, say. */
  toolbar?: ReactNode;
  /** Show the All / Free / Pro filter (the section lists premium items). */
  showTier?: boolean;
  /** Extra filter controls beside the tier filter (Templates' aspect). */
  filters?: ReactNode;
  /** A further filter the section owns (the aspect those controls set). */
  predicate?: (item: T) => boolean;
  /** Content after the list that stays when nothing matches (Templates' authoring tools). */
  after?: ReactNode;
  children: (items: T[]) => ReactNode;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export type LibraryNoun = 'preset' | 'transition' | 'sound' | 'animation' | 'template';

interface NounText {
  searchPlaceholder: string;
  search: string;
  categories: string;
  noFavourites: string;
  noMatch: (query: string) => string;
  count: (n: number, total: number) => string;
}

/**
 * Every sentence that names the listed kind, as a WHOLE phrase per noun —
 * never "Search " + noun + "s", which no other language can reorder or inflect.
 * Called at render time (`t()` needs the loaded catalogue).
 */
function nounText(noun: LibraryNoun): NounText {
  switch (noun) {
    case 'preset':
      return {
        searchPlaceholder: t('editor.library.preset.searchPlaceholder', 'Search presets…'),
        search: t('editor.library.preset.search', 'Search presets'),
        categories: t('editor.library.preset.categories', 'preset categories'),
        noFavourites: t('editor.library.preset.noFavourites', 'No favourite presets yet — star one to pin it here.'),
        noMatch: (query) => t('editor.library.preset.noMatch', 'No presets match “{query}”.', { query }),
        count: (n, total) => n === total
          ? (n === 1 ? t('editor.library.preset.countOne', '{n} preset', { n }) : t('editor.library.preset.countOther', '{n} presets', { n }))
          : (n === 1 ? t('editor.library.preset.countOfOne', '{n} preset of {total}', { n, total }) : t('editor.library.preset.countOfOther', '{n} presets of {total}', { n, total })),
      };
    case 'transition':
      return {
        searchPlaceholder: t('editor.library.transition.searchPlaceholder', 'Search transitions…'),
        search: t('editor.library.transition.search', 'Search transitions'),
        categories: t('editor.library.transition.categories', 'transition categories'),
        noFavourites: t('editor.library.transition.noFavourites', 'No favourite transitions yet — star one to pin it here.'),
        noMatch: (query) => t('editor.library.transition.noMatch', 'No transitions match “{query}”.', { query }),
        count: (n, total) => n === total
          ? (n === 1 ? t('editor.library.transition.countOne', '{n} transition', { n }) : t('editor.library.transition.countOther', '{n} transitions', { n }))
          : (n === 1 ? t('editor.library.transition.countOfOne', '{n} transition of {total}', { n, total }) : t('editor.library.transition.countOfOther', '{n} transitions of {total}', { n, total })),
      };
    case 'sound':
      return {
        searchPlaceholder: t('editor.library.sound.searchPlaceholder', 'Search sounds…'),
        search: t('editor.library.sound.search', 'Search sounds'),
        categories: t('editor.library.sound.categories', 'sound categories'),
        noFavourites: t('editor.library.sound.noFavourites', 'No favourite sounds yet — star one to pin it here.'),
        noMatch: (query) => t('editor.library.sound.noMatch', 'No sounds match “{query}”.', { query }),
        count: (n, total) => n === total
          ? (n === 1 ? t('editor.library.sound.countOne', '{n} sound', { n }) : t('editor.library.sound.countOther', '{n} sounds', { n }))
          : (n === 1 ? t('editor.library.sound.countOfOne', '{n} sound of {total}', { n, total }) : t('editor.library.sound.countOfOther', '{n} sounds of {total}', { n, total })),
      };
    case 'animation':
      return {
        searchPlaceholder: t('editor.library.animation.searchPlaceholder', 'Search animations…'),
        search: t('editor.library.animation.search', 'Search animations'),
        categories: t('editor.library.animation.categories', 'animation categories'),
        noFavourites: t('editor.library.animation.noFavourites', 'No favourite animations yet — star one to pin it here.'),
        noMatch: (query) => t('editor.library.animation.noMatch', 'No animations match “{query}”.', { query }),
        count: (n, total) => n === total
          ? (n === 1 ? t('editor.library.animation.countOne', '{n} animation', { n }) : t('editor.library.animation.countOther', '{n} animations', { n }))
          : (n === 1 ? t('editor.library.animation.countOfOne', '{n} animation of {total}', { n, total }) : t('editor.library.animation.countOfOther', '{n} animations of {total}', { n, total })),
      };
    case 'template':
      return {
        searchPlaceholder: t('editor.library.template.searchPlaceholder', 'Search templates…'),
        search: t('editor.library.template.search', 'Search templates'),
        categories: t('editor.library.template.categories', 'template categories'),
        noFavourites: t('editor.library.template.noFavourites', 'No favourite templates yet — star one to pin it here.'),
        noMatch: (query) => t('editor.library.template.noMatch', 'No templates match “{query}”.', { query }),
        count: (n, total) => n === total
          ? (n === 1 ? t('editor.library.template.countOne', '{n} template', { n }) : t('editor.library.template.countOther', '{n} templates', { n }))
          : (n === 1 ? t('editor.library.template.countOfOne', '{n} template of {total}', { n, total }) : t('editor.library.template.countOfOther', '{n} templates of {total}', { n, total })),
      };
  }
}

/** Starred ids and a toggle. Shared so a card in any section can star itself. */
export function useLibraryFavorites(): {
  favorites: ReadonlySet<string>;
  toggle: (id: string) => void;
  isFavorite: (id: string) => boolean;
} {
  const list = usePreferenceStore((s) => s.libraryFavorites);
  const setPref = usePreferenceStore((s) => s.set);
  const favorites = useMemo(() => new Set(list), [list]);
  return {
    favorites,
    isFavorite: (id) => favorites.has(id),
    toggle: (id) =>
      setPref('libraryFavorites', favorites.has(id) ? list.filter((x) => x !== id) : [...list, id]),
  };
}

/**
 * A star toggle for a library card.
 *
 * NOT a `<button>`: every card in this panel is itself a button, and a button
 * inside a button is invalid HTML — React warns about it and browsers recover
 * however they like, which typically means the inner control never receives the
 * click at all. A `role="button"` span is the standard escape, so it carries
 * its own keyboard handling to stay operable without the native element.
 *
 * The click is stopped from reaching the card, whose job is to INSERT: starring
 * something you did not want in the comp must not put it in the comp.
 */
export function FavoriteStar({ id, label }: { id: string; label: string }): JSX.Element {
  const { isFavorite, toggle } = useLibraryFavorites();
  const on = isFavorite(id);
  const description = on
    ? t('editor.library.unfavourite', 'Remove {name} from favourites', { name: label })
    : t('editor.library.favourite', 'Add {name} to favourites', { name: label });
  const activate = (e: { stopPropagation: () => void; preventDefault: () => void }): void => {
    e.stopPropagation();
    e.preventDefault();
    toggle(id);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={on ? styles.libStarOn : styles.libStar}
      title={description}
      aria-label={description}
      aria-pressed={on}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') activate(e);
      }}
      // The card is draggable; a drag begun on the star would otherwise start
      // dragging the whole item from a control that means "remember this".
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Icon name="star" size="sm" />
    </span>
  );
}

// ── Filters (shared with LibraryCards) ───────────────────────────────────────────────────────

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

/** The system segmented control at the panel's small size (Free / Pro, aspect). */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<SegOption<T>>;
  onChange: (v: T) => void;
  label: string;
}): JSX.Element {
  return <SystemSegmented size="sm" value={value} options={options} onChange={onChange} aria-label={label} />;
}

export type TierFilter = 'all' | 'free' | 'pro';

export function tierOptions(): ReadonlyArray<SegOption<TierFilter>> {
  return [
    { value: 'all', label: t('editor.library.tier.all', 'All') },
    { value: 'free', label: t('editor.library.tier.free', 'Free') },
    { value: 'pro', label: t('editor.library.tier.pro', 'Pro') },
  ];
}

export function LibraryBrowser<T extends BrowsableItem>({
  items, categories, categoryLabel, noun, toolbar, showTier = false, filters, predicate, after, children,
}: LibraryBrowserProps<T>): JSX.Element {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const [tier, setTier] = useState<TierFilter>('all');
  const { favorites } = useLibraryFavorites();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (starredOnly && !favorites.has(it.id)) return false;
      if (cat !== 'all' && it.cat !== cat) return false;
      if (showTier && tier === 'pro' && it.tier !== 'cloud') return false;
      if (showTier && tier === 'free' && it.tier === 'cloud') return false;
      if (predicate && !predicate(it)) return false;
      if (!q) return true;
      // Match the category too, so typing "glitch" finds both the item named
      // Glitch Cut and everything in the glitch category.
      return it.name.toLowerCase().includes(q) || it.cat.toLowerCase().includes(q)
        || (it.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
    });
  }, [items, query, cat, starredOnly, favorites, showTier, tier, predicate]);

  const starCount = useMemo(() => items.filter((i) => favorites.has(i.id)).length, [items, favorites]);
  const text = nounText(noun);

  return (
    <>
      <div className={styles.libSearchRow}>
        <Input
          placeholder={text.searchPlaceholder}
          size="sm"
          fullWidth
          leftIcon="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label={text.search}
        />
        <button
          type="button"
          className={starredOnly ? styles.libStarFilterOn : styles.libStarFilter}
          title={starredOnly ? t('editor.library.showAll', 'Show all') : t('editor.library.showFavourites', 'Show favourites only')}
          aria-label={starredOnly ? t('editor.library.showAll', 'Show all') : t('editor.library.showFavourites', 'Show favourites only')}
          aria-pressed={starredOnly}
          onClick={() => setStarredOnly((v) => !v)}
        >
          <Icon name="star" size="sm" />
        </button>
      </div>

      {(showTier || filters) && (
        <div className={cardStyles.filterRow}>
          {showTier && (
            <Segmented value={tier} options={tierOptions()} onChange={setTier} label={t('editor.library.tier.label', 'Free or Pro')} />
          )}
          {filters}
        </div>
      )}

      <ScrollableStrip
        role="tablist"
        ariaLabel={text.categories}
        className={styles.libCategoryStripWrap}
        scrollClassName={styles.libCategoryStrip}
      >
        {['all', ...categories].map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={cat === c}
            className={cat === c ? styles.libCategoryChipActive : styles.libCategoryChip}
            onClick={() => setCat(c)}
          >
            {c === 'all' ? t('editor.library.all', 'All') : (categoryLabel?.(c) ?? titleCase(c))}
          </button>
        ))}
      </ScrollableStrip>

      <div className={styles.libBody}>
        {toolbar}
        {filtered.length === 0 ? (
          <div className={styles.libEmpty}>
            <Icon name="search" size="md" />
            <span>
              {starredOnly && starCount === 0
                ? text.noFavourites
                : text.noMatch(query || cat)}
            </span>
          </div>
        ) : (
          children(filtered)
        )}
        {after}
      </div>

      <div className={styles.footer}>
        {text.count(filtered.length, items.length)}
        {starCount > 0 && ` ${t('editor.library.starred', '· {n} starred', { n: starCount })}`}
      </div>
    </>
  );
}
