/**
 * "Animate selection", at the top of the Presets panel.
 *
 * ── It drives the COMMANDS, not the code underneath ────────────────
 * Every button in the lower half resolves a command by id and calls its
 * `execute`. Re-calling `animateLayers` or `smartAnimateBetween` directly
 * would be shorter and would slowly drift: the toast, the seed, the frame rate
 * and the feel are decided inside those command bodies, and a second caller
 * means a second set of decisions to keep in step. Reading `enabled()` from the
 * same place is what makes a greyed button here mean exactly what a greyed
 * entry means in the palette.
 *
 * The choreography block at the top is the deliberate exception, and it has to
 * be: commands take no arguments. A parametric gesture — this order, this
 * spacing, this seed, these per-layer nudges — cannot be expressed as "run
 * command id", so it calls `runChoreography` directly. The commands call that
 * same function with their own params, so there is still exactly one apply
 * path and one place that records what happened; what differs is who chooses
 * the numbers.
 *
 * ── Why the parameters are here at all ─────────────────────────────
 * Choreography used to be one-shot. You pressed Animate In, and if the rhythm
 * was a frame too quick or the layers should have arrived from the left, the
 * only move was undo and a second guess from a menu that exposes none of those
 * numbers. Everything the generator decides is now a control, and the last run
 * is remembered exactly enough to be REPLACED rather than layered over — see
 * `choreographyStore`.
 *
 * ── Absent, not broken ─────────────────────────────────────────────
 * A row whose command cannot run is hidden when the reason is structural (no
 * audio layer in the composition, no other board to animate to) and DISABLED
 * with a reason when the reason is the current selection. The difference
 * matters: "there is nothing to do here" and "pick a layer first" are
 * different messages, and showing four dead buttons teaches people the panel
 * is broken.
 *
 * It lives in the Presets panel rather than in one of its own. That panel is
 * already "apply motion to this layer", it is already registered, and a fifth
 * tab would be worse than a section at the top of the right one.
 */

import { useState } from 'react';
import { asCommandId } from '@app-types/common';
import { getCommandRegistry } from '@core/commands/Command';
import { Icon } from '@components/Icon';
import { useSelectionStore } from '@stores/selectionStore';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { useChoreographyStore, type ChoreographyRecord } from '@stores/choreographyStore';
import { documentMirror } from '@stores/documentMirror';
import {
  useActiveCompFps,
  useActiveCompId,
  useMirrorKeys,
  useMirrorLayersWatch,
  useMirrorTrackWatch,
} from '@hooks/useMirror';
import {
  curveAnimatedLayerIds,
  firstAudioLayerIn,
  retimableLayerIds,
  smartAnimateTargetsIn,
  staggerLayersIn,
} from '@core/mirror/motionAssist';
import { EASE_PRESETS, type EasePresetId } from '@core/animation/easePresets';
import {
  DEFAULT_STAGGER_PARAMS,
  feelDurationSec,
  feelStaggerFrames,
  planStagger,
  STAGGER_ORDERS,
  type ChoreographyFeel,
  type StaggerOrder,
  type StaggerParams,
} from '@core/animation/choreography';
import {
  reapplyChoreography,
  revertChoreography,
  runChoreography,
} from '@core/animation/choreographyCommands';
import styles from './ChoreographySection.module.css';
import { t } from '@core/i18n';

function feels(): ReadonlyArray<{ value: ChoreographyFeel; label: string; hint: string }> {
  return [
    { value: 'snappy', label: t('motion.choreo.snappy', 'Snappy'), hint: t('motion.choreo.snappyHint', 'Short, tight, close together') },
    { value: 'smooth', label: t('motion.choreo.smooth', 'Smooth'), hint: t('motion.choreo.smoothHint', 'Longer travel with a soft landing') },
    { value: 'bouncy', label: t('motion.choreo.bouncy', 'Bouncy'), hint: t('motion.choreo.bouncyHint', 'Overshoots and settles') },
  ];
}

