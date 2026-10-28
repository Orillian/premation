/**
 * The Project panel item menu's proxy rows — After Effects' Create Proxy ▸
 * Movie… and Set Proxy ▸ None, on the rows that were right-clicked (the same
 * actions as File ▸ Create Proxy / Set Proxy, which act on the panel selection).
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import { documentMirror } from '@stores/documentMirror';
import { t } from '@core/i18n';
import { createProxies, createProxyTargets, proxyNoneTargets, setProxyNone } from './proxyCommands';

export function proxyMenuItems(ids: readonly string[]): ContextMenuItem[] {
  const infos = ids.map((id) => documentMirror().item(id));
  const canCreate = createProxyTargets(infos).length > 0;
  const canClear = proxyNoneTargets(infos).length > 0;
  return [
    {
      id: 'create-proxy',
      label: t('assets.proxy.menuCreate', 'Create Proxy'),
      children: [
        { id: 'create-proxy-movie', label: t('assets.proxy.menuMovie', 'Movie…'), disabled: !canCreate, onSelect: () => { void createProxies(ids); } },
      ],
    },
    {
      id: 'set-proxy',
      label: t('assets.proxy.menuSet', 'Set Proxy'),
      children: [
        { id: 'set-proxy-none', label: t('assets.proxy.menuNone', 'None'), disabled: !canClear, onSelect: () => { void setProxyNone(ids); } },
      ],
    },
  ];
}
