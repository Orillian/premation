/**
 * Claude for Premation, as the UI sees it — one store so the title-bar
 * indicator, its activity panel, the editor badge and Settings never disagree.
 *
 *   setup      main's ClaudeSetupStatus: on/off, installed in Claude, which
 *              clients are connected right now
 *   desk       the front desk's activity and feed (src/core/ai/mcp/frontDesk.ts)
 *   approvals  requests waiting for the user's Allow / Deny (import, export)
 *
 * Written by src/hooks/useMcpFrontDesk.ts; nothing else writes it.
 */

import { create } from 'zustand';
import type { ClaudeSetupStatus } from '@app-types/motionEditor';
import type { FrontDeskState } from '@core/ai/mcp/frontDesk';
import type { ApprovalRequest } from '@core/ai/mcp/mcpHost';

/** An approval the user has not answered; it is denied after this long. */
export const APPROVAL_TIMEOUT_MS = 2 * 60_000;

export interface PendingApproval extends ApprovalRequest {
  id: number;
  at: number;
}

/** The one-word state the indicator shows. */
export type ClaudeMode = 'off' | 'setup' | 'ready' | 'connected' | 'working' | 'needs-you';

interface ClaudeState {
  setup: ClaudeSetupStatus | null;
  desk: FrontDeskState;
  approvals: PendingApproval[];
  /** The activity panel is open (the indicator's popover). */
  panelOpen: boolean;
  setSetup(setup: ClaudeSetupStatus): void;
  setDesk(desk: FrontDeskState): void;
  /** Ask the user; resolves true on Allow, false on Deny or timeout. */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  answerApproval(id: number, allow: boolean): void;
  setPanelOpen(open: boolean): void;
}

const resolvers = new Map<number, (allow: boolean) => void>();
let nextApprovalId = 1;

export const useClaudeStore = create<ClaudeState>((set, get) => ({
  setup: null,
  desk: { busy: false, tool: null, group: null, feed: [] },
  approvals: [],
  panelOpen: false,
  setSetup: (setup) => set({ setup }),
  setDesk: (desk) => set({ desk }),
  requestApproval: (req) => new Promise<boolean>((resolve) => {
    const id = nextApprovalId++;
    resolvers.set(id, resolve);
    set({ approvals: [...get().approvals, { ...req, id, at: Date.now() }], panelOpen: true });
    setTimeout(() => get().answerApproval(id, false), APPROVAL_TIMEOUT_MS);
  }),
  answerApproval: (id, allow) => {
    const resolve = resolvers.get(id);
    if (!resolve) return;
    resolvers.delete(id);
    set({ approvals: get().approvals.filter((a) => a.id !== id) });
    resolve(allow);
  },
  setPanelOpen: (panelOpen) => set({ panelOpen }),
}));

/** Derive the indicator's state (pure; tested). */
export function claudeMode(setup: ClaudeSetupStatus | null, desk: FrontDeskState, approvals: number): ClaudeMode {
  if (approvals > 0) return 'needs-you';
  if (!setup || !setup.bridge.enabled) return 'off';
  if (desk.busy || desk.group) return 'working';
  if (setup.bridge.clients.length > 0) return 'connected';
  const otherApp = (setup.apps ?? []).some((a) => a.state === 'ok');
  if (!setup.configured && setup.claude.extension === 'absent' && !otherApp) return 'setup';
  return 'ready';
}
