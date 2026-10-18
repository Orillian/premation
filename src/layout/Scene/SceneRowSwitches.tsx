/**
 * The switches on one Layers row, in two places.
 *
 * `SceneRowAV` — eye · audio · solo · lock — is AE's A/V Features column: a
 * fixed-width gutter on the LEFT of the row (TreeView `renderGutter`), before
 * the indent, so the four switches line up down the whole list however deep a
 * layer is nested (owner redesign 2026-10-14). Each switch keeps its cell when
 * it does not apply, so the columns never shift.
 *
 * `SceneRowSwitches` — whichever of AE's layer switches the user has turned on
 * for this panel (`sceneViewStore.switches`) — stays on the right of the row.
 *
 * All of them are ANCHORED on the clicked row: they act on the whole selection
 * when the row is part of it and on that row alone otherwise, as one undo step.
 * That is the rule the context menu's labels already promised ("Unlock" locks
 * nothing else) and the rule the timeline follows.
 *
 * The switch VERBS are not here — they are engine commands built in
 * `./layerSwitchEdits` (availability and naming from `@core/scene/layerFlags`),
 * so this file is only the buttons over them and the timeline's copy of the
 * same buttons cannot mean something different.
 */

import { Icon, type IconName } from '@components/Icon';
import type { LayerFlag } from '@core/scene/layerFlags';
import {
  mirrorDescribeLayerFlag,
  mirrorLayerFlagAvailable,
  mirrorLayerFlagOn,
  mirrorLayerHasAudio,
} from '@core/mirror/layerFlagFacts';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useRetainTree } from '@hooks/useMirror';
import { anchoredLayerIds, toggleAudioAnchoredEdit, toggleLayerFlagsEdit, toggleLayerSwitchAnchored } from './layerSwitchEdits';
import styles from '@layout/EditorLayout/panels.module.css';

/** Does this layer make sound? Same test the timeline's A/V column uses (the mirror's `hasAudio`). */
function hasAudio(nodeId: string): boolean {
  return mirrorLayerHasAudio(documentMirror().layer(nodeId));
}

/** The speaker, anchored on the clicked row (`setLayerSwitches{audioEnabled}`, one entry). */
function toggleAudioAnchored(id: string): void {
  void toggleAudioAnchoredEdit(id, hasAudio);
}

export interface SceneRowAVProps {
  nodeId: string;
}

/** Eye · audio · solo · lock in fixed cells — the left gutter of a Layers row. */
export function SceneRowAV({ nodeId }: SceneRowAVProps): JSX.Element {
  useMirrorKeys([`layer:${nodeId}`]);
  const layer = documentMirror().layer(nodeId);
  // A composition ROOT is not a layer in the API (it is an item): it has no
  // eye / lock / solo, but keeps the empty cells so its name lines up with
  // the layers under it.
  if (!layer) {
    return (
      <span className={styles.avGutter} aria-hidden="true">
        <span className={styles.avCell} /><span className={styles.avCell} /><span className={styles.avCell} /><span className={styles.avCell} />
      </span>
    );
  }
  const hidden = !layer.switches.visible;
  const locked = layer.switches.locked;
  const solo = layer.switches.solo;
  const audible = mirrorLayerHasAudio(layer);
  const muted = audible && layer.switches.audioEnabled === false;

  return (
    <span className={styles.avGutter}>
      <button
        type="button"
        className={styles.avCell}
        data-kind="visible"
        data-on={hidden || undefined}
        aria-label={hidden ? 'Show layer' : 'Hide layer'}
        title={hidden ? 'Show' : 'Hide'}
        onClick={(e) => { e.stopPropagation(); void toggleLayerSwitchAnchored(nodeId, 'visible'); }}
      >
        <Icon name={hidden ? 'eye-off' : 'eye'} size="sm" />
      </button>

      {/* Layers that make no sound keep an empty cell, as AE's column does. */}
      {audible ? (
        <button
          type="button"
          className={styles.avCell}
          data-kind="audio"
          data-on={muted || undefined}
          aria-label={muted ? 'Unmute layer audio' : 'Mute layer audio'}
          aria-pressed={muted}
          title={muted ? 'Unmute audio' : 'Mute audio'}
          onClick={(e) => { e.stopPropagation(); toggleAudioAnchored(nodeId); }}
        >
          <Icon name={muted ? 'audio-off' : 'audio'} size="sm" />
        </button>
      ) : <span className={styles.avCell} aria-hidden="true" />}

      <button
        type="button"
        className={styles.avCell}
        data-kind="solo"
        data-on={solo || undefined}
        aria-label={solo ? 'Unsolo layer' : 'Solo layer'}
        title={solo ? 'Unsolo' : 'Solo'}
        onClick={(e) => { e.stopPropagation(); void toggleLayerSwitchAnchored(nodeId, 'solo'); }}
      >
        <Icon name="circle" size="sm" />
      </button>

      <button
        type="button"
        className={styles.avCell}
        data-kind="lock"
        data-on={locked || undefined}
        aria-label={locked ? 'Unlock layer' : 'Lock layer'}
        title={locked ? 'Unlock' : 'Lock'}
        onClick={(e) => { e.stopPropagation(); void toggleLayerSwitchAnchored(nodeId, 'locked'); }}
      >
        <Icon name="lock" size="sm" />
      </button>
    </span>
  );
}

