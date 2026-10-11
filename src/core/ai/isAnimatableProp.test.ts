/**
 * The animatable-prop gate, checked against the paths the ENGINE actually
 * writes — because the one divergence it had was exactly the silent kind:
 * `pathOp.` (camelCase, a prefix no real track ever carried) while
 * `pathOpPropPath` mints `pathop.`, so the AI was told by add_path_operator's
 * own reply to keyframe a path the gate then refused.
 */

import { isAnimatableProp } from './toolContext';
import { pathOpPropPath, newPathOpId } from '@core/scene/pathOps';
import { polystarPropPath } from '@core/scene/polystar';
import { FILL_GRADIENT_TRACKS } from '@core/paint/gradientPaintTracks';
import { PAINT_OPTION_KEYS, paintColorPath, paintPathProp, paintPropPath } from '@core/paint/paintProps';

describe('isAnimatableProp', () => {
  it('REGRESSION: accepts the exact path pathOpPropPath mints', () => {
    expect(isAnimatableProp(pathOpPropPath(newPathOpId(), 'amount'))).toBe(true);
  });

  it('accepts the other engine-minted prefixes', () => {
    expect(isAnimatableProp('effect.fx1.amount')).toBe(true);
    expect(isAnimatableProp('ta.0.offset')).toBe(true);
  });

  it('accepts what create_layer / create_gradient now build: polystar params and gradient-fill geometry', () => {
    // Both are sampled by name in buildSnapshot (resolvePolystar, fillPaint
    // resolution) — a tool that creates them and a gate that refuses to
    // animate them would be half a feature.
    expect(isAnimatableProp(polystarPropPath('points'))).toBe(true);
    expect(isAnimatableProp(FILL_GRADIENT_TRACKS.radius)).toBe(true);
    expect(isAnimatableProp(FILL_GRADIENT_TRACKS.centerX)).toBe(true);
    expect(isAnimatableProp(FILL_GRADIENT_TRACKS.angle)).toBe(true);
  });

  it('accepts the paint stroke tracks paint_strokes tells the model to keyframe, not the Path', () => {
    // paint_strokes' reply said "animate paint.<strokeId>.<param>" while this
    // gate had no `paint.` prefix: every ink write-on set_keyframes authored
    // was refused as "not animatable" (docs/PROGRAM_3D_PERF_UX.md I1).
    for (const key of PAINT_OPTION_KEYS) expect(isAnimatableProp(paintPropPath('ps_1', key))).toBe(true);
    expect(isAnimatableProp(paintPropPath('ps_1', 'positionX'))).toBe(true);
    expect(isAnimatableProp(`${paintColorPath('ps_1')}_r`)).toBe(true);
    // The Path is a `points` data track, like a puppet pin's Position.
    expect(isAnimatableProp(paintPathProp('ps_1'))).toBe(false);
    expect(isAnimatableProp('paint.ps_1.nonsense')).toBe(false);
    expect(isAnimatableProp('paint.ps_1')).toBe(false);
  });

  it('still rejects arbitrary names', () => {
    expect(isAnimatableProp('definitelyNotAProp')).toBe(false);
  });
});
