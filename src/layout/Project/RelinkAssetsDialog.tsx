/**
 * Relink missing assets after opening a portable `.motion` file.
 *
 * Local absolute paths and dead blob URLs do not travel. Rather than open a
 * project with silent blank layers, we ask the user to pick replacements.
 */

import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { EmptyState } from '@components/EmptyState';
import { openModal } from '@stores/modalStore';
import { importBrowserFilesEdit } from '@layout/Assets/assetEdits';
import { edit } from '@core/engine/uiEdits';
import type { MissingAssetRef } from '@core/project/missingAssets';
import { useState } from 'react';
import { t } from '@core/i18n';

/** Exported so the relinked-everything state can be asserted directly. */
/**
 * Relink a layer whose source is missing to a picked file: the file is imported
 * (its own entry), then the layer's source is swapped to it, keeping its size
 * (`replaceLayerSource`, "Relink"). The layer's missing ref often has no
 * footage item behind it (a dead blob URL), so relinking the ITEM would not
 * reach it. Resolves to whether the layer now shows the file.
 */
export async function relinkToFileEdit(nodeId: string, file: File): Promise<boolean> {
  const { imported: [asset] } = await importBrowserFilesEdit([{ file }]);
  if (!asset) return false;
  const res = await edit('Relink', { type: 'replaceLayerSource', layer: nodeId, source: asset.id, keepSize: true });
  return res.ok;
}

export function RelinkBody({
  missing,
  close,
}: {
  missing: MissingAssetRef[];
  close: () => void;
}): JSX.Element {
  const [left, setLeft] = useState(missing);

  const pick = (ref: MissingAssetRef): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*,audio/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void relinkToFileEdit(ref.nodeId, file).then((ok) => {
        if (ok) setLeft((prev) => prev.filter((m) => m.nodeId !== ref.nodeId));
      });
    });
    input.click();
  };

  if (left.length === 0) {
    return (
      <EmptyState
        compact
        icon="success"
        title={t('project.relink.doneTitle', 'Nothing left to relink')}
        message={t('project.relink.doneMessage', 'Every missing asset now points at a file on this machine.')}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
        {t(
          'project.relink.intro',
          'This project references files that are not in the package. Relink them to keep the animation; skipping leaves those layers as Media Offline (colour bars). Export will refuse until they are relinked or removed.',
        )}
      </p>
      {left.map((m) => (
        <div
          key={m.nodeId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-control)',
            background: 'var(--color-surface-2)',
          }}
        >
          <Icon name="image" size="sm" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{m.nodeName}</div>
            <div
              style={{
                fontSize: 'var(--font-size-micro)',
                color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-family-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={m.src}
            >
              {m.src || t('project.relink.emptyPath', '(empty)')}
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => pick(m)}>
            {t('project.relink.relink', 'Relink…')}
          </Button>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={close}>
          {left.length ? t('project.relink.skip', 'Skip for now') : t('project.relink.done', 'Done')}
        </Button>
      </div>
    </div>
  );
}

export function offerRelink(missing: MissingAssetRef[]): void {
  if (!missing.length) return;
  openModal({
    id: 'relink-assets',
    title: t('project.relink.title', 'Relink missing assets'),
    size: 'md',
    render: (close) => <RelinkBody missing={missing} close={close} />,
  });
}
