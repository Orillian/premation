/**
 * P7c: native plugins' output modules as export formats (`plugin:<id>/<module>`,
 * docs/PLUGIN_SDK.md "Output modules"). The Export form and the Render Queue
 * list them in a "Plugins" category beside the built-in formats; each module's
 * declared options (popup, number, checkbox) are drawn here and travel with
 * the job as JSON (`pluginOptions`). The engine export runs the module (BEGIN /
 * WRITE_FRAME / WRITE_AUDIO / END) in its own process: a module that crashes
 * fails that job with its message, nothing else.
 */

import type { ExportFormat, ExportPreset } from '@core/export/exportManager';
import {
  defaultOutputOptions,
  isPluginFormat,
  pluginOutputFormat,
  pluginOutputFormats,
} from '@core/nativePlugins/pluginContrib';
import { usePluginContrib } from '@hooks/usePluginContrib';
import { usePluginExportOptions, type PluginOptionValues } from '@stores/pluginExportOptionsStore';
import { t } from '@core/i18n';
import styles from './ExportDialog.module.css';

export { isPluginFormat };

type OptionValues = PluginOptionValues;

/** The format's options: the declared defaults under the user's values. */
export function pluginOptionValues(format: string): OptionValues {
  const f = pluginOutputFormat(format);
  if (!f) return {};
  return { ...defaultOutputOptions(f.module), ...usePluginExportOptions.getState().values[format] };
}

/** The job's `pluginOptions` for a plugin format, else nothing. */
export function pluginOptionsField(format: string): { pluginOptions?: string } {
  return isPluginFormat(format) ? { pluginOptions: JSON.stringify(pluginOptionValues(format)) } : {};
}

/** The file extension a plugin format writes ('' for any other format). */
export function pluginFormatExt(format: string): string {
  return pluginOutputFormat(format)?.module.extension ?? '';
}

/** The loaded plugins' output modules as export presets, and their category. Re-renders when plugins change. */
export function usePluginExportPresets(): { presets: ExportPreset[]; group: { id: string; label: string; formats: ExportFormat[] } | null } {
  usePluginContrib();
  const formats = pluginOutputFormats();
  const presets: ExportPreset[] = formats.map((f) => ({
    format: f.id,
    label: f.module.name,
    ext: f.module.extension,
    hint: t('export.pluginFormat.hint', "{name} — written by the {plugin} plugin's output module, frame by frame, to the path you choose.", { name: f.module.name, plugin: f.pluginName }),
    desktopOnly: true,
  }));
  return { presets, group: presets.length > 0 ? { id: 'plugins', label: t('export.pluginFormat.category', 'Plugins'), formats: presets.map((p) => p.format) } : null };
}

/** The declared options of the selected plugin format, as controls. */
export function PluginFormatOptions({ format, disabled }: { format: string; disabled: boolean }): JSX.Element | null {
  usePluginContrib();
  const values = usePluginExportOptions((s) => s.values[format]);
  const setValue = usePluginExportOptions((s) => s.set);
  const f = pluginOutputFormat(format);
  if (!f || f.module.options.length === 0) return null;
  return (
    <div className={styles.section}>
      <div className={styles.label}>{t('export.pluginFormat.options', '{name} options', { name: f.module.name })}</div>
      {f.module.options.map((o) => {
        const v = values?.[o.id] ?? (o.type === 'checkbox' ? o.defaultValue !== 0 : o.defaultValue);
        const id = `plugin-opt-${o.id}`;
        if (o.type === 'popup') {
          return (
            <label key={o.id} htmlFor={id} className={styles.fieldNote} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ minWidth: 96 }}>{o.name}</span>
              <select id={id} disabled={disabled} value={Number(v)} onChange={(e) => setValue(format, o.id, Number(e.target.value))}>
                {o.choices.map((c, i) => (
                  <option key={c} value={i + 1}>{c}</option>
                ))}
              </select>
            </label>
          );
        }
        if (o.type === 'checkbox') {
          return (
            <label key={o.id} htmlFor={id} className={styles.fieldNote} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input id={id} type="checkbox" disabled={disabled} checked={Boolean(v)} onChange={(e) => setValue(format, o.id, e.target.checked)} />
              <span>{o.name}</span>
            </label>
          );
        }
        return (
          <label key={o.id} htmlFor={id} className={styles.fieldNote} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ minWidth: 96 }}>{o.name}</span>
            <input
              id={id}
              type="number"
              disabled={disabled}
              value={Number(v)}
              {...(o.min !== undefined ? { min: o.min } : {})}
              {...(o.max !== undefined ? { max: o.max } : {})}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setValue(format, o.id, n);
              }}
              style={{ width: 80 }}
            />
          </label>
        );
      })}
    </div>
  );
}
