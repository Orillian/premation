/**
 * Cache & Memory ▸ Health — Project Health: what the active composition is
 * costing, what is broken in it, and one action per problem. The verdict is
 * `projectHealth.ts`; the figures come from `useProjectHealth` and the
 * timeline's cache coverage. Reached from the panel's view switch or the
 * status bar's health dot.
 */

import { Button } from '@components/Button';
import { asCommandId } from '@app-types/common';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { edit } from '@core/engine/uiEdits';
import { formatBytes } from '@core/perf/memoryHealth';
import { documentMirror } from '@stores/documentMirror';
import { t } from '@core/i18n';
import { usePreviewCacheStats } from '@layout/Timeline/CacheActions';
import { cacheWorkAreaNow, canCacheWorkArea, purgeRamPreview } from '@layout/Timeline/previewCacheCommands';
import { createProxies, proxyToggleEdit } from '@layout/Assets/proxyCommands';
import { setCacheMemoryView } from './cacheMemoryView';
import { refreshEngineMemory } from './engineMemory';
import type { HealthFinding } from './projectHealth';
import { useProjectHealth } from './useProjectHealth';
import styles from './CacheMemoryPanel.module.css';

interface Copy {
  title: string;
  body: string;
  action?: { label: string; run: () => void; disabled?: boolean };
}

function enableProxies(items: readonly string[]): void {
  const cmds = items
    .map((id) => documentMirror().item(id))
    .flatMap((info) => (info && !info.proxyEnabled ? [proxyToggleEdit(info)] : []))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (cmds.length > 0) void edit('Use Proxy', cmds);
}

function findingCopy(f: HealthFinding, refresh: () => void): Copy {
  switch (f.kind) {
    case 'layerErrors':
      return {
        title: f.n === 1
          ? t('health.layerErrors.one', '1 layer is not drawing correctly')
          : t('health.layerErrors.other', '{n} layers are not drawing correctly', { n: f.n }),
        body: t('health.layerErrors.body', 'An effect, plugin, decode or expression failed on them; the rest of the frame still renders. The notice over the viewer and the timeline rows name each one.'),
      };
    case 'memoryGrowing':
      return {
        title: t('health.memoryGrowing', 'Engine memory keeps growing'),
        body: t('health.memoryGrowing.body', 'Memory outside the caches has climbed for many minutes. Restarting the engine frees it; the project stays open.'),
        action: { label: t('health.memoryGrowing.action', 'Open Diagnostics'), run: () => setCacheMemoryView('diagnostics') },
      };
    case 'machineLow':
      return {
        title: t('health.machineLow', 'This machine is low on memory'),
        body: t('health.machineLow.body', 'Previews give memory back first. Purging them, closing other apps or lowering RAM for previews helps.'),
        action: { label: t('timeline.cache.purgeRamPreview', 'Purge RAM Preview'), run: () => { purgeRamPreview(); refresh(); refreshEngineMemory(); } },
      };
    case 'ramFull':
      return {
        title: t('health.ramFull', 'RAM previews are at their budget'),
        body: t('health.ramFull.body', 'The oldest frames make way for new ones. Raise RAM for previews in Overview, or purge frames you no longer need.'),
        action: { label: t('timeline.cache.purgeRamPreview', 'Purge RAM Preview'), run: () => { purgeRamPreview(); refresh(); refreshEngineMemory(); } },
      };
    case 'missingFootage':
      return {
        title: f.n === 1
          ? t('health.missing.one', '1 footage file is missing')
          : t('health.missing.other', '{n} footage files are missing', { n: f.n }),
        body: t('health.missing.body', 'Layers using them draw nothing. Relink them from the Project panel.'),
      };
    case 'largeWithoutProxy':
      return {
        title: f.n === 1
          ? t('health.noProxy.one', '1 clip of 4K footage has no proxy')
          : t('health.noProxy.other', '{n} clips of 4K footage have no proxy', { n: f.n }),
        body: t('health.noProxy.body', 'Decoding full-size frames is the slowest part of scrubbing them. A proxy is a low-resolution copy the viewer uses instead; exports always use the originals.'),
        action: { label: t('health.noProxy.action', 'Create Proxies'), run: () => { void createProxies(f.items ?? []); } },
      };
    case 'proxiesOff':
      return {
        title: f.n === 1
          ? t('health.proxyOff.one', '1 4K clip has a proxy that is switched off')
          : t('health.proxyOff.other', '{n} 4K clips have proxies that are switched off', { n: f.n }),
        body: t('health.proxyOff.body', 'The viewer decodes the originals. The box left of the name in the Project panel switches each one.'),
        action: { label: t('health.proxyOff.action', 'Use Their Proxies'), run: () => enableProxies(f.items ?? []) },
      };
    case 'useProxiesOff':
      return {
        title: t('health.useProxiesOff', 'Use Proxies is off'),
        body: f.n === 1
          ? t('health.useProxiesOff.one', '1 clip here has a proxy ready, but the viewer shows originals everywhere while the switch is off.')
          : t('health.useProxiesOff.other', '{n} clips here have proxies ready, but the viewer shows originals everywhere while the switch is off.', { n: f.n }),
        action: { label: t('health.useProxiesOff.action', 'Turn On Use Proxies'), run: () => { void getCommandSystem().execute(asCommandId('view.useProxies')); } },
      };
    case 'manyVideoLayers':
      return {
        title: t('health.manyVideo', '{n} video layers in this composition', { n: f.n }),
        body: t('health.manyVideo.body', 'Each visible video layer is a stream the engine decodes. Precompose layers that move together and trim layers to the frames they show.'),
      };
    case 'slowUncached':
      return {
        title: t('health.slow', 'Frames take {ms} ms to render', { ms: f.n }),
        body: t('health.slow.body', 'Slower than real time, and the composition is not fully cached. Cache it once and it plays every frame on time.'),
        action: { label: t('timeline.cache.cacheWorkAreaNow', 'Cache Work Area Now'), run: () => { cacheWorkAreaNow(); refresh(); }, disabled: !canCacheWorkArea() },
      };
  }
}

