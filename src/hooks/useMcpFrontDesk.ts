/**
 * Claude for Premation at the APP root: mounted once in AppLayout, so Claude
 * is reachable on every page — the home screen as much as the editor
 * (docs/MCP_PLAN.md §13).
 *
 * It creates the single `McpFrontDesk`, routes every call main relays from the
 * MCP pipe to it, and keeps `claudeStore` current (setup status from main, the
 * desk's activity and feed). The project-level operations it hands the desk
 * (list / create / open) are the Dashboard's and the start screen's own.
 */

import { useEffect } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { api, isAuthenticated } from '@core/api/client';
import { cloudProjectsEnabled, getEdition } from '@core/config/edition';
import { getProjectManager, getRecentProjects } from '@core/services/coreServices';
import { newProjectDocument } from '@core/project/newProjectDocument';
import { claudeAccess } from '@core/ai/mcp/mcpAccess';
import {
  McpFrontDesk,
  editorProjectOps,
  mcpFrontDesk,
  setMcpFrontDesk,
  type FrontDeskDeps,
} from '@core/ai/mcp/frontDesk';
import { documentMirror, hasDocumentMirror } from '@stores/documentMirror';
import { useProjectLibrary } from '@stores/projectLibraryStore';
import { useClaudeStore } from '@stores/claudeStore';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The current project, if the editor has one loaded. */
function currentProject(): { id: string; name: string; path: string | null } | null {
  try {
    return getProjectManager().getState().current;
  } catch {
    return null;
  }
}

function compsSummary(): unknown[] {
  if (!hasDocumentMirror()) return [];
  const m = documentMirror();
  return m.compIds.map((id) => {
    const s = m.comp(id)?.settings as Record<string, unknown> | undefined;
    return { id, name: s?.name ?? id };
  });
}

/** Navigate to the editor and wait for it to register its host. */
async function toEditor(navigate: NavigateFunction, route: string): Promise<boolean> {
  navigate(route);
  for (let i = 0; i < 200; i++) {
    if (mcpFrontDesk()?.hasEditor() && editorProjectOps()) return true;
    await wait(100);
  }
  return false;
}

function deskDeps(navigate: NavigateFunction): FrontDeskDeps {
  return {
    access: () => claudeAccess(),
    projectLoaded: (expect) => {
      const p = currentProject();
      if (!p || !hasDocumentMirror()) return false;
      return !expect || p.id === expect || p.path === expect;
    },
    appState: async () => {
      const route = (window.location.hash.replace(/^#/, '').split('?')[0] ?? '') || '/';
      const inEditor = route.startsWith('/editor');
      const p = inEditor && mcpFrontDesk()?.hasEditor() ? currentProject() : null;
      return {
        screen: inEditor ? 'editor' : route.startsWith('/dashboard') ? 'home' : route,
        project: p ? { id: p.id, name: p.name } : null,
        compositions: p ? compsSummary() : [],
        edition: getEdition(),
        signedIn: cloudProjectsEnabled() ? isAuthenticated() : null,
        next: p ? 'A project is open: describe_scene / list_compositions, then edit.' : 'No project open: create_project or open_project.',
      };
    },
    listProjects: async ({ query, limit }) => {
      try {
        if (cloudProjectsEnabled()) {
          const page = await api.listProjects({ limit, ...(query ? { q: query } : {}) });
          return page.items.map((p) => ({
            id: p.id,
            name: p.name,
            size: `${p.width}×${p.height}`,
            fps: p.fps,
            durationSeconds: p.durationSeconds,
            layers: p.layerCount,
            updatedAt: p.updatedAt,
          }));
        }
        const q = query?.toLowerCase();
        return getRecentProjects().list()
          .filter((r) => r.path && (!q || r.name.toLowerCase().includes(q)))
          .slice(0, limit)
          .map((r) => ({ id: r.path, name: r.name, openedAt: new Date(r.openedAt).toISOString() }));
      } catch (err) {
        return { error: `Could not list projects: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    createProject: async (req) => {
      try {
        if (cloudProjectsEnabled()) {
          const record = await useProjectLibrary.getState().create(req.name, newProjectDocument(req));
          if (!record?.id) return { error: 'The server did not return a project id.' };
          navigate(`/editor/${record.id}`);
          return { name: req.name, expect: record.id };
        }
        if (!(await toEditor(navigate, '/editor'))) return { error: 'The Premation editor did not open.' };
        const r = await editorProjectOps()!.newProject(req);
        return 'error' in r ? r : { name: req.name, expect: r.id };
      } catch (err) {
        return { error: `Could not create the project: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    openProject: async (id) => {
      if (cloudProjectsEnabled()) {
        navigate(`/editor/${encodeURIComponent(id)}`);
        return { name: id, expect: id };
      }
      if (!(await toEditor(navigate, '/editor'))) return { error: 'The Premation editor did not open.' };
      const r = await editorProjectOps()!.openPath(id);
      return 'error' in r ? r : { name: r.name, expect: r.id };
    },
  };
}

export function useMcpFrontDesk(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.motionEditor?.mcp : undefined;
    if (!bridge) return undefined;
    const desk = new McpFrontDesk(deskDeps(navigate));
    setMcpFrontDesk(desk);
    const store = useClaudeStore.getState();

    const offDesk = desk.subscribe((s) => store.setDesk(s));
    const offCall = bridge.onCall((call) => {
      void desk.handle(call).then((result) => bridge.respond(call.id, result));
    });
    const offClients = bridge.onClients((ids) => desk.clientsChanged(ids));
    // Claude can reach Premation on every page now; the front desk answers
    // until a project is open. Re-asserted whenever main reports otherwise:
    // a reload during start-up (Vite re-optimising, a redirect) can land
    // main's "page gone" after this page's "ready", and nothing else would
    // correct it until the next navigation.
    const onSetup = (s: Parameters<typeof store.setSetup>[0]): void => {
      store.setSetup(s);
      if (!s.bridge.pageReady) bridge.setPageReady(true);
    };
    const offStatus = bridge.onStatus(onSetup);
    bridge.setPageReady(true);
    void bridge.getStatus().then(onSetup).catch(() => undefined);

    return () => {
      bridge.setPageReady(false);
      offDesk();
      offCall();
      offClients();
      offStatus();
      void desk.stop();
      if (mcpFrontDesk() === desk) setMcpFrontDesk(null);
    };
    // `navigate` is stable for the router's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
