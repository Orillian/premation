/**
 * The graph editor's LOCAL curve sampling — the segment it draws from the
 * keys themselves while a drag has outrun the engine's `sampleProperty`
 * answer (GraphEditor `localIn`).
 *
 * A one-dimensional member follows its temporal bezier. A member of a SPATIAL
 * group (Position x/y/z, Anchor Point, Point of Interest) does not: the axes
 * share one eased parameter and move along their bezier path at constant
 * speed in ARC LENGTH (After Effects; the engine's anim_sample_member_keys).
 * Sampling the axis on its own bezier-u drew a curve the engine never
 * evaluates — the value and speed graphs disagreed with the viewport the
 * moment a motion path bent. `sampleSpatialMember` (packages/animation, the
 * engine's TS twin) is the one place that timing lives; this module only
 * projects the mirror's keys into the tracks it reads.
 */

import { sampleSpatialMember, sampleTrack, type Keyframe as AnimKeyframe, type PropertyTrack } from '@motion/animation';
import { memberKeysOf, type MemberKey, type MemberKeyRead, type StoredTimeOf } from '@core/mirror/memberKeys';
import type { TrackRef } from '@core/mirror/trackIndex';

/** The member sets whose axes trace one motion path. */
const SPATIAL_MEMBERS: ReadonlyArray<ReadonlyArray<string>> = [
  ['x', 'y', 'z'],
  ['anchorX', 'anchorY', 'anchorZ'],
  ['poiX', 'poiY', 'poiZ'],
];
const SPATIAL_PATH_SUFFIXES = ['/position', '/anchor', '/anchorPoint', '/pointOfInterest', '/poi'];

/** Whether the property `ref` names is a spatial (motion-path) group. */
export function isSpatialTrackRef(ref: Pick<TrackRef, 'path' | 'members'>): boolean {
  if (ref.members.length < 2) return false;
  if (SPATIAL_MEMBERS.some((set) => ref.members.every((m) => set.includes(m)))) return true;
  return SPATIAL_PATH_SUFFIXES.some((s) => ref.path.endsWith(s));
}

/**
 * One member's keys as a `PropertyTrack` on the STORED axis (seconds, stored
 * units — what the graph plots): the member's temporal ease, the key's roving,
 * and its spatial tangents for this dimension (value-space offsets, scaled
 * like the value). The API's `legacy` spatial mode is the sampler's "stored
 * tangents as they are" (undefined).
 */
export function memberPropertyTrack(nodeId: string, member: string, ref: TrackRef, keys: ReadonlyArray<MemberKey>, dim: number): PropertyTrack {
  const keyframes: AnimKeyframe[] = keys.map((k) => {
    const si = k.key.spatialIn[dim];
    const so = k.key.spatialOut[dim];
    const mode = k.key.spatialInterp;
    return {
      ...(k.key.id ? { id: k.key.id } : {}),
      t: k.t,
      value: k.value,
      easing: k.easing,
      ...(k.bezier ? { bezier: k.bezier } : {}),
      continuous: k.continuous,
      roving: k.roving,
      ...(typeof si === 'number' ? { si: si / ref.factor } : {}),
      ...(typeof so === 'number' ? { so: so / ref.factor } : {}),
      ...(mode && mode !== 'legacy' ? { spatialInterp: mode } : {}),
    };
  });
  return { nodeId, prop: member, keyframes };
}

/**
 * The axis tracks of the spatial property `ref` belongs to, in member order
 * (an axis without keys is `undefined`), or null when the property is not
 * spatial. Read from the mirror on the same stored axis as the plotted keys.
 */
export function spatialSiblingTracks(
  m: MemberKeyRead,
  nodeId: string,
  ref: TrackRef,
  storedT: StoredTimeOf,
): Array<PropertyTrack | undefined> | null {
  if (!isSpatialTrackRef(ref)) return null;
  return ref.members.map((member, dim) => {
    const hit = memberKeysOf(m, nodeId, member, storedT);
    if (!hit || hit.keys.length === 0) return undefined;
    return memberPropertyTrack(nodeId, member, hit.ref, hit.keys, dim);
  });
}

/**
 * The member's value at stored time `t`: along the shared arc-length-timed
 * path when `siblings` is a spatial group, on its own temporal bezier
 * otherwise — exactly what the engine evaluates. `own` is the member's track
 * (the one at `siblings[axis]` for a spatial group).
 */
export function sampleMemberLocal(
  own: PropertyTrack,
  siblings: ReadonlyArray<PropertyTrack | undefined> | null,
  axis: number,
  t: number,
): number | undefined {
  if (siblings && siblings[axis]) return sampleSpatialMember(siblings, axis, t);
  return sampleTrack(own, t);
}
