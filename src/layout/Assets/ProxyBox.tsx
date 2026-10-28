/**
 * The proxy indicator left of a Project panel item's name — After Effects'
 * box: filled = the proxy is in use, hollow = a proxy exists but the original
 * is in use, nothing = no proxy. Clicking it switches between the two
 * (`setProxy` enabled), one undoable edit.
 *
 * The slot is always there (an empty one for items without a proxy) so the
 * names stay in one column, as AE's do. Reads the item from the document
 * mirror, so a proxy job finishing fills the box without a second look.
 */

import { useMirrorItem } from '@hooks/useMirror';
import { usePreferenceStore } from '@stores/preferenceStore';
import { t } from '@core/i18n';
import { proxyState, toggleProxy } from './proxyCommands';
import styles from './ProxyBox.module.css';

export function ProxyBox({ itemId }: { itemId: string }): JSX.Element {
  const info = useMirrorItem(itemId);
  const useProxies = usePreferenceStore((s) => s.useProxies);
  const state = proxyState(info);
  if (state === 'none') return <span className={styles.slot} aria-hidden />;

  const base = state === 'on'
    ? t('assets.proxy.boxOn', 'Proxy in use — click to use the original')
    : t('assets.proxy.boxOff', 'Proxy available, original in use — click to use the proxy');
  const title = useProxies ? base : `${base}\n${t('assets.proxy.boxGlobalOff', 'Use Proxies is off: the viewer shows originals everywhere.')}`;

  return (
    <button
      type="button"
      className={styles.box}
      data-state={state}
      data-global-off={useProxies ? undefined : ''}
      title={title}
      aria-label={base}
      aria-pressed={state === 'on'}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        void toggleProxy(itemId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}
