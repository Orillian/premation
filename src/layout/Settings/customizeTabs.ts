/**
 * The Customize dialog's tab list — a plain function kept OUT of the
 * component module so that module stays Fast-Refresh-able (see the note at
 * the end of CustomizeDialog.tsx).
 */
import type { IconName } from '@components/Icon';
import { aiEnabled } from '@core/config/edition';
import { t } from '@core/i18n';

export type Tab = 'shortcuts' | 'tabs' | 'appearance' | 'audio' | 'files' | 'models' | 'ai';

export function tabsForEdition(): ReadonlyArray<{ id: Tab; label: string; icon: IconName }> {
  return [
    { id: 'shortcuts', label: t('settings.customize.tab.shortcuts', 'Shortcuts'), icon: 'keyboard' as IconName },
    { id: 'tabs', label: t('settings.customize.tab.workspaces', 'Workspaces'), icon: 'layout' as IconName },
    { id: 'appearance', label: t('settings.customize.tab.appearance', 'Appearance'), icon: 'palette' as IconName },
    // AE's Preferences ▸ Audio Hardware. Its own pane rather than a section of
    // Appearance: nothing in it is about how the app looks, and a monitoring
    // device buried under "Appearance" is a device nobody finds.
    { id: 'audio', label: t('settings.customize.tab.audio', 'Audio'), icon: 'audio' as IconName },
    { id: 'files', label: t('settings.customize.tab.files', 'Files'), icon: 'folder' as IconName },
    // The ML models the engine runs (electron/models.json): built in, installed, or fetched on first use.
    { id: 'models', label: t('settings.customize.tab.models', 'Models'), icon: 'brain' as IconName },
    ...(aiEnabled() ? [{ id: 'ai' as const, label: t('settings.customize.tab.ai', 'AI Engine'), icon: 'ai' as IconName }] : []),
  ];
}
