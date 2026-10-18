import { useEffect, useSyncExternalStore } from 'react';
import { useParams } from 'react-router-dom';
import { useLayoutStore } from '@stores/layoutStore';
import { panelDef } from '@layout/EditorLayout/panelDefs';
import { getAllPanelRenderers } from '@layout/EditorLayout/DemoPanels';
import { WorkspaceViewport } from '@layout/Workspace';
import { PopoutTimeline } from '@layout/BottomTimeline/PopoutTimeline';
import { PresentationModeWindow } from '@layout/Presentation/PresentationModeWindow';

import { pluginToolPanelRenderer } from '@layout/Plugins/PluginToolPanel';
import { AiChatProvider } from '@layout/AiChat/AiChatContext';
import { panelIdFromPopoutSegment } from '@core/layout/popoutPath';
import { pluginContribRevision, pluginPanel, subscribePluginContrib } from '@core/nativePlugins/pluginContrib';
import { Providers } from '../providers/Providers';

function PopoutContent(): JSX.Element {
  // The segment is encoded (a plugin panel's id holds a '/': core/layout/popoutPath.ts).
  const { panelId: segment } = useParams<{ panelId: string }>();
  const panelId = segment ? panelIdFromPopoutSegment(segment) : undefined;
  const panels = useLayoutStore((s) => s.panels);
  const panel = panelId ? panels[panelId] : undefined;
  // A plugin panel is named by its manifest, which arrives with the plugin list.
  const contrib = useSyncExternalStore(subscribePluginContrib, pluginContribRevision, pluginContribRevision);

  useEffect(() => {
    const titleMap: Record<string, string> = {
      viewport: 'Viewport Preview — Premation',
      timeline: 'Timeline — Premation',
      presentation: 'Presentation Mode — Premation',
    };
    // `panel` comes from the layout store, which is EMPTY in a pop-out window
    // (registerPanel only runs in the editor shell), so this always fell through
    // to the generic "Detached Window". The shared registry knows the real name.
    const name = panel?.title ?? panelDef(panelId ?? '')?.title ?? pluginPanel(panelId ?? '')?.panel.name;
    document.title = titleMap[panelId ?? ''] ?? (name ? `${name} — Premation` : 'Detached Window');

    // The document reaches this window from the engine (windowSync: the page
    // replica refreshes from `exportDocument`, the mirror follows the engine).
  }, [panelId, panel, contrib]);

  if (!panelId) {
    return <div style={{ color: '#fff', padding: 20 }}>No panel ID specified.</div>;
  }

  // Handle special full-screen popout types: Viewport, Timeline, Presentation Mode
  if (panelId === 'viewport') {
    return (
      <div style={{ width: '100%', height: '100%', background: '#121213', overflow: 'hidden' }}>
        <WorkspaceViewport />
      </div>
    );
  }

  if (panelId === 'timeline') {
    return (
      <div style={{ width: '100%', height: '100%', background: '#121213', overflow: 'hidden' }}>
        <PopoutTimeline />
      </div>
    );
  }

  if (panelId === 'presentation') {
    return <PresentationModeWindow />;
  }

  const renderers = getAllPanelRenderers();
  // P7d: a plugin panel resolves by its id even before this window knows the plugin list.
  const renderContent = renderers[panelId] ?? pluginToolPanelRenderer(panelId);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--color-surface-1, #121213)',
        color: 'var(--color-text-primary)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* No header row: the window's title bar names the panel (TitleBar). */}
      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {/* The AI panel reads its chat state from <AiChatProvider>, which only
            EditorShell mounts — a popped-out AI panel needs its own. */}
        {renderContent
          ? (panelId === 'ai' ? <AiChatProvider>{renderContent()}</AiChatProvider> : renderContent())
          : <div style={{ padding: 20 }}>Panel Content ({panelId})</div>}
      </div>
    </div>
  );
}

export function PopoutRoute(): JSX.Element {
  return (
    <Providers>
      <PopoutContent />
    </Providers>
  );
}
