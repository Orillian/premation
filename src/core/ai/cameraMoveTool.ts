/**
 * `add_camera_move` — every camera move the editor has, for the AI / MCP
 * (camera program R5, 2026-10-14).
 *
 * The tool used to know two moves (push in, pull out) while the technique
 * library had fifteen camera techniques the model could only reach through
 * `apply_technique` with hand-picked role targets, and the camera program's
 * own verbs (rigs, fly-to, follow path, shake) were UI-only. One `kind` now
 * reaches each of them:
 *
 *   push_in / pull_out   the classic recipe (recipes.ts `recipeCameraMove`)
 *   <technique>          `camera.<kind>` through `applyTechnique` — the same
 *                        emitter the MCP `apply_technique` runs — with the
 *                        role targets inferred from the comp's layers when the
 *                        model gives none (a technique stages its own depth)
 *   shake                the camera's procedural Shake props (R1)
 *   rig                  `buildCameraRig` (R2) through the turn's session
 *   fly_to               `planFlyTo` (R4), sent through the turn's session
 *   follow_path          `planFollowPath` (R3a), sent through the turn's session
 *
 * The verbs write through `ctx.engine.apply` — the AI turn is already ONE undo
 * entry, so they must not open gestures of their own — and every reply says
 * what the scene now holds (the tool-truthfulness rule).
 */

import type { ToolContext, ToolRegistry, ToolResult } from '@motion/ai-tools';
import { CAMERA_MOVE_TECHNIQUES, CAMERA_MOVE_VERBS } from '@motion/ai-tools';
import { TECHNIQUES, type AnimatableRole } from '@motion/technique-library';
import type { Command, CommandResult } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { propRefForTrack } from '@core/engine/propRefs';
import { buildCameraRig, type CameraRigKind } from '@core/scene/cameraRig';
import { planFlyTo } from '@core/scene/cameraFlyTo';
import { planFollowPath } from '@core/scene/cameraFollowPath';
import { applyTechnique } from './mcp/designTools';
import { recipeCameraMove } from './recipes';
import { refreshAfterLegacy } from './toolContext';

const ok = (content: string, data?: unknown): ToolResult => ({ ok: true, content, data });
const fail = (content: string): ToolResult => ({ ok: false, content });

/** The camera's procedural Shake (camera program R1): the Transform props the engine evaluates. */
export const SHAKE_PROPS = ['shakeAmount', 'shakeRotation', 'shakeFrequency', 'shakeSeed'] as const;

/** One line per kind — what list_capabilities('camera') reports. */
export function cameraMoveCapabilities(): Array<{ kind: string; does: string }> {
  const byId = new Map(TECHNIQUES.map((t) => [t.id, t]));
  return [
    { kind: 'push_in', does: 'Slow dolly in with a gentle orbit across the comp (creates a camera when none).' },
    { kind: 'pull_out', does: 'Slow dolly out with a gentle orbit across the comp.' },
    ...CAMERA_MOVE_TECHNIQUES.map((k) => {
      const t = byId.get(`camera.${k}`);
      return { kind: k, does: t ? `${t.displayName}: ${t.intent}` : `camera.${k}` };
    }),
    { kind: 'shake', does: 'Procedural camera shake: shakeAmount px, shakeRotation °, shakeFrequency Hz, shakeSeed (live, seeded, rampable).' },
    { kind: 'rig', does: 'A crane / dolly / orbit rig of parented 3D nulls above the camera; animate its nulls afterwards.' },
    { kind: 'fly_to', does: 'Key the camera to frame each of `layers` in order: travelSec then holdSec on each.' },
    { kind: 'follow_path', does: 'pathLayer\'s path (shape or first mask) becomes the camera\'s Position keys, roving.' },
  ];
}

/** A layer's role for a camera technique, by what it is (when the model names none). */
function roleOf(kind: string, firstText: boolean): AnimatableRole | null {
  switch (kind) {
    case 'text': return firstText ? 'headline' : 'subhead';
    case 'image':
    case 'video': return 'media';
    case 'solid': return 'background';
    case 'shape':
    case 'svg': return 'mark';
    default: return null;
  }
}

