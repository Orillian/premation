/**
 * The editor's real implementations of `McpHostDeps`: the in-app assistant's
 * registry, transaction and tool context, and the engine's renderer for the
 * stills and filmstrips Claude looks at.
 */

import { getAiRegistry } from '../AgentLoop';
import { beginAiTransaction } from '../aiTransaction';
import { createToolContext, sessionToolContext } from '../toolContext';
import { EngineTurnSession } from '../aiEngineSession';
import { renderFilmstripWindow } from '../filmstrip';
import { engine } from '@core/engine/engineInstance';
import { engineCompStill } from '@core/engine/engineStill';
import { useCompositionStore } from '@stores/compositionStore';
import { claudeAccess } from './mcpAccess';
import type { McpHostDeps } from './mcpHost';

/** Base64 of a blob's bytes, without a `data:` prefix. */
async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) overflows the argument limit on a large PNG.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function editorMcpDeps(): McpHostDeps {
  return {
    registry: () => getAiRegistry(),
    beginTransaction: (label) => beginAiTransaction(label),
    context: (session, signal, aliases) => sessionToolContext(session ?? new EngineTurnSession(engine(), 'ai'), signal, aliases),
    freshRun: (signal) => { createToolContext(signal); },
    renderStill: async (seconds, maxSize) => {
      const c = useCompositionStore.getState().comp();
      const lastFrame = Math.max(0, Math.round(c.durationSeconds * c.fps) - 1);
      const frame = Math.max(0, Math.min(Math.round(seconds * c.fps), lastFrame));
      const blob = await engineCompStill(c.id, frame / (c.fps || 30), maxSize);
      if (!blob) return null;
      return { mimeType: blob.type || 'image/png', data: await blobBase64(blob) };
    },
    renderStrip: async (start, end, cells) => {
      const img = await renderFilmstripWindow(start, end, cells);
      return img ? { mimeType: img.mediaType, data: img.dataBase64 } : null;
    },
    access: () => claudeAccess(),
  };
}