/** Plain-language names for the orders — nobody sorts "byPositionX". */
function orderLabel(order: StaggerOrder): string {
  switch (order) {
    case 'timeline': return t('motion.choreo.orderSelection', 'Selection order');
    case 'reverse': return t('motion.choreo.orderReverse', 'Reverse order');
    case 'byPositionX': return t('motion.choreo.orderLeftRight', 'Left to right');
    case 'byPositionY': return t('motion.choreo.orderTopBottom', 'Top to bottom');
    case 'byDistanceFromCenter': return t('motion.choreo.orderOutward', 'Outward from centre');
    case 'random': return t('motion.choreo.orderShuffled', 'Shuffled (seeded)');
    default: return order;
  }
}

function kindLabel(kind: 'in' | 'out' | 'stagger'): string {
  switch (kind) {
    case 'in': return t('motion.choreo.kindIn', 'Animate in');
    case 'out': return t('motion.choreo.kindOut', 'Animate out');
    default: return t('motion.choreo.kindStagger', 'Stagger');
  }
}

/** Buttons shown before the rest are left to the palette. A board list can be
 *  long, and this section sits above the preset library it must not crowd. */
const MAX_TARGETS = 4;

/** Rows before the per-layer list stops competing with the preset library. */
const MAX_LAYER_ROWS = 12;

/** The tracks the stagger orders read (resting position). */
const POSITION_TRACKS: readonly string[] = ['x', 'y'];

function run(id: string): void {
  const command = getCommandRegistry().get(asCommandId(id));
  void command?.execute({} as never);
}

function canRun(id: string): boolean {
  const command = getCommandRegistry().get(asCommandId(id));
  if (!command) return false;
  return command.enabled ? command.enabled() !== false : true;
}

/**
 * The auto-minted empty placeholder comp (the start-cards state) — what
 * Smart Animate never offers as a target: its `CompSettings.pristine` mark.
 */
function isPlaceholderComp(compId: string): boolean {
  return documentMirror().comp(compId)?.settings.pristine === true;
}

