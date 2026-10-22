/**
 * OutputModuleDialog — the settings a queued render is created with, in the shape
 * After Effects users expect (format, resolution, frame rate, duration, channels).
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { DialogFooter, enterShouldConfirm } from '@components/Modal';
import { OutputFormat } from '@stores/renderQueueStore';
import { canEncodeLocally, PRORES_PROFILE_LABELS, type ExportQuality, type ProresProfile } from '@core/export/renderSpec';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { exportSupervisorClient } from '@core/export/exportSupervisorClient';
import { shouldUseSupervisor } from '@layout/Export/supervisorQueue';
import {
  listOutputTemplates,
  saveOutputTemplate,
  deleteOutputTemplate,
  isBuiltinOutputTemplate,
  applyOutputTemplate,
} from '@core/export/outputTemplates';
import { customPrompt } from '@components/Modal/Dialogs';
import { t } from '@core/i18n';
import styles from './OutputModuleDialog.module.css';

export interface OutputSettings {
  format: OutputFormat;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  transparent: boolean;
  quality: ExportQuality;
  /** mov only — which ProRes flavour ffmpeg encodes. */
  proresProfile?: ProresProfile;
  /** F1: 16 bits per channel — mov through the engine export path only (main's `bitDepth16`). */
  bitDepth?: 8 | 16;
}

/** Explicit order (not Object.keys — numeric-looking keys re-sort): alpha first, then by size. */
const PRORES_PROFILES: ReadonlyArray<ProresProfile> = ['4444', 'hq', '422', 'lt', 'proxy'];

/** Every queueable format, with the formats only ffmpeg can produce marked. */
/** Called at render time: `t()` must not run at module scope. */
function outputFormats(): ReadonlyArray<{ value: OutputFormat; label: string; desktopOnly?: boolean }> {
  return [
    { value: 'mp4', label: 'H.264 MP4', desktopOnly: true },
    { value: 'hdr10', label: 'HDR10 MP4 (PQ)', desktopOnly: true },
    { value: 'hlg', label: 'HLG MP4', desktopOnly: true },
    { value: 'webm', label: 'WebM VP9' },
    { value: 'mov', label: 'ProRes MOV', desktopOnly: true },
    { value: 'gif', label: t('renderQueue.format.gif', 'Animated GIF') },
    { value: 'png-sequence', label: t('renderQueue.format.pngSequence', 'PNG Sequence') },
    { value: 'jpg-sequence', label: t('renderQueue.format.jpgSequence', 'JPEG Sequence') },
    { value: 'exr-sequence', label: t('renderQueue.format.exrSequence', 'EXR Sequence') },
  ];
}

/** Formats that carry an alpha channel — the rest cannot honour "transparent". */
const ALPHA_FORMATS: ReadonlySet<OutputFormat> = new Set(['webm', 'mov', 'gif', 'png-sequence', 'exr-sequence']);

interface OutputModuleDialogProps {
  initialWidth: number;
  initialHeight: number;
  initialFps: number;
  initialDuration: number;
  onConfirm: (settings: OutputSettings) => void;
  onCancel: () => void;
}

