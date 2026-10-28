/**
 * The Cache & Memory panel's graphics-card views:
 *
 *   • GraphicsMemory (Overview)  the card as the OS shares it out — what
 *     Premation holds (its frame cache darker inside it), the line the OS lets
 *     it reach before paging, and what other apps hold past that line — and
 *     what the engine gave back under pressure this session;
 *   • HeaviestLayers (Diagnostics)  one sampled frame's GPU time per
 *     root-level layer, heaviest first; a row selects its layer.
 *
 * Both read the engine memory snapshot (engineMemory.ts, 2-second polls);
 * HeaviestLayers keeps per-layer sampling on only while it is mounted. No
 * render per played frame.
 */

import { useEffect, useState } from 'react';
import type { LayerCost, RenderStats } from '@motion/engine-api';
import { Button } from '@components/Button';
import { formatBytes, gpuHeldElsewhere, gpuShare, GPU_PRESSURE_SHARE, type MemoryReadout } from '@core/perf/memoryHealth';
import { t } from '@core/i18n';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { wantLayerCosts } from './engineMemory';
import styles from './CacheMemoryPanel.module.css';

const pct = (part: number, whole: number): number => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);

// ── Graphics memory (Overview) ────────────────────────────────────────

export function GraphicsMemory({ readout }: { readout: MemoryReadout | null }): JSX.Element {
  const r = readout;
  const cacheBytes = r?.vramBytes ?? 0;
  const cacheBudget = r?.vramBudget ?? null;
  const name = t('cacheMemory.tier.gpu', 'Graphics memory');

  // Where the OS does not report the card (macOS, Linux for now): the frame cache alone, as before.
  if (!r || r.gpuBudget === null || r.gpuUsed === null || !r.gpuTotal) {
    return (
      <div className={styles.tier}>
        <div className={styles.tierHead}>
          <span className={styles.swatch} data-tone="vram" aria-hidden />
          <span className={styles.label}>{t('cacheMemory.tier.vram', 'Video memory')}</span>
          <span className={styles.value} data-numeric>
            {cacheBudget ? `${formatBytes(cacheBytes)} / ${formatBytes(cacheBudget)}` : formatBytes(cacheBytes)}
          </span>
        </div>
        <div className={styles.track} aria-hidden>
          <span className={styles.fill} data-tone="vram" style={{ width: `${pct(cacheBytes, cacheBudget ?? 0)}%` }} />
        </div>
        <span className={styles.help}>{t('cacheMemory.tier.vramDetail', 'The newest frames, kept on the GPU for instant replay')}</span>
      </div>
    );
  }

  const total = r.gpuTotal;
  const share = gpuShare(r) ?? 0;
  const tight = share >= GPU_PRESSURE_SHARE;
  const elsewhere = gpuHeldElsewhere(r) ?? 0;
  const usedPct = pct(r.gpuUsed, total);
  // The frame cache is part of what the engine holds: drawn inside its bar.
  const cachePct = pct(Math.min(cacheBytes, r.gpuUsed), total);
  const budgetPct = pct(r.gpuBudget, total);
  const label = t('cacheMemory.gpu.bar', '{name}: Premation holds {used} of the {budget} it may use; other apps hold {elsewhere} of {total}', {
    name, used: formatBytes(r.gpuUsed), budget: formatBytes(r.gpuBudget), elsewhere: formatBytes(elsewhere), total: formatBytes(total),
  });

  return (
    <div className={styles.tier}>
      <div className={styles.tierHead}>
        <span className={styles.swatch} data-tone="vram" aria-hidden />
        <span className={styles.label}>{name}</span>
        <span className={styles.value} data-numeric data-tone={tight ? 'warn' : undefined}>
          {`${formatBytes(r.gpuUsed)} / ${formatBytes(r.gpuBudget)}`}
        </span>
      </div>
      <div className={styles.track} role="img" aria-label={label}>
        <span className={styles.fill} data-tone={tight ? 'warn' : 'vramSoft'} style={{ width: `${usedPct}%` }} />
        <span className={styles.fill} data-tone="vram" style={{ width: `${cachePct}%` }} />
        {/* Past the OS's line for Premation: what other apps and the system hold. */}
        <span className={styles.elsewhere} style={{ left: `${budgetPct}%`, width: `${100 - budgetPct}%` }} />
        <span className={styles.budgetMark} style={{ left: `${budgetPct}%` }} />
      </div>
      <div className={styles.keys}>
        <span><span className={styles.legendKey} data-tone="vram" aria-hidden />{t('cacheMemory.gpu.cache', 'Frame cache {cache}', { cache: formatBytes(cacheBytes) })}</span>
        <span><span className={styles.legendKey} data-tone="vramSoft" aria-hidden />{t('cacheMemory.gpu.engine', 'Layers & effects')}</span>
        <span><span className={styles.legendKey} data-tone="elsewhere" aria-hidden />{t('cacheMemory.gpu.elsewhere', 'Other apps {elsewhere} of {total}', { elsewhere: formatBytes(elsewhere), total: formatBytes(total) })}</span>
      </div>
      {tight ? (
        <span className={styles.warn} role="note">
          {t('cacheMemory.gpu.tight', 'Near the line: the oldest cached frames move to RAM and idle buffers are freed, so nothing pages to system memory mid-playback.')}
        </span>
      ) : r.gpuTrimmed > 0 ? (
        <span className={styles.help}>
          {t('cacheMemory.gpu.trimmed', '{trimmed} given back to other apps this session — cached frames moved to RAM, none were lost.', { trimmed: formatBytes(r.gpuTrimmed) })}
        </span>
      ) : (
        <span className={styles.help}>{t('cacheMemory.gpu.detail', 'The line is what the OS lets Premation hold before it starts paging; it moves as other apps take or free memory.')}</span>
      )}
    </div>
  );
}

