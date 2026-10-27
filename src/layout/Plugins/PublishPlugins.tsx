/**
 * Publishing: the signed-in user's own plugins, public or private, and a
 * form to upload a new version.
 *
 * The package is packed and signed OUTSIDE the editor
 * (`scripts/pack-plugin.mjs --key`, or the CI template in examples/plugin-ci):
 * the signing key never enters the app. This form uploads the `.pplugin` with
 * its `.sig` file. Private plugins install only for their publisher; making a
 * plugin public needs a verified publisher (the store refuses otherwise).
 * Release notes go up with the version; icon, screenshots and About are edited
 * on the plugin's page (PluginListingEditor), outside the signed package.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Segmented } from '@components/Segmented';
import { api, type StorePluginSummary } from '@core/api/client';
import type { InstalledState } from '@hooks/usePluginStore';
import { useCachedQuery } from '@hooks/useCachedQuery';
import { PluginIcon } from './PluginIcon';
import { StorePluginDetailCard } from './PluginStore';
import styles from './NativePlugins.module.css';
import { t } from '@core/i18n';

type Visibility = 'public' | 'private';

function visibilityOptions(): { value: Visibility; label: string }[] {
  return [
    { value: 'private', label: t('plugins.publish.private', 'Private') },
    { value: 'public', label: t('plugins.publish.public', 'Public') },
  ];
}

/** `{signature, publicKey}` from the `.sig` file pack-plugin.mjs writes. */
export function parseSignatureFile(text: string): { signature: string; publicKey: string } | null {
  try {
    const j = JSON.parse(text) as { signature?: unknown; publicKey?: unknown };
    if (typeof j.signature === 'string' && typeof j.publicKey === 'string' && j.signature && j.publicKey) {
      return { signature: j.signature, publicKey: j.publicKey };
    }
  } catch {
    // not JSON
  }
  return null;
}