export function OutputModuleDialog({
  initialWidth,
  initialHeight,
  initialFps,
  initialDuration,
  onConfirm,
  onCancel,
}: OutputModuleDialogProps): JSX.Element {
  // Only offer what this build can actually encode: queueing an MP4 in the
  // browser would fail at encode time, after the whole render had run.
  const formats = useMemo(() => {
    const local = canEncodeLocally();
    return outputFormats().filter((f) => local || !f.desktopOnly);
  }, []);

  const [format, setFormat] = useState<OutputFormat>(formats[0]?.value ?? 'webm');
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [fps, setFps] = useState(initialFps);
  const [duration, setDuration] = useState(initialDuration);
  // Seeded from the comp's own transparency, like the Export dialog — a
  // comp set transparent in Composition Settings queued opaque otherwise.
  const [transparent, setTransparent] = useState(() => !!documentMirror().comp(activeCompIdNow() ?? '')?.settings.transparent);
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [proresProfile, setProresProfile] = useState<ProresProfile>('4444');
  const [bitDepth, setBitDepth] = useState<8 | 16>(8);
  // F1: 16 bits per channel exists only on the engine export path (main's
  // PREMATION_EXPORT_ENGINE flag) and only for a job main's queue renders —
  // the in-window queue writes 8 bits (the Export form's rule).
  const [bitDepth16, setBitDepth16] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void exportSupervisorClient.capabilities().then((c) => { if (!cancelled) setBitDepth16(c.bitDepth16); });
    return () => { cancelled = true; };
  }, []);
  const offerBitDepth = format === 'mov' && bitDepth16 && shouldUseSupervisor(format);
  // MOV alpha only exists in 4444 — the 422 family has no alpha plane.
  const supportsAlpha = ALPHA_FORMATS.has(format) && (format !== 'mov' || proresProfile === '4444');

  // Templates. The list lives in localStorage, not React state, so `setTemplatesRev`
  // after a save/delete is what re-renders the dropdown — and the list is simply
  // re-read each render rather than memoized on the rev, because a dialog
  // re-renders a handful of times and a localStorage read is nothing.
  const [, setTemplatesRev] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const templates = listOutputTemplates();

  const applyTemplate = (name: string): void => {
    setSelectedTemplate(name);
    const tpl = templates.find((x) => x.name === name);
    if (!tpl) return;
    // Resolved against the COMP's size and rate (the initial values), not the
    // dialog's current fields — a template means "half of the comp", not "half
    // of whatever was last typed here".
    const out = applyOutputTemplate(tpl, { width: initialWidth, height: initialHeight, fps: initialFps });
    // Skip formats this build cannot encode (mp4 in the browser) rather than
    // silently queueing a render that fails at encode time.
    if (formats.some((f) => f.value === out.format)) setFormat(out.format);
    setWidth(out.width);
    setHeight(out.height);
    setFps(out.fps);
    setQuality(out.quality);
    setTransparent(out.transparent && ALPHA_FORMATS.has(out.format));
  };

  const saveAsTemplate = async (): Promise<void> => {
    // customPrompt, not window.prompt — the latter does not exist in Electron,
    // so Save would silently do nothing in the packaged app.
    const name = await customPrompt(
      t('renderQueue.outputModule.saveTemplateTitle', 'Save Template'),
      t('renderQueue.outputModule.templateName', 'Template name'),
      selectedTemplate || t('renderQueue.outputModule.defaultTemplateName', 'My Template'),
    );
    if (!name) return;
    saveOutputTemplate({
      name,
      format,
      quality,
      transparent: transparent && supportsAlpha,
      // Stored RELATIVE to the comp, so "Half Res" saved from an HD comp still
      // means half when applied to a 4K one.
      scale: initialWidth > 0 ? width / initialWidth : 1,
      fps: fps === initialFps ? 'comp' : fps,
    });
    setSelectedTemplate(name);
    setTemplatesRev((r) => r + 1);
  };

  const removeTemplate = (): void => {
    if (!selectedTemplate) return;
    deleteOutputTemplate(selectedTemplate);
    // Deleting a built-in's override restores the built-in, so only clear the
    // selection when the name is gone entirely.
    if (!isBuiltinOutputTemplate(selectedTemplate)) setSelectedTemplate('');
    setTemplatesRev((r) => r + 1);
  };

  const confirm = (): void =>
    // Clamped on OK: raw number inputs let a cleared field submit 0/NaN,
    // which reached the renderer as fps 0 (NaN frame times), width 0 (a 0×N
    // canvas) or duration 0. Fall back to the comp's own values rather than
    // refusing — the dialog's initial state.
    onConfirm({
      format,
      width: Number.isFinite(width) && width >= 2 ? Math.round(width) : initialWidth,
      height: Number.isFinite(height) && height >= 2 ? Math.round(height) : initialHeight,
      fps: Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : initialFps,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : initialDuration,
      transparent: transparent && supportsAlpha,
      quality,
      ...(format === 'mov' ? { proresProfile } : {}),
      ...(offerBitDepth && bitDepth === 16 ? { bitDepth: 16 as const } : {}),
    });

  // Not a `Modal` (it sits inside the Render Queue panel rather than the
  // modal stack), so it applies the same Enter rule by hand: Enter confirms
  // unless the focused element owns Enter (`enterShouldConfirm`); Escape
  // cancels.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Enter' || e.altKey || e.shiftKey) return;
    if (!(e.ctrlKey || e.metaKey) && !enterShouldConfirm(e.target)) return;
    e.preventDefault();
    confirm();
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="output-module-title" onKeyDown={onKeyDown}>
        <div className={styles.header}>
          <h2 id="output-module-title">{t('renderQueue.outputModule.title', 'Output Module Settings')}</h2>
          <button type="button" className={styles.closeBtn} onClick={onCancel} aria-label={t('renderQueue.outputModule.close', 'Close')}>
            <Icon name="close" size="sm" />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.fieldRow}>
            <label>{t('renderQueue.outputModule.template', 'Template')}</label>
            <div className={styles.multiInput}>
              <select
                value={selectedTemplate}
                onChange={(e) => applyTemplate(e.target.value)}
                aria-label={t('renderQueue.outputModule.templateLabel', 'Output template')}
              >
                <option value="">{t('renderQueue.outputModule.choose', '— choose —')}</option>
                {templates.map((tpl) => (
                  <option key={tpl.name} value={tpl.name}>{tpl.name}</option>
                ))}
              </select>
              <button type="button" className={styles.cancelBtn} onClick={saveAsTemplate} title={t('renderQueue.outputModule.saveTitle', 'Save the current settings as a named template')}>
                {t('renderQueue.outputModule.save', 'Save…')}
              </button>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={removeTemplate}
                disabled={!selectedTemplate}
                title={isBuiltinOutputTemplate(selectedTemplate) ? t('renderQueue.outputModule.resetTitle', 'Reset this built-in to its shipped settings') : t('renderQueue.outputModule.deleteTitle', 'Delete this template')}
              >
                {isBuiltinOutputTemplate(selectedTemplate) ? t('renderQueue.outputModule.reset', 'Reset') : t('renderQueue.outputModule.delete', 'Delete')}
              </button>
            </div>
          </div>

          <div className={styles.fieldRow}>
            <label>{t('renderQueue.outputModule.format', 'Format')}</label>
            <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
              {formats.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          {format === 'mov' ? (
            <div className={styles.fieldRow}>
              <label>{t('renderQueue.outputModule.proresProfile', 'ProRes Profile')}</label>
              <select
                value={proresProfile}
                onChange={(e) => setProresProfile(e.target.value as ProresProfile)}
                aria-label={t('export.form.proresProfile', 'ProRes profile')}
              >
                {PRORES_PROFILES.map((p) => (
                  <option key={p} value={p}>{PRORES_PROFILE_LABELS[p]}</option>
                ))}
              </select>
            </div>
          ) : null}

          {offerBitDepth ? (
            <div className={styles.fieldRow}>
              <label>{t('renderQueue.outputModule.bitsPerChannel', 'Bits per Channel')}</label>
              <select
                value={bitDepth}
                onChange={(e) => setBitDepth(e.target.value === '16' ? 16 : 8)}
                aria-label={t('export.form.bitsPerChannel', 'Bits per channel')}
                title={bitDepth === 16
                  ? t('export.form.bitDepth16Note', 'Rendered by the engine into a half-float surface (rgba64le). A job the engine cannot render is delivered at 8 bits, with a warning.')
                  : t('export.form.bitDepth8Note', '8 bits per channel, as every renderer writes it.')}
              >
                <option value="8">{t('renderQueue.outputModule.bits', '{n} bits', { n: 8 })}</option>
                <option value="16">{t('renderQueue.outputModule.bits', '{n} bits', { n: 16 })}</option>
              </select>
            </div>
          ) : null}

          <div className={styles.fieldRow}>
            <label>{t('renderQueue.outputModule.resolution', 'Resolution')}</label>
            <div className={styles.multiInput}>
              <input 
                type="number" 
                value={width} 
                onChange={(e) => setWidth(Number(e.target.value))} 
                min={1} 
              />
              <span>×</span>
              <input 
                type="number" 
                value={height} 
                onChange={(e) => setHeight(Number(e.target.value))} 
                min={1} 
              />
            </div>
          </div>

          <div className={styles.fieldRow}>
            <label>{t('renderQueue.outputModule.frameRate', 'Frame Rate')}</label>
            <input 
              type="number" 
              value={fps} 
              onChange={(e) => setFps(Number(e.target.value))} 
              min={1} 
            />
          </div>

          <div className={styles.fieldRow}>
            <label>{t('renderQueue.outputModule.duration', 'Duration (s)')}</label>
            <input 
              type="number" 
              value={duration} 
              onChange={(e) => setDuration(Number(e.target.value))} 
              min={0.1}
              step={0.1}
            />
          </div>

          <div className={styles.fieldRow}>
            <label>{t('renderQueue.outputModule.quality', 'Quality')}</label>
            <select value={quality} onChange={(e) => setQuality(e.target.value as ExportQuality)}>
              <option value="high">{t('renderQueue.outputModule.qualityHigh', 'High — best quality, slowest')}</option>
              <option value="medium">{t('renderQueue.outputModule.qualityMedium', 'Medium — balanced')}</option>
              <option value="draft">{t('renderQueue.outputModule.qualityDraft', 'Draft — fast, visibly compressed')}</option>
            </select>
          </div>

          <div className={styles.fieldRow}>
            <label>{t('renderQueue.outputModule.channels', 'Channels')}</label>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={transparent && supportsAlpha}
                disabled={!supportsAlpha}
                onChange={(e) => setTransparent(e.target.checked)}
                // Offering alpha for MP4 or JPEG would promise transparency the
                // container cannot carry, and silently flatten it instead.
                title={supportsAlpha ? undefined : t('renderQueue.outputModule.noAlpha', '{format} has no alpha channel', { format })}
              />
              {t('renderQueue.outputModule.rgbAlpha', 'RGB + Alpha (Transparent)')}
            </label>
          </div>
        </div>

        <div className={styles.footerRow}>
          <DialogFooter
            secondary={
              <Button variant="secondary" size="sm" onClick={onCancel}>
                {t('renderQueue.outputModule.cancel', 'Cancel')}
              </Button>
            }
            primary={
              <Button variant="primary" size="sm" onClick={confirm}>
                {t('renderQueue.outputModule.ok', 'OK')}
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}
