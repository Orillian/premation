/**
 * The editor's Plugins panel: what is installed, enable / disable / update /
 * uninstall in place. Browsing the store and publishing live on the
 * dashboard's Plugins page (more room); a plugin installed there is usable
 * here at once (the engine rescans).
 */

import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Popover } from '@components/Popover';
import { useNativePlugins } from '@hooks/useNativePlugins';
import { useInstalledPlugins } from '@hooks/usePluginStore';
import { NativePluginsList, OpenPluginsFolderButton } from './NativePluginsList';
import { StoreMessageLine } from './StoreMessageLine';
import styles from './NativePlugins.module.css';

export function NativePluginsPanel(): JSX.Element {
  const native = useNativePlugins();
  const store = useInstalledPlugins(native.refresh);
  return (
    <div className={styles.panel}>
      {/* One row at the top (owner 2026-10-14): the folder, the about popover
          and Refresh, vertically centred. The explanation that used to sit
          above the list as a paragraph is one click away instead. */}
      <NativePluginsList
        compact
        store={store}
        native={native}
        actions={
          <>
            <OpenPluginsFolderButton />
            <Popover
              placement="bottom-start"
              trigger={
                <Button size="sm" variant="ghost" iconOnly icon={<Icon name="info" size="sm" />}>
                  About plugins
                </Button>
              }
            >
              <p className={styles.aboutText}>
                Plugins run inside the engine on this computer. Find more in the plugin store on the
                dashboard&apos;s Plugins page.
              </p>
            </Popover>
          </>
        }
      />
      <StoreMessageLine message={store.message} />
    </div>
  );
}