/** Role targets for technique `id` from the comp's content layers (only the roles it animates). */
async function inferTargets(ctx: ToolContext, roles: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  let sawText = false;
  for (const n of await ctx.scene.all()) {
    const role = roleOf(n.kind, n.kind === 'text' && !sawText);
    if (n.kind === 'text') sawText = true;
    if (!role || !roles.includes(role)) continue;
    (out[role] ??= []).push(n.id);
  }
  return out;
}

/** The camera a verb drives: the one named, else the comp's first. */
async function cameraFor(ctx: ToolContext, id: unknown): Promise<string | null> {
  if (typeof id === 'string' && id !== '') {
    const real = ctx.aliases.get(id) ?? id;
    const n = await ctx.scene.get(real);
    return n?.kind === 'camera' ? real : null;
  }
  return (await ctx.scene.all()).find((n) => n.kind === 'camera')?.id ?? null;
}

/** Commands through the turn's session (one undo entry with the rest of the turn); null when refused. */
function sessionExec(ctx: ToolContext): (cmds: Command[]) => Promise<readonly CommandResult[] | null> {
  return async (cmds) => {
    try {
      return await ctx.engine.apply(cmds);
    } catch {
      return null;
    }
  };
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

interface CameraMoveInput {
  kind?: string;
  style?: string;
  cameraId?: string;
  startSec?: number;
  durationSec?: number;
  targets?: Record<string, unknown>;
  params?: Record<string, unknown>;
  seed?: number;
  shakeAmount?: number;
  shakeRotation?: number;
  shakeFrequency?: number;
  shakeSeed?: number;
  rig?: string;
  layers?: unknown[];
  travelSec?: number;
  holdSec?: number;
  pathLayer?: string;
}

/** The `add_camera_move` handler. `registry` runs a technique's emitted tool calls. */
export function makeAddCameraMove(registry: () => Pick<ToolRegistry, 'execute'>): (input: unknown, ctx: ToolContext) => Promise<ToolResult> {
  return async (input, ctx) => {
    const i = input as CameraMoveInput;
    const kind = i.kind ?? 'push_in';

    if (kind === 'push_in' || kind === 'pull_out') {
      const move = await recipeCameraMove(ctx, { kind, durationSec: i.durationSec });
      refreshAfterLegacy(ctx);
      // The camera is named on its own, not counted: it is what moves, not one
      // of the layers the move is across.
      return ok(
        `Added a slow ${kind} across ${move.layers} layer(s) (now 3D), driven by ` +
          `${move.createdCamera ? 'a new' : 'the existing'} 3D camera (id ${move.cameraId}).`,
        { cameraId: move.cameraId },
      );
    }

    if ((CAMERA_MOVE_TECHNIQUES as readonly string[]).includes(kind)) {
      const id = `camera.${kind}`;
      const t = TECHNIQUES.find((x) => x.id === id);
      if (!t) return fail(`No camera technique '${id}'.`);
      const targets = i.targets && Object.keys(i.targets).length > 0 ? i.targets : await inferTargets(ctx, t.roles);
      const r = await applyTechnique(
        { id, targets, startSec: num(i.startSec, 0), ...(i.durationSec !== undefined ? { durationSec: i.durationSec } : {}), ...(i.params ? { params: i.params } : {}), ...(i.seed !== undefined ? { seed: i.seed } : {}) },
        null,
        registry(),
        ctx,
      );
      refreshAfterLegacy(ctx);
      return r.ok ? ok(r.text, { technique: id }) : fail(r.text);
    }

    if (!(CAMERA_MOVE_VERBS as readonly string[]).includes(kind)) return fail(`Unknown camera move '${kind}'. Call list_capabilities('camera').`);
    const cam = await cameraFor(ctx, i.cameraId);
    if (!cam) {
      return fail(i.cameraId
        ? `'${i.cameraId}' is not a camera layer. Use a camera id from describe_scene.`
        : 'This composition has no camera. Create one (create_layer kind "camera") or use kind push_in, which makes one.');
    }
    // The verbs read the camera off the document mirror: let it catch up with this turn's writes.
    await documentMirror().whenIdle();
    const start = num(i.startSec, 0);

    if (kind === 'shake') {
      const values: Record<string, number> = {
        shakeAmount: Math.max(0, num(i.shakeAmount, 12)),
        ...(i.shakeRotation !== undefined ? { shakeRotation: Math.max(0, i.shakeRotation) } : {}),
        ...(i.shakeFrequency !== undefined ? { shakeFrequency: Math.max(0.01, i.shakeFrequency) } : {}),
        ...(i.shakeSeed !== undefined ? { shakeSeed: Math.round(i.shakeSeed) } : {}),
      };
      // An engine without procedural shake has no such props: say so and write nothing.
      await documentMirror().loadTree(cam);
      const missing = Object.keys(values).filter((prop) => !propRefForTrack(cam, prop));
      if (missing.length > 0) return fail(`This engine has no camera ${missing.join(', ')} — camera shake is not available.`);
      for (const [prop, v] of Object.entries(values)) {
        if (!(await ctx.scene.setProp(cam, prop, v))) return fail(`Could not set the camera's ${prop}.`);
      }
      return ok(
        values.shakeAmount === 0
          ? `Turned camera shake off on ${cam}.`
          : `Camera ${cam} now shakes: ${Object.entries(values).map(([k, v]) => `${k} ${v}`).join(', ')}. Key shakeAmount with set_keyframes to ramp it.`,
        { cameraId: cam, ...values },
      );
    }

    if (kind === 'rig') {
      const rigKind = (i.rig ?? 'dolly') as CameraRigKind;
      if (!['crane', 'dolly', 'orbit'].includes(rigKind)) return fail(`rig must be crane, dolly or orbit — not '${i.rig}'.`);
      const ids = await buildCameraRig(cam, rigKind, start, sessionExec(ctx));
      if (!ids) return fail(`Could not build the ${rigKind} rig on ${cam}.`);
      const names = ids.map((id) => `${documentMirror().layer(id)?.name ?? id} (${id})`);
      return ok(`Built a ${rigKind} rig above camera ${cam}: ${names.join(' → ')}. The shot did not move; animate the nulls' position / rotation with set_keyframes.`, { cameraId: cam, nulls: ids });
    }

    if (kind === 'fly_to') {
      const layers = (i.layers ?? []).filter((x): x is string => typeof x === 'string').map((x) => ctx.aliases.get(x) ?? x);
      for (const id of layers) if (!(await ctx.scene.has(id))) return fail(`No layer '${id}'. Use ids from describe_scene.`);
      const plan = await planFlyTo(cam, layers, start, { travel: num(i.travelSec, 1), hold: num(i.holdSec, 1) });
      if (!plan.ok) return fail(plan.reason);
      if (!(await sessionExec(ctx)([plan.command]))) return fail('The engine refused the camera keys.');
      return ok(`Camera ${cam} flies to ${layers.length} layer(s) from ${start}s, framing each in turn; the move ends at ${Math.round(plan.end * 100) / 100}s (${plan.keys} keys).`, { cameraId: cam, end: plan.end });
    }

    // follow_path
    const pathLayer = typeof i.pathLayer === 'string' ? ctx.aliases.get(i.pathLayer) ?? i.pathLayer : '';
    if (!pathLayer || !(await ctx.scene.has(pathLayer))) return fail('follow_path needs pathLayer: a shape layer (or a layer with a mask) from describe_scene.');
    const comp = await ctx.comp.get();
    const duration = num(i.durationSec, Math.max(0.1, comp.durationSeconds - start));
    const plan = await planFollowPath(cam, pathLayer, start, start + duration);
    if (!plan.ok) return fail(plan.reason);
    if (!(await sessionExec(ctx)([plan.command]))) return fail('The engine refused the camera keys.');
    return ok(`Camera ${cam} follows the path of ${pathLayer} from ${start}s to ${start + duration}s (${plan.keys} roving Position keys).`, { cameraId: cam });
  };
}