export interface SceneRowSwitchesProps {
  nodeId: string;
  /** Extra AE switches to draw, in `LAYER_FLAGS` order. */
  flags: ReadonlyArray<LayerFlag>;
}

/** The optional AE switches the view menu turned on, on the right of the row. */
export function SceneRowSwitches({ nodeId, flags }: SceneRowSwitchesProps): JSX.Element | null {
  // The 3D and sunburst switches ask the layer's property tree (a Transform,
  // vector geometry), so the tree is kept loaded only while one of them is shown.
  const needsTree = flags.includes('threeD') || flags.includes('collapse');
  useRetainTree(needsTree ? nodeId : null);
  // The tree keys are the tree's SHAPE and its `layer/*` group (stroke / corner numbers) — not the whole tree,
  // which moves on every write of the layer, a viewport drag step included.
  useMirrorKeys(needsTree ? [`layer:${nodeId}`, `struct:${nodeId}`, `grp:${nodeId}|layer`] : [`layer:${nodeId}`]);
  const m = documentMirror();
  const layer = m.layer(nodeId);
  // A composition root is the document, not a layer in it: it carries none of the AE switches.
  if (!layer || flags.length === 0) return null;

  return (
    <>
      {flags.map((flag) => {
        // A switch the layer cannot carry is left out rather than drawn dead:
        // unlike the timeline, this row is not a fixed-width column that has to
        // stay aligned, so an absent switch costs nothing and a dead one lies.
        if (!mirrorLayerFlagAvailable(m, nodeId, flag)) return null;
        // The sunburst is Collapse Transformations on a comp and Continuous
        // Rasterize on a vector layer, and Quality names the position it is in
        // — so both are asked per layer rather than read off the static table.
        const face = mirrorDescribeLayerFlag(m, nodeId, flag);
        const on = mirrorLayerFlagOn(layer, flag);
        // `aria-pressed` says "this is a two-state toggle", which Quality is
        // not — it cycles three positions, and its NAME carries the state.
        const cycles = flag === 'quality';
        return (
          <button
            key={flag}
            type="button"
            className={styles.rowAction}
            data-kind={flag}
            data-on={on || undefined}
            aria-label={face.label}
            {...(cycles ? {} : { 'aria-pressed': on })}
            data-quality={cycles ? face.glyph : undefined}
            title={face.title}
            onClick={(e) => {
              e.stopPropagation();
              // One `setLayerSwitches` entry over the anchored set, with the
              // feedback the legacy toggle gave (camera tip, motion-blur comp switch).
              if (flag === 'shy') void toggleLayerSwitchAnchored(nodeId, 'shy');
              else void toggleLayerFlagsEdit(anchoredLayerIds(nodeId), flag, nodeId);
            }}
          >
            {face.glyph
              ? <span className={styles.switchGlyph}>{face.glyph}</span>
              : <Icon name={face.icon as IconName} size="sm" />}
          </button>
        );
      })}
    </>
  );
}