export function ProjectHealthView(): JSX.Element {
  const { stats: cache, refresh } = usePreviewCacheStats();
  const { health, footage, mem } = useProjectHealth({ cached: cache.cached, total: cache.total });
  const r = mem.readout;
  const errorLayers = footage ? new Set(footage.errors.map((e) => e.layer)).size : 0;

  return (
    <>
      <section className={styles.section} aria-label={t('health.comp', 'This composition')}>
        <span className={styles.group}>{t('health.comp', 'This composition')}</span>
        {!footage && <span className={styles.help}>{t('health.noComp', 'Open a composition to see its health.')}</span>}
        {footage && (
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.help}>{t('health.stat.cached', 'Cached')}</span>
              <span className={styles.value} data-numeric>
                {cache.total > 0 ? t('cacheMemory.compFrames', '{cached} / {total} frames', { cached: cache.cached, total: cache.total }) : '—'}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.help} title={t('health.stat.videoHelp', 'Visible layers of video footage: each is a stream the engine decodes')}>
                {t('health.stat.video', 'Video layers')}
              </span>
              <span className={styles.value} data-numeric>
                {footage.videoSources > 0 && footage.videoSources !== footage.videoLayers
                  ? t('health.stat.videoValue', '{layers} ({files} files)', { layers: footage.videoLayers, files: footage.videoSources })
                  : footage.videoLayers}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.help}>{t('health.stat.errors', 'Layers with errors')}</span>
              <span className={styles.value} data-numeric data-tone={errorLayers > 0 ? 'bad' : undefined}>{errorLayers}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.help}>{t('health.stat.missing', 'Missing footage')}</span>
              <span className={styles.value} data-numeric data-tone={footage.missing > 0 ? 'warn' : undefined}>{footage.missing}</span>
            </div>
          </div>
        )}
      </section>

      <section className={styles.section} aria-label={t('health.engine', 'Engine')}>
        <span className={styles.group}>{t('health.engine', 'Engine')}</span>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.help}>{t('health.stat.vram', 'Video memory frame cache')}</span>
            <span className={styles.value} data-numeric>
              {r ? (r.vramBudget ? `${formatBytes(r.vramBytes)} / ${formatBytes(r.vramBudget)}` : formatBytes(r.vramBytes)) : '—'}
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.help}>{t('cacheMemory.tier.ram', 'RAM previews')}</span>
            <span className={styles.value} data-numeric data-tone={mem.health.kind === 'pressure' ? 'warn' : undefined}>
              {r ? (r.ramBudget ? `${formatBytes(r.ramBytes)} / ${formatBytes(r.ramBudget)}` : formatBytes(r.ramBytes)) : '—'}
            </span>
          </div>
        </div>
        <span className={styles.help}>
          {t('health.engineHelp', 'Video memory here is the viewport’s frame cache. The GPU’s total use and the number of open decoders are not reported by the engine yet.')}
        </span>
      </section>

      <section className={styles.section} aria-label={t('health.suggestions', 'Suggestions')}>
        <span className={styles.group}>{t('health.suggestions', 'Suggestions')}</span>
        {health.findings.length === 0 && (
          <span className={styles.help}>
            {r || footage ? t('health.allGood', 'Nothing to fix: this composition is in good shape.') : t('cacheMemory.waiting', 'Waiting for the engine…')}
          </span>
        )}
        {health.findings.length > 0 && (
          <ul className={styles.findings}>
            {health.findings.map((f) => {
              const c = findingCopy(f, refresh);
              return (
                <li key={f.kind} className={styles.finding} data-tone={f.tone}>
                  <span className={styles.findingDot} aria-hidden />
                  <div className={styles.findingText}>
                    <span className={styles.bannerTitle}>{c.title}</span>
                    <span className={styles.help}>{c.body}</span>
                    {c.action && (
                      <div className={styles.actions}>
                        <Button variant="secondary" size="sm" disabled={c.action.disabled} onClick={c.action.run}>
                          {c.action.label}
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
