import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cloudProjectsEnabled } from '@core/config/edition';

/**
 * Where `premation://connections` takes the page.
 *
 * - `dashboard`: Dashboard ▸ Connections, through the dashboard's own `?tab=`
 *   address (DashboardPage follows it on every change).
 * - `settings`: the editor's Settings ▸ AI Engine dialog, which holds the same
 *   two cards (ClaudeConnectSection + McpAppsSection), over whatever is open.
 * - `stay`: nothing beyond the focus main already gave the window.
 */
export type ConnectionsDestination = 'dashboard' | 'settings' | 'stay';

/**
 * Pick the screen for `premation://connections` from the route on show.
 *
 * The editor gets the dialog, not the dashboard. Its own "Back to Dashboard"
 * asks nothing before it leaves, and leaving cancels a pending cloud autosave
 * (CloudAutosave clears its timer on unmount) — and a read-only or over-limit
 * account never autosaves at all. A web page must not be able to do that to an
 * open project, so the project stays put and the cards come to it.
 *
 * The local edition has no dashboard, so it is always the dialog. The screens
 * that come before an account (sign-in, email check, welcome, the OAuth
 * hand-off) stay: Connections belong to the signed-in dashboard, and leaving
 * would throw away what the user had typed there.
 */
export function connectionsDestination(route: string, hasDashboard: boolean): ConnectionsDestination {
  if (route === '/editor' || route.startsWith('/editor/')) return 'settings';
  if (!hasDashboard) return 'settings';
  if (route === '/' || route === '/dashboard' || route === '/dashboard/') return 'dashboard';
  return 'stay';
}

/**
 * Bridge `premation://connections` into the app.
 *
 * Electron main has already restored and focused the window
 * (electron/deepLink.ts); this chooses the screen. Mounted once at the router
 * root beside `useOAuthDeepLink`, so the link is caught on every page. No-op on
 * the web (no shell bridge).
 */
export function useConnectionsDeepLink(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Read when the link arrives, not when the subscription was made.
  const route = useRef(pathname);
  useEffect(() => {
    route.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const deepLink = window.motionEditor?.deepLink;
    if (!deepLink) return undefined;
    return deepLink.onOpenConnections(() => {
      switch (connectionsDestination(route.current, cloudProjectsEnabled())) {
        case 'dashboard':
          navigate('/dashboard?tab=connections');
          return;
        case 'settings':
          // Loaded on demand: the dialog is the editor's, and this hook sits in
          // the lean first bundle the sign-in and dashboard pages load.
          void import('@layout/Settings/openCustomizeDialog').then((m) => m.openCustomizeDialog('ai'));
          return;
        case 'stay':
          return;
      }
    });
  }, [navigate]);
}