export function PublishPlugins({ store }: { store: InstalledState }): JSX.Element {
  // Remembered across visits (useCachedQuery); publishing or a visibility
  // change invalidates `plugins`, which refetches both.
  const mineQuery = useCachedQuery('plugins:mine', api.myPlugins, { tags: ['plugins'] });
  const publishersQuery = useCachedQuery('plugins:publishers', api.myPublishers, { tags: ['plugins'] });
  const mine: Array<StorePluginSummary & { visibility: Visibility }> | null =
    mineQuery.data?.filter((p) => p.kind === 'native') ?? null;
  const verified: boolean | null = publishersQuery.data
    ? publishersQuery.data.some((p) => p.verified)
    : publishersQuery.error
      ? false
      : null;
  const [actionError, setError] = useState<string | null>(null);
  const error =
    actionError ??
    (mineQuery.data || !mineQuery.error ? null : t('plugins.publish.signIn', 'Sign in to publish plugins.'));
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pkg, setPkg] = useState<File | null>(null);
  const [sig, setSig] = useState<{ signature: string; publicKey: string } | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const reloadMine = mineQuery.reload;
  const reloadPublishers = publishersQuery.reload;
  const load = useCallback(() => {
    void reloadMine();
    void reloadPublishers();
  }, [reloadMine, reloadPublishers]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const changeVisibility = async (id: string, v: Visibility): Promise<void> => {
    setError(null);
    try {
      await api.setPluginVisibility(id, v);
      setNote(v === 'public'
        ? t('plugins.publish.nowPublic', '{id} is now public.', { id })
        : t('plugins.publish.nowPrivate', '{id} is now private.', { id }));
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('plugins.publish.visibilityFailed', 'Could not change the visibility.'));
    }
  };

  const publish = async (): Promise<void> => {
    if (!pkg || !sig) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const out = await api.publishPlugin(pkg, sig.signature, sig.publicKey, visibility, releaseNotes);
      const published = out.reviewStatus === 'pending'
        ? t('plugins.publish.publishedPending', 'Published {id} {version} — held for review before it goes live.', { id: out.id, version: out.latestVersion })
        : t('plugins.publish.published', 'Published {id} {version}.', { id: out.id, version: out.latestVersion });
      setNote(
        out.warnings.length
          ? t('plugins.publish.withWarnings', '{message} Warnings: {warnings}', { message: published, warnings: out.warnings.join('; ') })
          : published,
      );
      setPkg(null);
      setSig(null);
      setReleaseNotes('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('plugins.publish.uploadFailed', 'The upload failed.'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (open) return <StorePluginDetailCard id={open} owner store={store} onBack={() => setOpen(null)} />;

  return (
    <section className={styles.card} aria-label={t('plugins.publish.yourPlugins', 'Your plugins')}>
      <h3 className={styles.cardTitle}>{t('plugins.publish.yourPlugins', 'Your plugins')}</h3>
      {verified === false ? (
        <p className={styles.text}>
          {t('plugins.publish.notVerified', 'Your publisher is not verified yet, so your plugins can be private (installable by you) but not public.')}
        </p>
      ) : null}
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
      {note ? <span className={styles.text} role="status">{note}</span> : null}
      {mine && mine.length > 0 ? (
        <ul className={styles.list} aria-label={t('plugins.publish.publishedListAria', 'Your published plugins')}>
          {mine.map((p) => (
            <li key={p.id} className={styles.row}>
              <PluginIcon plugin={p} size={32} />
              <button type="button" className={styles.rowOpen} onClick={() => setOpen(p.id)} aria-label={t('plugins.publish.aboutPlugin', 'About {name}', { name: p.name })}>
                <span className={styles.rowName}>{p.name}</span>
                <span className={styles.rowMeta}>
                  {t('plugins.publish.rowMeta', 'v{version} · {n} installs · {tier}', {
                    version: p.latestVersion,
                    n: p.installs,
                    tier: p.tier === 'cloud' ? 'Premation Cloud' : t('plugins.publish.free', 'Free'),
                  })}
                </span>
                <span className={styles.rowMeta}>
                  {p.iconUrl && p.coverUrl
                    ? t('plugins.publish.listingSet', 'Listing: icon and screenshots set')
                    : t('plugins.publish.listingOpen', 'Open to add an icon, screenshots and About')}
                </span>
              </button>
              <Segmented
                size="sm"
                options={visibilityOptions()}
                value={p.visibility}
                onChange={(v) => void changeVisibility(p.id, v)}
                aria-label={t('plugins.publish.visibilityOf', 'Visibility of {name}', { name: p.name })}
              />
            </li>
          ))}
        </ul>
      ) : mine ? (
        <span className={styles.text}>{t('plugins.publish.noneYet', 'You have not published a native plugin yet.')}</span>
      ) : null}

      <h3 className={styles.cardTitle}>{t('plugins.publish.publishVersion', 'Publish a version')}</h3>
      <p className={styles.text}>
        {t(
          'plugins.publish.howTo',
          'Pack and sign the plugin with {command} (it ships with the SDK), then choose the .pplugin and its .sig file here.',
          { command: 'pack-plugin.mjs --key plugin-key.json' },
        )}
      </p>
      <div className={styles.toolbar}>
        <label className={styles.fileLabel}>
          <span>{t('plugins.publish.package', 'Package (.pplugin)')}</span>
          <input type="file" accept=".pplugin,application/zip" onChange={(e) => setPkg(e.target.files?.[0] ?? null)} />
        </label>
        <label className={styles.fileLabel}>
          <span>{t('plugins.publish.signature', 'Signature (.sig)')}</span>
          <input
            type="file"
            accept=".sig,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) { setSig(null); return; }
              void f.text().then((text) => {
                const parsed = parseSignatureFile(text);
                setSig(parsed);
                if (!parsed) setError(t('plugins.publish.badSignature', 'That signature file is not one pack-plugin.mjs wrote.'));
              });
            }}
          />
        </label>
      </div>
      <label className={styles.editorBlock}>
        <span className={styles.rowName}>{t('plugins.publish.releaseNotes', 'Release notes for this version')}</span>
        <span className={styles.rowMeta}>
          {t(
            'plugins.publish.releaseNotesHint',
            'Optional, Markdown. Shown as "What\'s new" and with the update offer. The version number comes from the package and must be higher than the one already published.',
          )}
        </span>
        <textarea
          className={styles.textarea}
          rows={4}
          maxLength={5000}
          value={releaseNotes}
          onChange={(e) => setReleaseNotes(e.target.value)}
          placeholder={`- ${t('plugins.listing.notesNew', 'New: …')}\n- ${t('plugins.listing.notesFixed', 'Fixed: …')}`}
        />
      </label>
      <div className={styles.toolbar}>
        <Segmented size="sm" options={visibilityOptions()} value={visibility} onChange={setVisibility} aria-label={t('plugins.publish.newVisibility', 'Visibility of the new version')} />
        <span className={styles.spacer} />
        <Button variant="primary" size="sm" leftIcon={<Icon name="upload" size="sm" />} disabled={!pkg || !sig || busy} onClick={() => void publish()}>
          {busy ? t('plugins.publish.uploading', 'Uploading…') : t('plugins.publish.publish', 'Publish')}
        </Button>
      </div>
    </section>
  );
}
