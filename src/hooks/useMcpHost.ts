/**
 * Claude for Premation, editor side: while the editor is mounted it takes the
 * tool calls main relays from the MCP pipe and runs them (src/core/ai/mcp/).
 *
 * Mounted once, by the editor page. Unmounting (leaving the editor) tells main
 * the page can no longer take calls, so Claude hears "open a project" rather
 * than waiting on a page that is gone.
 *
 * Returns what the "Claude is editing" badge needs: the activity, and Stop.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { McpCallHost, type McpActivity } from '@core/ai/mcp/mcpHost';
import { editorMcpDeps } from '@core/ai/mcp/mcpDefaults';

const IDLE: McpActivity = { busy: false, tool: null, group: null };

export function useMcpHost(): { activity: McpActivity; stop: () => void } {
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.mcp : undefined;
  const host = useMemo(() => (bridge ? new McpCallHost(editorMcpDeps()) : null), [bridge]);

  useEffect(() => {
    if (!bridge || !host) return undefined;
    const offCall = bridge.onCall((call) => {
      void host.handle(call).then((result) => bridge.respond(call.id, result));
    });
    const offClients = bridge.onClients((ids) => void host.clientsChanged(ids));
    // The user taking the mouse or keyboard closes Claude's open group first,
    // so their edit is its own undo step (capture: before the editor reacts).
    const onUser = (e: Event): void => {
      if (e.isTrusted) void host.userActivity();
    };
    window.addEventListener('pointerdown', onUser, true);
    window.addEventListener('keydown', onUser, true);
    bridge.setPageReady(true);
    return () => {
      bridge.setPageReady(false);
      offCall();
      offClients();
      window.removeEventListener('pointerdown', onUser, true);
      window.removeEventListener('keydown', onUser, true);
      void host.stop();
    };
  }, [bridge, host]);

  const activity = useSyncExternalStore(
    (notify) => (host ? host.subscribe(() => notify()) : () => undefined),
    () => (host ? host.getActivity() : IDLE),
  );
  return { activity, stop: () => void host?.stop() };
}
