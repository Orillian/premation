/** A plugin's icon from the store, or its initial when it has none (or the image fails). */

import { useState } from 'react';
import { storeMediaUrl, type StorePluginSummary } from '@core/api/client';
import styles from './NativePlugins.module.css';

export function PluginIcon({ plugin, size = 40 }: { plugin: Pick<StorePluginSummary, 'name' | 'iconUrl'>; size?: number }): JSX.Element {
  const [broken, setBroken] = useState(false);
  const src = broken ? null : storeMediaUrl(plugin.iconUrl);
  return (
    <span className={styles.pluginIcon} style={{ width: size, height: size }} aria-hidden="true">
      {src ? (
        <img src={src} alt="" width={size} height={size} onError={() => setBroken(true)} />
      ) : (
        <span className={styles.pluginIconInitial} style={{ fontSize: Math.round(size * 0.42) }}>
          {(plugin.name.trim()[0] ?? '?').toUpperCase()}
        </span>
      )}
    </span>
  );
}
