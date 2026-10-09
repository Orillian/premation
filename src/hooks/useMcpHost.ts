/**
 * Claude for Premation, editor side: while the editor is mounted it gives the
 * app's front desk (src/core/ai/mcp/frontDesk.ts) a host that runs project
 * tools with the in-app registry, plus the editor's project operations.
 *
 * Calls arrive through the front desk (mounted at the app root by
 * useMcpFrontDesk), not here: Claude is reachable on every page, and this
 * hook is what makes the editing tools available once a project is open.
 */

import { useEffect, useMemo } from 'react';
import { McpCallHost } from '@core/ai/mcp/mcpHost';
import { editorMcpDeps } from '@core/ai/mcp/mcpDefaults';
import { mcpFrontDesk, setEditorProjectOps } from '@core/ai/mcp/frontDesk';
import { useClaudeStore } from '@stores/claudeStore';
import { mcpEditorOps, mcpEditorProjectOps } from './mcpEditorOps';

export function useMcpHost(): void {
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.mcp : undefined;
  const host = useMemo(
    () => (bridge
      ? new McpCallHost({
        ...editorMcpDeps(),
        editor: mcpEditorOps,
        approve: (req) => useClaudeStore.getState().requestApproval(req),
      })
      : null),
    [bridge],
  );

  useEffect(() => {
    if (!host) return undefined;
    setEditorProjectOps(mcpEditorProjectOps);
    // The front desk mounts first (app root); it is there before any editor.
    const unregister = mcpFrontDesk()?.registerEditor(host) ?? (() => undefined);
    // The user taking the mouse or keyboard closes Claude's open group first,
    // so their edit is its own undo step (capture: before the editor reacts).
    const onUser = (e: Event): void => {
      if (e.isTrusted) void host.userActivity();
    };
    window.addEventListener('pointerdown', onUser, true);
    window.addEventListener('keydown', onUser, true);
    return () => {
      window.removeEventListener('pointerdown', onUser, true);
      window.removeEventListener('keydown', onUser, true);
      unregister();
      setEditorProjectOps(null);
      void host.stop();
    };
  }, [host]);
}