export function ChoreographySection(): JSX.Element {
  // The selection drives most `enabled()` checks; the document parts below
  // come from the document mirror (B4), subscribed to exactly what they read.
  const selected = useSelectionStore((s) => s.ids);
  const activeId = useActiveCompId();
  // The key choreography records are filed under (`choreographyCommands`
  // `activeCompId`): the active tab's composition, or the default record's id.
  const compId = activeId ?? DEFAULT_COMPOSITION.id;
  const fps = useActiveCompFps();
  const record = useChoreographyStore((s) => s.byComp[compId]);
  const m = documentMirror();
  // Layers appearing or going (the audio row), the boards (Smart Animate: a
  // board created, renamed, deleted or drawn into), the selection's headers,
  // trees and keys (ramp / stagger availability).
  useMirrorKeys(['layers', 'comps', ...m.compIds.flatMap((c) => [`comp:${c}`, `order:${c}`])]);
  useMirrorLayersWatch(selected);

  /**
   * The DRAFT parameters — edited freely, applied on a button press.
   *
   * Local rather than written straight into the store because these controls
   * are not the applied state: typing "1" on the way to "12" must not restage
   * the whole composition, and a swing you are still adjusting is not a swing
   * you have chosen. The store holds what was actually applied; this holds
   * what would be.
   */
  const [draft, setDraft] = useState<StaggerParams>(DEFAULT_STAGGER_PARAMS);
  /**
   * The record the draft was last adopted from. Compared by timestamp, not by
   * an effect: a run that happened elsewhere (the palette, the Animation menu)
   * should load its numbers into these controls exactly once, and an effect
   * with `record` in its deps would fight every keystroke made afterwards.
   */
  const [adopted, setAdopted] = useState(0);
  if (record && record.at !== adopted) {
    setAdopted(record.at);
    setDraft(record.params);
  }

  const patch = (next: Partial<StaggerParams>): void => setDraft((d) => ({ ...d, ...next }));

  // Derived on every render rather than memoised, from the mirror's immutable
  // records (the subscriptions above wake this for exactly what they read).
  // These are cheap array walks; correctness is worth more than skipping them.
  const hasSelection = selected.length > 0;
  const hasAudio = firstAudioLayerIn(m) !== undefined;
  const canRamp = retimableLayerIds(m, selected).length > 0;
  const targets = smartAnimateTargetsIn(m, activeId, isPlaceholderComp);
  const canStagger = curveAnimatedLayerIds(m, selected).length >= 2;

  /**
   * The layers the offset list is about: the recorded run's when there is one,
   * otherwise the live selection. A record whose layers you can no longer see
   * is the case that matters — you click something else to check it, and the
   * numbers you are about to re-apply must not silently become another set.
   */
  const listedIds = record ? record.nodeIds : selected;
  // Their names and resting x / y (the "by position" orders) at the anchor time.
  useMirrorTrackWatch(listedIds, POSITION_TRACKS);
  const layers = staggerLayersIn(m, listedIds, record?.atCompTime ?? 0);
  const plan = planStagger(layers, draft);

  const setOverride = (nodeId: string, raw: string): void => {
    const next = { ...draft.perLayerOverrides };
    const n = Number(raw);
    // An empty box means "back to the plan", not "zero" — otherwise clearing a
    // field to retype it would pin the layer to the first frame en route.
    if (raw.trim() === '' || !Number.isFinite(n)) delete next[nodeId];
    else next[nodeId] = Math.round(n);
    patch({ perLayerOverrides: next });
  };

  const apply = (kind: 'in' | 'out' | 'stagger'): void => {
    const ids = kind === 'stagger' ? curveAnimatedLayerIds(documentMirror(), selected) : selected;
    if (ids.length === 0) return;
    // B4-gap: the choreography runners (run / re-apply / revert) capture and
    // shift EVERY stored track of the layers, catalog or not, inside one legacy
    // animation edit — the keyframe-assistants gap (B4_MIRROR.md §5).
    void runChoreography({ kind, nodeIds: ids, params: draft });
  };

  return (
    <div className={styles.root}>
      <div className={styles.heading}>
        <Icon name="sparkles" size="sm" />
        <span>{t('motion.choreo.heading', 'Animate selection')}</span>
      </div>

      {/* The feel belongs to THIS gesture, not to the project. The global
          Motion Feel preference still governs the palette commands; a panel
          with the numbers in front of you should not need a trip to a menu to
          change one of them. */}
      <div className={styles.feelRow} role="group" aria-label={t('motion.choreo.feelAria', 'Motion feel')}>
        {feels().map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.feelButton}
            data-active={draft.feel === option.value}
            title={t('motion.choreo.feelTitle', '{hint} — about {seconds}s per layer', { hint: option.hint, seconds: feelDurationSec(option.value).toFixed(2) })}
            aria-pressed={draft.feel === option.value}
            onClick={() => patch({
              feel: option.value,
              // The base offset follows the feel unless it has been touched.
              // Picking "Snappy" and keeping the smooth rhythm anyway is the
              // control appearing to do nothing; overwriting a number someone
              // typed is worse. So: move it only while it is still the old
              // feel's default.
              baseOffsetFrames: draft.baseOffsetFrames === feelStaggerFrames(draft.feel, fps)
                ? feelStaggerFrames(option.value, fps)
                : draft.baseOffsetFrames,
            })}
          >
            {option.label}
          </button>
        ))}
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('motion.choreo.order', 'Order')}</span>
        <select
          className={styles.select}
          value={draft.order}
          onChange={(e) => patch({ order: e.target.value as StaggerOrder })}
        >
          {STAGGER_ORDERS.map((order) => (
            <option key={order} value={order}>{orderLabel(order)}</option>
          ))}
        </select>
      </label>

      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('motion.choreo.offset', 'Offset')}</span>
          <input
            className={styles.number}
            type="number"
            min={0}
            step={1}
            value={draft.baseOffsetFrames}
            title={t('motion.choreo.offsetTitle', 'Frames between arrivals. 0 brings every layer in together.')}
            onChange={(e) => patch({ baseOffsetFrames: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
          <span className={styles.unit}>fr</span>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('motion.choreo.swing', 'Swing')}</span>
          <input
            className={styles.number}
            type="number"
            min={0}
            max={100}
            step={5}
            value={draft.swingPct}
            title={t('motion.choreo.swingTitle', 'How much each gap varies. 0 is a metronome; the variation is never smaller than one frame.')}
            onChange={(e) => patch({ swingPct: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
          <span className={styles.unit}>%</span>
        </label>
      </div>

      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('motion.choreo.seed', 'Seed')}</span>
          <input
            className={styles.number}
            type="number"
            step={1}
            value={draft.seed}
            title={t('motion.choreo.seedTitle', 'Same seed, same rhythm and same shuffle.')}
            onChange={(e) => patch({ seed: Math.round(Number(e.target.value) || 0) })}
          />
        </label>
        <button
          type="button"
          className={styles.iconButton}
          title={t('motion.choreo.reroll', 'Reroll the seed')}
          aria-label={t('motion.choreo.reroll', 'Reroll the seed')}
          onClick={() => patch({ seed: 1 + Math.floor(Math.random() * 0xffffff) })}
        >
          <Icon name="rotate-cw" size="sm" />
        </button>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('motion.choreo.ease', 'Ease')}</span>
        <select
          className={styles.select}
          value={draft.easeCurve ?? ''}
          title={t('motion.choreo.easeTitle', 'Overrides the feel\'s own entrance curve.')}
          onChange={(e) => {
            const value = e.target.value;
            setDraft((d) => {
              // Removed rather than set to undefined: the params are compared
              // and stored, and an explicit `easeCurve: undefined` key is a
              // different object from one that never had the field.
              const { easeCurve: _cleared, ...rest } = d;
              return value ? { ...rest, easeCurve: value as EasePresetId } : rest;
            });
          }}
        >
          <option value="">{t('motion.choreo.feelDefault', 'Feel default')}</option>
          {EASE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.label}</option>
          ))}
        </select>
      </label>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          disabled={!hasSelection}
          title={hasSelection
            ? t('motion.choreo.animateInTitle', 'Stagger the selected layers in, one after another')
            : t('motion.choreo.selectFirst', 'Select some layers first')}
          onClick={() => apply('in')}
        >
          {t('motion.choreo.animateIn', 'Animate In')}
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!hasSelection}
          title={hasSelection ? t('motion.choreo.animateOutTitle', 'Stagger the selected layers out') : t('motion.choreo.selectFirst', 'Select some layers first')}
          onClick={() => apply('out')}
        >
          {t('motion.choreo.animateOut', 'Animate Out')}
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!canStagger}
          title={canStagger
            ? t('motion.choreo.staggerTitle', 'Offset the keyframes these layers already have')
            : t('motion.choreo.staggerNeed', 'Select 2+ layers that are already animated')}
          onClick={() => apply('stagger')}
        >
          {t('motion.choreo.kindStagger', 'Stagger')}
        </button>
      </div>

      {/* The per-layer list is the plan made legible. It shows what the order
          produced and lets any single row be overruled, which is the thing no
          amount of global parameters can express: "everything like this,
          except that one arrives last". */}
      {plan.length > 0 && (
        <>
          <div className={styles.subheading}>
            {record ? t('motion.choreo.layersIn', 'Layers in this choreography') : t('motion.choreo.planned', 'Planned offsets')}
          </div>
          <ul className={styles.layerList}>
            {plan.slice(0, MAX_LAYER_ROWS).map((entry, i) => (
              <li key={entry.nodeId} className={styles.layerRow}>
                <span className={styles.layerName} title={layers[i]?.name ?? entry.nodeId}>
                  {layers[i]?.name ?? entry.nodeId}
                </span>
                <input
                  className={styles.number}
                  type="number"
                  step={1}
                  aria-label={t('motion.choreo.offsetFor', 'Offset for {name}', { name: layers[i]?.name ?? entry.nodeId })}
                  data-overridden={entry.overridden}
                  value={entry.offsetFrames}
                  onChange={(e) => setOverride(entry.nodeId, e.target.value)}
                />
                <span className={styles.unit}>fr</span>
              </li>
            ))}
          </ul>
          {plan.length > MAX_LAYER_ROWS && (
            <p className={styles.hint}>
              {plan.length - MAX_LAYER_ROWS === 1
                ? t('motion.choreo.moreOne', '{n} more layer not listed.', { n: plan.length - MAX_LAYER_ROWS })
                : t('motion.choreo.moreOther', '{n} more layers not listed.', { n: plan.length - MAX_LAYER_ROWS })}
            </p>
          )}
        </>
      )}

      {record && (
        <>
          <div className={styles.subheading}>{t('motion.choreo.last', 'Last choreography')}</div>
          <p className={styles.hint}>{describe(record)}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              title={t('motion.choreo.reapplyTitle', 'Put the previous keyframes back and write the plan above — one undo step')}
              onClick={() => { void reapplyChoreography(draft); }}
            >
              {t('motion.choreo.reapply', 'Re-apply')}
            </button>
            <button
              type="button"
              className={styles.action}
              disabled={Object.keys(draft.perLayerOverrides).length === 0}
              title={t('motion.choreo.resetTitle', 'Drop every per-layer offset and go back to the computed rhythm')}
              onClick={() => patch({ perLayerOverrides: {} })}
            >
              {t('motion.choreo.reset', 'Reset to plan')}
            </button>
            <button
              type="button"
              className={styles.action}
              title={t('motion.choreo.removeTitle', 'Restore the keyframes as they were before this choreography')}
              onClick={() => { void revertChoreography(); }}
            >
              {t('motion.choreo.remove', 'Remove')}
            </button>
          </div>
        </>
      )}

      {/* Hidden rather than disabled: with no audio in the composition there is
          nothing to beat-sync to, and a permanently dead row is noise. */}
      {hasAudio && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            disabled={!canRun('animation.animateInOnBeats')}
            title={hasSelection
              ? t('motion.choreo.onBeatTitle', 'One layer per beat of the audio layer')
              : t('motion.choreo.selectFirst', 'Select some layers first')}
            onClick={() => run('animation.animateInOnBeats')}
          >
            {t('motion.choreo.onBeat', 'In, on the beat')}
          </button>
          <button
            type="button"
            className={styles.action}
            title={t('motion.choreo.markBeatsTitle', 'Mark every beat of the audio layer on the timeline')}
            onClick={() => run('audio.markBeats')}
          >
            {t('motion.choreo.markBeats', 'Mark beats')}
          </button>
        </div>
      )}

      {canRamp && (
        <>
          <div className={styles.subheading}>{t('motion.choreo.speedRamp', 'Speed ramp')}</div>
          <div className={styles.actions}>
            {[
              { id: 'quarter', label: '25%' },
              { id: 'half', label: '50%' },
              { id: 'normal', label: '100%' },
              { id: 'freeze', label: t('motion.choreo.freeze', 'Freeze') },
            ].map((step) => (
              <button
                key={step.id}
                type="button"
                className={styles.action}
                title={t('motion.choreo.rampTitle', 'Ease to {speed} at the playhead', { speed: step.label })}
                onClick={() => run(`time.speedRamp.${step.id}`)}
              >
                {step.label}
              </button>
            ))}
          </div>
        </>
      )}

      {targets.length > 0 && (
        <>
          <div className={styles.subheading}>{t('motion.choreo.smartAnimate', 'Smart Animate')}</div>
          <p className={styles.hint}>
            {t('motion.choreo.smartAnimateHint', 'Build a transition to another board. Layers pair up by name.')}
          </p>
          <div className={styles.actions}>
            {targets.slice(0, MAX_TARGETS).map((target) => (
              <button
                key={target.id}
                type="button"
                className={styles.action}
                title={t('motion.choreo.smartAnimateTitle', 'Animate this composition into “{name}”', { name: target.name })}
                onClick={() => run(`comp.smartAnimate.${target.id}`)}
              >
                → {target.name}
              </button>
            ))}
          </div>
          {/* Never truncate silently: four buttons in a project with nine
              boards looks like the complete list unless it says otherwise. */}
          {targets.length > MAX_TARGETS && (
            <p className={styles.hint}>
              {t('motion.choreo.smartAnimateMore', '{n} more — search “Smart Animate” in the command palette.', { n: targets.length - MAX_TARGETS })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** One line saying what was applied, so "Re-apply" is not a leap of faith. */
function describe(record: ChoreographyRecord): string {
  const n = record.nodeIds.length;
  const layers = n === 1
    ? t('motion.choreo.layersOne', '{n} layer', { n })
    : t('motion.choreo.layersOther', '{n} layers', { n });
  const span = record.range
    ? ` · ${record.range.start.toFixed(2)}–${record.range.end.toFixed(2)}s`
    : '';
  return `${kindLabel(record.kind)} · ${layers} · ${orderLabel(record.params.order)}`
    + ` · ${record.params.baseOffsetFrames}fr${span}`;
}

export default ChoreographySection;