// ── Heaviest layers (Diagnostics) ─────────────────────────────────────

const ROWS = 8;

/** A row's name, a short tag after it, and the tooltip that explains the tag. */
function costName(c: LayerCost): { name: string; tag?: string; note?: string } {
  if (c.kind === 'frame') {
    return { name: t('cacheMemory.heavy.frame', 'Frame setup'), note: t('cacheMemory.heavy.frameNote', 'Clearing, the background and the viewer transform') };
  }
  const layer = c.layer ? documentMirror().layer(c.layer) : undefined;
  const name = layer?.name ?? t('cacheMemory.heavy.unknown', 'Layer');
  return c.kind === 'scene3d'
    ? { name, tag: '3D', note: t('cacheMemory.heavy.scene3d', 'A run of 3D layers drawn together, starting with this one') }
    : { name };
}

function ago(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1500) return t('cacheMemory.heavy.justNow', 'just now');
  const s = Math.round(ms / 1000);
  return s < 60 ? t('cacheMemory.heavy.secondsAgo', '{s} s ago', { s }) : t('cacheMemory.heavy.minutesAgo', '{m} min ago', { m: Math.round(s / 60) });
}

export function HeaviestLayers({ stats, budgetMs }: { stats: RenderStats | null; budgetMs: number }): JSX.Element {
  // Sampling runs only while this list is on screen.
  useEffect(() => wantLayerCosts(), []);
  const [all, setAll] = useState(false);
  const selected = useSelectionStore((s) => s.ids);
  const costs = stats?.layerCosts ?? [];
  const total = stats?.layerCostsFrameMs ?? 0;
  const max = Math.max(0.001, ...costs.map((c) => c.gpuMs));
  const shown = all ? costs : costs.slice(0, ROWS);

  return (
    <section className={styles.section} aria-label={t('cacheMemory.heavy', 'Heaviest layers')}>
      <div className={styles.rowHead}>
        <span className={styles.group}>{t('cacheMemory.heavy', 'Heaviest layers')}</span>
        {costs.length > 0 && (
          <span className={styles.helpRight} data-numeric>
            {t('cacheMemory.heavy.meta', '{total} ms GPU · {ago}', { total: total.toFixed(2), ago: ago(stats?.layerCostsAgoMs) })}
          </span>
        )}
      </div>

      {!stats && (
        <div className={styles.skeleton} aria-hidden>
          <span /><span /><span />
        </div>
      )}
      {stats && costs.length === 0 && (
        <span className={styles.help}>
          {t('cacheMemory.heavy.empty', 'Play or scrub to measure. Cached frames are not drawn, so purge the RAM preview to time a cached range.')}
        </span>
      )}

      {shown.length > 0 && (
        <ol className={styles.costs}>
          {shown.map((c, i) => {
            const { name, tag, note } = costName(c);
            const selectable = c.kind !== 'frame' && !!c.layer && documentMirror().hasLayer(c.layer);
            const over = c.gpuMs > budgetMs;
            return (
              <li key={`${c.kind}:${c.layer}`}>
                <button
                  type="button"
                  className={styles.cost}
                  data-selected={selectable && selected.includes(c.layer) ? '' : undefined}
                  disabled={!selectable}
                  title={selectable ? t('cacheMemory.heavy.select', 'Select {name}', { name }) + (note ? ` — ${note}` : '') : note}
                  onClick={() => useSelectionStore.getState().set([c.layer])}
                >
                  <span className={styles.costRank} data-numeric>{i + 1}</span>
                  <span className={styles.costName}>
                    <span className={styles.label}>{name}</span>
                    {tag && <span className={styles.badge}>{tag}</span>}
                  </span>
                  <span className={styles.value} data-numeric data-tone={over ? 'warn' : undefined}>
                    {`${c.gpuMs.toFixed(c.gpuMs < 1 ? 2 : 1)} ms`}
                  </span>
                  <span className={styles.costTrack} aria-hidden>
                    <span className={styles.fill} data-tone={over ? 'warn' : 'time'} style={{ width: `${pct(c.gpuMs, max)}%` }} />
                  </span>
                  <span className={styles.costShare} data-numeric>
                    {c.passes === 1
                      ? t('cacheMemory.heavy.shareOne', '{share}% · 1 pass', { share: Math.round(pct(c.gpuMs, total)) })
                      : t('cacheMemory.heavy.share', '{share}% · {passes} passes', { share: Math.round(pct(c.gpuMs, total)), passes: c.passes })}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {costs.length > ROWS && (
        <div className={styles.actions}>
          <Button variant="ghost" size="xs" onClick={() => setAll((v) => !v)}>
            {all ? t('cacheMemory.heavy.fewer', 'Show fewer') : t('cacheMemory.heavy.more', 'Show all {n}', { n: costs.length })}
          </Button>
        </div>
      )}
      {costs.length > 0 && (
        <span className={styles.help}>
          {t('cacheMemory.heavy.help', 'GPU time of one frame, timed per layer: a precomp counts its whole nested comp and its effects. Click a layer to select it.')}
        </span>
      )}
    </section>
  );
}
