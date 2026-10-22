/**
 * The publisher's listing: what a Free user reads to decide whether a plugin
 * is worth Premation Cloud. Icon, up to three screenshots, About (Markdown)
 * and release notes per version — all outside the signed package, so they
 * can change without a new version (motion-back PluginMedia / listing /
 * versions/:version/notes).
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { api, MAX_PLUGIN_SCREENSHOTS, storeMediaUrl, type StorePluginDetail } from '@core/api/client';
import { PluginIcon } from './PluginIcon';
import styles from './NativePlugins.module.css';
import { t } from '@core/i18n';

const IMAGE_TYPES = 'image/png,image/jpeg,image/webp';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_NOTES = 5000;
const MAX_ABOUT = 131072;

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function PluginListingEditor({ detail, onChanged }: { detail: StorePluginDetail; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [about, setAbout] = useState(detail.readme ?? '');
  const versions = detail.versionHistory ?? [];
  const [notesFor, setNotesFor] = useState(versions[0]?.version ?? detail.latestVersion);
  const [notes, setNotes] = useState(versions[0]?.releaseNotes ?? '');
  const shots = detail.screenshots ?? [];

  const run = async (key: string, work: () => Promise<unknown>, done: string, fallback: string): Promise<void> => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await work();
      setNote(done);
      onChanged();
    } catch (e) {
      setError(errorText(e, fallback));
    } finally {
      setBusy(null);
    }
  };

  const upload = (kind: 'icon' | 'screenshot', file: File | undefined): void => {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setError(t('plugins.listing.imageTooBig', 'Images can be up to 2 MB.'));
      return;
    }
    void run(
      kind,
      () => api.uploadPluginMedia(detail.id, kind, file),
      kind === 'icon' ? t('plugins.listing.iconUpdated', 'Icon updated.') : t('plugins.listing.screenshotAdded', 'Screenshot added.'),
      t('plugins.listing.uploadFailed', 'The upload failed.'),
    );
  };

  const pickVersion = (version: string): void => {
    setNotesFor(version);
    setNotes(versions.find((v) => v.version === version)?.releaseNotes ?? '');
  };

  return (
    <div className={styles.section} aria-label={t('plugins.listing.editAria', 'Edit listing')}>
      <h4 className={styles.sectionTitle}>{t('plugins.listing.title', 'Your listing')}</h4>
      <p className={styles.text}>
        {t(
          'plugins.listing.intro',
          'This is what people see before they install — and, for a Premation Cloud plugin, what a Free user reads to decide whether to subscribe. Show it working.',
        )}
      </p>

      <div className={styles.editorRow}>
        <PluginIcon plugin={detail} size={56} />
        <div className={styles.rowBody}>
          <strong className={styles.rowName}>{t('plugins.listing.icon', 'Icon')}</strong>
          <span className={styles.rowMeta}>{t('plugins.listing.iconHint', 'Square PNG, JPEG or WebP, at least 256 × 256, up to 2 MB.')}</span>
        </div>
        <label className={styles.uploadLabel}>
          <Icon name="upload" size="sm" />
          {busy === 'icon'
            ? t('plugins.listing.uploading', 'Uploading…')
            : detail.iconUrl
              ? t('plugins.listing.replaceIcon', 'Replace icon')
              : t('plugins.listing.addIcon', 'Add icon')}
          <input type="file" accept={IMAGE_TYPES} disabled={busy !== null} onChange={(e) => { upload('icon', e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>

      <div className={styles.editorBlock}>
        <span className={styles.rowName}>
          {t('plugins.listing.screenshots', 'Screenshots ({n}/{max})', { n: shots.length, max: MAX_PLUGIN_SCREENSHOTS })}
        </span>
        <span className={styles.rowMeta}>
          {t('plugins.listing.screenshotsHint', '16:9 works best (1600 × 900). The first one is the cover on the store card.')}
        </span>
        <div className={styles.shotGrid}>
          {shots.map((s, i) => (
            <figure key={s.id} className={styles.shot}>
              <img src={storeMediaUrl(s.url) ?? ''} alt={t('plugins.listing.screenshotAlt', 'Screenshot {n}', { n: i + 1 })} />
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<Icon name="close" size="sm" />}
                disabled={busy !== null}
                className={styles.shotRemove}
                onClick={() => void run(`rm-${s.id}`, () => api.deletePluginMedia(s.id), t('plugins.listing.screenshotRemoved', 'Screenshot removed.'), t('plugins.listing.removeFailed', 'Could not remove the screenshot.'))}
              >
                {t('plugins.listing.removeScreenshot', 'Remove screenshot {n}', { n: i + 1 })}
              </Button>
            </figure>
          ))}
          {shots.length < MAX_PLUGIN_SCREENSHOTS ? (
            <label className={styles.shotAdd}>
              <Icon name="image" size="md" />
              <span>{busy === 'screenshot' ? t('plugins.listing.uploading', 'Uploading…') : t('plugins.listing.addScreenshot', 'Add screenshot')}</span>
              <input type="file" accept={IMAGE_TYPES} disabled={busy !== null} onChange={(e) => { upload('screenshot', e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          ) : null}
        </div>
      </div>

      <label className={styles.editorBlock}>
        <span className={styles.rowName}>{t('plugins.listing.about', 'About this plugin')}</span>
        <span className={styles.rowMeta}>{t('plugins.listing.aboutHint', 'Markdown. What it does, how to use it, what it is good for.')}</span>
        <textarea
          className={styles.textarea}
          rows={8}
          maxLength={MAX_ABOUT}
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder={`## ${t('plugins.listing.aboutWhat', 'What it does')}\n\n…\n\n## ${t('plugins.listing.aboutHow', 'How to use it')}\n\n1. …`}
        />
      </label>
      <div className={styles.toolbar}>
        <span className={styles.spacer} />
        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== null || about === (detail.readme ?? '')}
          onClick={() => void run('about', () => api.updatePluginListing(detail.id, { readme: about }), t('plugins.listing.aboutSaved', 'About saved.'), t('plugins.listing.aboutFailed', 'Could not save About.'))}
        >
          {busy === 'about' ? t('plugins.listing.saving', 'Saving…') : t('plugins.listing.saveAbout', 'Save About')}
        </Button>
      </div>

      {versions.length > 0 ? (
        <>
          <label className={styles.editorBlock}>
            <span className={styles.rowName}>{t('plugins.listing.releaseNotes', 'Release notes')}</span>
            <span className={styles.rowMeta}>
              {t('plugins.listing.releaseNotesHint', 'Shown as "What\'s new" and with the update offer to everyone who has an older version.')}
            </span>
            <select className={styles.select} value={notesFor} onChange={(e) => pickVersion(e.target.value)} aria-label={t('plugins.listing.version', 'Version')}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}{v.reviewStatus && v.reviewStatus !== 'approved' ? ` (${v.reviewStatus.replace('_', ' ')})` : ''}
                </option>
              ))}
            </select>
            <textarea
              className={styles.textarea}
              rows={5}
              maxLength={MAX_NOTES}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={`- ${t('plugins.listing.notesNew', 'New: …')}\n- ${t('plugins.listing.notesFixed', 'Fixed: …')}`}
            />
          </label>
          <div className={styles.toolbar}>
            <span className={styles.rowMeta}>{notes.length}/{MAX_NOTES}</span>
            <span className={styles.spacer} />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void run('notes', () => api.setPluginReleaseNotes(detail.id, notesFor, notes), t('plugins.listing.notesSaved', 'Release notes for v{version} saved.', { version: notesFor }), t('plugins.listing.notesFailed', 'Could not save the release notes.'))}
            >
              {busy === 'notes' ? t('plugins.listing.saving', 'Saving…') : t('plugins.listing.saveNotes', 'Save release notes')}
            </Button>
          </div>
        </>
      ) : null}

      {error ? <span className={styles.error} role="alert">{error}</span> : null}
      {note ? <span className={styles.text} role="status">{note}</span> : null}
    </div>
  );
}
