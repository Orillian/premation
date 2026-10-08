/**
 * The document a new cloud project starts as: one empty composition, the
 * scene root, nothing animated. Shared by the Dashboard's New Project dialog
 * and Claude's `create_project` (src/hooks/useMcpFrontDesk.ts), so both make
 * exactly the same project.
 */

import type { CompositionSettings } from '@stores/compositionStore';
import { emptySceneProject } from '@core/scene/sceneProjectIO';
import type { EditorDocument } from '@core/api/cloudDocument';

export interface NewProjectSettings {
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  background: string;
  transparent?: boolean;
}

export function newProjectDocument(s: NewProjectSettings): EditorDocument {
  // The comp id and the scene root id must agree ('comp_root'), or the
  // project opens on a phantom composition.
  const initialComp: CompositionSettings = {
    id: 'comp_root',
    name: s.name,
    width: s.width,
    height: s.height,
    fps: s.fps,
    durationSeconds: s.durationSeconds,
    background: s.background,
    transparent: s.transparent ?? false,
    startFrame: 0,
  };
  const scene = emptySceneProject();
  if (scene.nodes[0]) scene.nodes[0].name = s.name;
  return {
    version: '1.1.0',
    scene,
    animation: { tracks: {}, expressions: {} },
    comps: { comp_root: initialComp },
  };
}
