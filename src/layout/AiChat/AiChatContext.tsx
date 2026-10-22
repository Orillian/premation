/**
 * AiChatContext — hoists the `useAiChat` state above the dock-panel tree.
 *
 * The AI chat lives in a left-sidebar tab, and DockPanel unmounts inactive
 * tabs. If the panel owned the hook, switching to Shapes mid-generation would
 * cancel the run and roll back a pending preview transaction. The provider
 * mounts once at the editor shell, so chat state, streaming runs, and the
 * Apply/Decline transaction all survive tab switches.
 */

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { useAiChat, type UseAiChat } from '@layout/Workspace/useAiChat';
import { isDevBuild } from '@core/config/devBuild';

const AiChatCtx = createContext<UseAiChat | null>(null);

/**
 * Dev only: a harness (the real-app UI verification over CDP) lays a partial
 * state over the live one — `window.__premationAiChatOverride = {...}` then
 * `dispatchEvent(new Event('premation:ai-chat-override'))` — so the run card,
 * the concept stage and the result card can be looked at without a model
 * call. Never read in a production build.
 */
const OVERRIDE_EVENT = 'premation:ai-chat-override';
type OverrideWindow = Window & { __premationAiChatOverride?: Partial<UseAiChat> };
function subscribeOverride(listener: () => void): () => void {
  window.addEventListener(OVERRIDE_EVENT, listener);
  return () => window.removeEventListener(OVERRIDE_EVENT, listener);
}
function readOverride(): Partial<UseAiChat> | undefined {
  return (window as OverrideWindow).__premationAiChatOverride;
}

export function AiChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const chat = useAiChat();
  const override = useSyncExternalStore(subscribeOverride, readOverride, () => undefined);
  const value = isDevBuild() && override ? { ...chat, ...override } : chat;
  return <AiChatCtx.Provider value={value}>{children}</AiChatCtx.Provider>;
}

export function useAiChatContext(): UseAiChat {
  const v = useContext(AiChatCtx);
  if (!v) throw new Error('useAiChatContext must be used inside <AiChatProvider>');
  return v;
}
