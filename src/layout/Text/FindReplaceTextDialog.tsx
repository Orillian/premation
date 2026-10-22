/**
 * Find and Replace Text — across the selection, the comp, or every comp.
 *
 * AE has no such dialog; motion designers do this by opening every text
 * layer in turn, which is exactly the chore a lower-thirds package with forty
 * name layers turns into an afternoon. The rules (grapheme-safe matching,
 * Match case, Whole word, run offsets kept on the right characters) live in
 * `findReplaceText.ts`; which text is searched — content AND Source Text
 * keyframe values — lives in `textFindReplace.ts`.
 *
 * The match count is live, so the user sees what Replace All will touch
 * before it touches it. Replace All is one undo entry.
 */

import { useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Checkbox } from '@components/Checkbox';
import { Segmented } from '@components/Segmented';
import { DialogFooter } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompId, useMirrorRevision } from '@hooks/useMirror';
import type { FindScope } from '@core/textTools/textFindReplace';
import { replaceTextEdit } from './textEdits';
import { activeCompIdNow, mirrorCountInScope, mirrorTextLayersInScope } from './textMirror';
import styles from './TextDialogs.module.css';
import { t } from '@core/i18n';

export const FIND_REPLACE_TEXT_MODAL_ID = 'find-replace-text';

function scopes(): ReadonlyArray<{ value: FindScope; label: string }> {
  return [
    { value: 'selected', label: t('text.findReplace.selectedLayers', 'Selected layers') },
    { value: 'comp', label: t('text.findReplace.thisComp', 'This comp') },
    { value: 'all', label: t('text.findReplace.allComps', 'All comps') },
  ];
}

/** "N matches in M layers" — each plural pairing a whole phrase, so word order stays the translator's. */
function matchesInLayers(matches: number, layers: number): string {
  const vars = { matches, layers };
  if (matches === 1) {
    return layers === 1
      ? t('text.findReplace.countOneOne', '{matches} match in {layers} layer', vars)
      : t('text.findReplace.countOneOther', '{matches} match in {layers} layers', vars);
  }
  return layers === 1
    ? t('text.findReplace.countOtherOne', '{matches} matches in {layers} layer', vars)
    : t('text.findReplace.countOtherOther', '{matches} matches in {layers} layers', vars);
}

function replacedInLayers(matches: number, layers: number): string {
  const vars = { matches, layers };
  if (matches === 1) {
    return layers === 1
      ? t('text.findReplace.replacedOneOne', 'Replaced {matches} match in {layers} layer.', vars)
      : t('text.findReplace.replacedOneOther', 'Replaced {matches} match in {layers} layers.', vars);
  }
  return layers === 1
    ? t('text.findReplace.replacedOtherOne', 'Replaced {matches} matches in {layers} layer.', vars)
    : t('text.findReplace.replacedOtherOther', 'Replaced {matches} matches in {layers} layers.', vars);
}

export function FindReplaceTextBody({ close, initialScope }: { close: () => void; initialScope: FindScope }): JSX.Element {
  // B4: counted over the document mirror; a document-wide count re-runs on
  // every revision (an edit or an undo can change any layer's text).
  const rev = useMirrorRevision();
  const selected = useSelectionStore((s) => s.ids);
  const activeComp = useActiveCompId();
  const [find, setFind] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [scope, setScope] = useState<FindScope>(initialScope);
  const [done, setDone] = useState<string | null>(null);

  const opts = useMemo(() => ({ matchCase, wholeWord }), [matchCase, wholeWord]);
  const count = useMemo(
    () => mirrorCountInScope(documentMirror(), scope, selected, activeComp, find, opts),
    // `rev` re-counts after an edit (or an undo) changes the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, find, opts, rev, selected, activeComp],
  );

  const replaceAll = (): void => {
    // One engine batch: Source Text (+ its re-indexed style runs) or its keys, per layer.
    void replaceTextEdit(scope, find, replacement, opts).then((r) => {
      setDone(replacedInLayers(r.matches, r.layers));
    });
  };

  const status = !find
    ? t('text.findReplace.typeToFind', 'Type text to find.')
    : count.matches === 0
      ? t('text.findReplace.noMatches', 'No matches.')
      : matchesInLayers(count.matches, count.layers);

  return (
    <div className={styles.body}>
      <div className={styles.fields}>
        <Input
          label={t('text.findReplace.find', 'Find')}
          value={find}
          autoFocus
          fullWidth
          onChange={(e) => { setFind(e.currentTarget.value); setDone(null); }}
        />
        <Input
          label={t('text.findReplace.replaceWith', 'Replace with')}
          value={replacement}
          fullWidth
          onChange={(e) => { setReplacement(e.currentTarget.value); setDone(null); }}
        />
      </div>
      <div className={styles.options}>
        <Checkbox label={t('text.findReplace.matchCase', 'Match case')} checked={matchCase} onChange={(e) => setMatchCase(e.currentTarget.checked)} />
        <Checkbox label={t('text.findReplace.wholeWord', 'Whole word')} checked={wholeWord} onChange={(e) => setWholeWord(e.currentTarget.checked)} />
      </div>
      <Segmented<FindScope>
        aria-label={t('text.findReplace.searchIn', 'Search in')}
        options={scopes()}
        value={scope}
        onChange={(s) => { setScope(s); setDone(null); }}
        fullWidth
        size="sm"
      />
      <p className={styles.status} role="status" aria-live="polite">
        {done ?? status}
      </p>
      <DialogFooter
        note={t('text.findReplace.sourceTextKeyframesAreSearched', 'Source Text keyframes are searched too.')}
        secondary={<Button variant="secondary" onClick={close}>{t('text.findReplace.close', 'Close')}</Button>}
        primary={
          <Button variant="primary" disabled={!find || count.matches === 0} onClick={replaceAll}>
            {t('text.findReplace.replaceAll', 'Replace All')}
          </Button>
        }
      />
    </div>
  );
}

/** Open the dialog. Starts on "Selected layers" when the selection holds text. */
export function openFindReplaceTextDialog(): void {
  const ids = useSelectionStore.getState().ids;
  const hasSelectedText = ids.length > 0 && mirrorTextLayersInScope(documentMirror(), 'selected', ids, activeCompIdNow()).length > 0;
  const initialScope: FindScope = hasSelectedText ? 'selected' : 'comp';
  openModal({
    id: FIND_REPLACE_TEXT_MODAL_ID,
    title: t('text.findReplace.findAndReplaceText', 'Find and Replace Text'),
    size: 'sm',
    render: (close) => <FindReplaceTextBody close={close} initialScope={initialScope} />,
  });
}
