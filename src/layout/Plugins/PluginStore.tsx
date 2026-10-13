/**
 * The plugin store: browse native plugins, read one, install it.
 *
 * Built to be read before anything is installed: a Free account cannot run a
 * Premation Cloud plugin, so the card and the page have to show what it does —
 * cover image, icon, screenshots, About, what changed in each version — and
 * say plainly that it comes with Premation Cloud, with the way to get it.
 *
 * Installing is Electron main's job — it downloads, checks the hash and the
 * publisher signature, and stages the bundle — then the engine rescans and the
 * effects appear in the Effects panel with no restart (docs/PLUGIN_STORE.md §4).
 */

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Badge } from '@components/Badge';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Modal } from '@components/Modal';
import { SearchField } from '@components/SearchField';
import {
  api,
  storeMediaUrl,
  type StorePluginDetail,
  type StorePluginSummary,
  type StorePluginVersion,
} from '@core/api/client';
import { billingEnabled, cloudProjectsEnabled } from '@core/config/edition';
import { canInstallFromStore, compareVersions, hostPlatformKeys, runsHere } from '@core/nativePlugins/pluginStore';
import type { InstalledState } from '@hooks/usePluginStore';
import { useStoreBrowse } from '@hooks/usePluginStore';
import { useEntitlementStore } from '@stores/entitlementStore';
import { PluginIcon } from './PluginIcon';
import { PluginListingEditor } from './PluginListingEditor';
import styles from './NativePlugins.module.css';

/**
 * Whether this account can run Premation Cloud plugins: true / false once the
 * server's decision is cached, null while unknown (signed out, local edition,
 * not fetched yet) — unknown never hides the Install button; the store's 402
 * still answers for it.
 */
function useHasCloudPlugins(): boolean | null {
  const access = useEntitlementStore((s) => s.access);
  const refresh = useEntitlementStore((s) => s.refresh);
  useEffect(() => {
    if (!access) void refresh();
  }, [access, refresh]);
  if (!billingEnabled() || !access) return null;
  return access.plan === 'pro';
}

/**
 * Billing lives on the dashboard, which only the cloud edition registers.
 * Through the hash (AppRouter is a HashRouter) so the store also works where it
 * is rendered outside a router.
 */
function useOpenBilling(): (() => void) | null {
  if (!billingEnabled() || !cloudProjectsEnabled()) return null;
  return () => { window.location.hash = '#/dashboard?tab=billing'; };
}

function TierBadge({ plugin }: { plugin: StorePluginSummary }): JSX.Element {
  return plugin.tier === 'cloud' ? (
    <Badge variant="accent" size="sm" className={styles.inlineBadge}>Premation Cloud</Badge>
  ) : (
    <Badge variant="neutral" size="sm" className={styles.inlineBadge}>Free</Badge>
  );
}

function InstallButton({
  plugin,
  store,
  owner,
  hasCloud,
}: {
  plugin: StorePluginSummary;
  store: InstalledState;
  owner?: boolean;
  hasCloud: boolean | null;
}): JSX.Element {
  const openBilling = useOpenBilling();
  const here = hostPlatformKeys();
  const mine = store.installed?.plugins[plugin.id];
  const busy = store.busy === plugin.id;
  if (!canInstallFromStore()) return <span className={styles.status}>Desktop app only</span>;
  if (here && !runsHere(plugin.platforms, here)) {
    return <span className={styles.status} title={`Ships for: ${plugin.platforms.join(', ') || 'no platform'}`}>Not for this computer</span>;
  }
  if (mine && compareVersions(mine.version, plugin.latestVersion) >= 0) {
    return <span className={styles.statusLoaded}>{mine.pending ? 'Restart to finish' : 'Installed'}</span>;
  }
  // The publisher can always install their own; anyone else on Free is shown the way to get it.
  if (plugin.tier === 'cloud' && hasCloud === false && !owner) {
    return openBilling ? (
      <Button size="sm" variant="primary" leftIcon={<Icon name="lock" size="sm" />} onClick={openBilling}>
        Get Premation Cloud
      </Button>
    ) : (
      <span className={styles.status}>Premation Cloud</span>
    );
  }
  return (
    <Button
      size="sm"
      variant={mine ? 'secondary' : 'primary'}
      disabled={busy || store.busy !== null}
      onClick={() => void store.install(plugin.id, plugin.latestVersion, owner)}
    >
      {busy ? 'Installing…' : mine ? `Update to ${plugin.latestVersion}` : 'Install'}
    </Button>
  );
}

function PublisherLine({ plugin }: { plugin: StorePluginSummary }): JSX.Element {
  const name = plugin.publisher.displayName || plugin.publisher.namespace;
  return (
    <span className={styles.rowMeta}>
      {[name || null, `v${plugin.latestVersion}`, plugin.installs ? `${plugin.installs.toLocaleString()} installs` : null]
        .filter(Boolean)
        .join(' · ')}
      {plugin.publisher.verified ? (
        <Badge variant="success" size="sm" className={styles.inlineBadge}>Verified</Badge>
      ) : null}
      {plugin.visibility === 'private' ? <Badge variant="neutral" size="sm" className={styles.inlineBadge}>Private</Badge> : null}
    </span>
  );
}

/** Why Premation Cloud, on a Cloud plugin's page — shown to anyone who does not have it yet. */
function CloudPitch({ plugin }: { plugin: StorePluginSummary }): JSX.Element {
  const openBilling = useOpenBilling();
  return (
    <div className={styles.pitch}>
      <Icon name="sparkles" size="md" className={styles.pitchIcon} />
      <div className={styles.pitchBody}>
        <strong>{plugin.name} comes with Premation Cloud</strong>
        <span>
          Premation Cloud includes every Premation plugin, unlimited cloud projects and 90 days of version history.
          Plugins run on your computer; you keep your projects if you stop.
        </span>
      </div>
      {openBilling ? (
        <Button size="sm" variant="primary" onClick={openBilling}>
          See plans
        </Button>
      ) : null}
    </div>
  );
}

function Gallery({ shots, name }: { shots: NonNullable<StorePluginDetail['screenshots']>; name: string }): JSX.Element | null {
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const current = shots[Math.min(active, shots.length - 1)];
  if (!current) return null;
  const src = storeMediaUrl(current.url) ?? '';
  return (
    <div className={styles.gallery}>
      <button type="button" className={styles.galleryMain} onClick={() => setZoom(true)} aria-label={`Enlarge screenshot ${active + 1} of ${name}`}>
        <img src={src} alt={`${name} — screenshot ${active + 1}`} />
      </button>
      {shots.length > 1 ? (
        <div className={styles.galleryThumbs} role="tablist" aria-label="Screenshots">
          {shots.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={i === active ? styles.galleryThumbActive : styles.galleryThumb}
              onClick={() => setActive(i)}
            >
              <img src={storeMediaUrl(s.url) ?? ''} alt={`Screenshot ${i + 1}`} />
            </button>
          ))}
        </div>
      ) : null}
      <Modal open={zoom} onClose={() => setZoom(false)} size="fullscreen" title={name}>
        <img className={styles.galleryZoom} src={src} alt={`${name} — screenshot ${active + 1}`} />
      </Modal>
    </div>
  );
}

function ReleaseNotes({ text }: { text: string }): JSX.Element {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}

function Versions({ versions, owner }: { versions: StorePluginVersion[]; owner?: boolean }): JSX.Element | null {
  if (versions.length === 0) return null;
  return (
    <ul className={styles.versions} aria-label="Versions">
      {versions.map((v, i) => (
        <li key={v.version}>
          <details open={i === 0 && !!v.releaseNotes}>
            <summary>
              <span className={styles.versionName}>v{v.version}</span>
              <span className={styles.rowMeta}>{new Date(v.createdAt).toLocaleDateString()}</span>
              {owner && v.reviewStatus && v.reviewStatus !== 'approved' ? (
                <Badge variant="warning" size="sm" className={styles.inlineBadge}>{v.reviewStatus.replace('_', ' ')}</Badge>
              ) : null}
            </summary>
            {v.releaseNotes ? <ReleaseNotes text={v.releaseNotes} /> : <span className={styles.text}>No release notes.</span>}
          </details>
        </li>
      ))}
    </ul>
  );
}

export function StorePluginDetailCard({
  id,
  owner,
  store,
  onBack,
}: {
  id: string;
  owner?: boolean;
  store: InstalledState;
  onBack: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<StorePluginDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const hasCloud = useHasCloudPlugins();
  useEffect(() => {
    let alive = true;
    (owner ? api.myPluginDetail(id) : api.storePluginDetail(id))
      .then((d) => { if (alive) setDetail(d); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load the plugin.'); });
    return () => { alive = false; };
  }, [id, owner, revision]);

  const versions = detail?.versionHistory ?? [];
  const shots = (detail?.screenshots ?? []).slice(0, 3);
  const about = detail?.readme?.trim() || '';

  return (
    <section className={styles.card} aria-label="Plugin details">
      <div className={styles.toolbar}>
        <Button variant="ghost" size="sm" leftIcon={<Icon name="chevron-left" size="sm" />} onClick={onBack}>
          All plugins
        </Button>
      </div>
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
      {!detail && !error ? <span className={styles.text} role="status">Loading…</span> : null}
      {detail ? (
        <>
          <div className={styles.detailHead}>
            <PluginIcon plugin={detail} size={64} />
            <div className={styles.rowBody}>
              <h3 className={styles.detailTitle}>
                {detail.name}
                <TierBadge plugin={detail} />
              </h3>
              <PublisherLine plugin={detail} />
              <p className={styles.text}>{detail.description}</p>
            </div>
            <InstallButton plugin={detail} store={store} owner={owner} hasCloud={hasCloud} />
          </div>
          {detail.blocked ? (
            <span className={styles.error} role="alert">Withdrawn{detail.blockedReason ? `: ${detail.blockedReason}` : ''}</span>
          ) : null}
          {detail.tier === 'cloud' && hasCloud !== true && !owner ? <CloudPitch plugin={detail} /> : null}

          <Gallery shots={shots} name={detail.name} />

          {detail.whatsNew ? (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>What&apos;s new in v{detail.whatsNew.version}</h4>
              <ReleaseNotes text={detail.whatsNew.releaseNotes} />
            </div>
          ) : null}

          {about ? (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>About</h4>
              <div className={styles.markdown}>
                <ReactMarkdown>{about}</ReactMarkdown>
              </div>
            </div>
          ) : null}

          {detail.effects.length > 0 ? (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>What it adds</h4>
              <div className={styles.chips}>
                {detail.effects.map((e) => (
                  <span key={e.matchName} className={styles.chip} title={e.category}>{e.name}</span>
                ))}
              </div>
            </div>
          ) : null}

          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>Details</h4>
            <dl className={styles.facts}>
              <dt>Runs on</dt>
              <dd>{detail.platforms.join(', ') || '—'}</dd>
              <dt>Built for SDK</dt>
              <dd>{detail.sdk ? `${detail.sdk.major}.${detail.sdk.minor}` : '—'}</dd>
              <dt>Price</dt>
              <dd>{detail.tier === 'cloud' ? 'Included with Premation Cloud' : 'Free'}</dd>
              <dt>Licence</dt>
              <dd>{detail.license ?? '—'}</dd>
              {detail.categories.length > 0 ? (
                <>
                  <dt>Categories</dt>
                  <dd>{detail.categories.join(', ')}</dd>
                </>
              ) : null}
              {detail.homepage ? (
                <>
                  <dt>Homepage</dt>
                  <dd className={styles.path}>{detail.homepage}</dd>
                </>
              ) : null}
              <dt>Updated</dt>
              <dd>{new Date(detail.updatedAt).toLocaleDateString()}</dd>
            </dl>
          </div>

          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>Versions</h4>
            <Versions versions={versions} owner={owner} />
            {versions.length === 0 ? <span className={styles.text}>v{detail.latestVersion}</span> : null}
            {detail.changelog?.trim() && !versions.some((v) => v.releaseNotes) ? (
              <pre className={styles.changelog}>{detail.changelog}</pre>
            ) : null}
          </div>

          {owner ? <PluginListingEditor detail={detail} onChanged={() => setRevision((r) => r + 1)} /> : null}

          <p className={styles.text}>
            Plugins run inside the Premation engine on this computer, with the same access as Premation itself.
            The package is checked against the publisher&apos;s signature before it is installed.
          </p>
        </>
      ) : null}
    </section>
  );
}

function PluginCard({
  plugin,
  store,
  owner,
  hasCloud,
  onOpen,
}: {
  plugin: StorePluginSummary;
  store: InstalledState;
  owner: boolean;
  hasCloud: boolean | null;
  onOpen: () => void;
}): JSX.Element {
  const here = hostPlatformKeys();
  const cover = storeMediaUrl(plugin.coverUrl);
  return (
    <li className={styles.storeCard}>
      <button type="button" className={styles.storeCardOpen} onClick={onOpen} aria-label={`About ${plugin.name}`}>
        <span className={styles.storeCover}>
          {cover ? <img src={cover} alt="" loading="lazy" /> : <PluginIcon plugin={plugin} size={56} />}
        </span>
        <span className={styles.storeCardHead}>
          <PluginIcon plugin={plugin} size={32} />
          <span className={styles.rowBody}>
            <span className={styles.rowName} title={plugin.name}>{plugin.name}</span>
            <PublisherLine plugin={plugin} />
          </span>
        </span>
        <span className={styles.storeCardText}>
          {plugin.description}
          {here && !runsHere(plugin.platforms, here) ? ' — not available for this computer' : ''}
        </span>
      </button>
      <span className={styles.storeCardFoot}>
        <TierBadge plugin={plugin} />
        <span className={styles.spacer} />
        <InstallButton plugin={plugin} store={store} owner={owner} hasCloud={hasCloud} />
      </span>
    </li>
  );
}

export function PluginStoreBrowser({ store }: { store: InstalledState }): JSX.Element {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [tier, setTier] = useState<'all' | 'free' | 'cloud'>('all');
  const browse = useStoreBrowse(q);
  const hasCloud = useHasCloudPlugins();
  const items = useMemo(
    () => (browse.items ?? []).filter((p) => tier === 'all' || p.tier === tier),
    [browse.items, tier],
  );

  // The publisher's own private plugins (listed from `/plugins/mine`) read and install as the owner.
  if (open) return <StorePluginDetailCard id={open} owner={browse.owned.has(open)} store={store} onBack={() => setOpen(null)} />;
  return (
    <section className={styles.card} aria-label="Plugin store">
      <div className={styles.toolbar}>
        <h3 className={styles.cardTitle}>Plugin store</h3>
        <span className={styles.spacer} />
        <Button variant="ghost" size="sm" leftIcon={<Icon name="refresh" size="sm" />} disabled={browse.loading} onClick={browse.reload}>
          Refresh
        </Button>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.grow}>
          <SearchField value={q} onChange={setQ} placeholder="Search plugins" ariaLabel="Search the plugin store" debounceMs={250} fullWidth />
        </div>
        <div className={styles.filterChips} role="group" aria-label="Price">
          {(['all', 'free', 'cloud'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={tier === t ? styles.filterChipActive : styles.filterChip}
              aria-pressed={tier === t}
              onClick={() => setTier(t)}
            >
              {t === 'all' ? 'All' : t === 'free' ? 'Free' : 'Premation Cloud'}
            </button>
          ))}
        </div>
      </div>
      {browse.error ? <span className={styles.error} role="alert">{browse.error}</span> : null}
      {browse.items && items.length === 0 ? (
        <div className={styles.empty} role="status">
          <strong>{q || tier !== 'all' ? 'No plugins match' : 'No plugins yet'}</strong>
          <span>Publish one with the SDK — see docs/PLUGIN_SDK.md.</span>
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className={styles.storeGrid} aria-label="Store plugins">
          {items.map((p) => (
            <PluginCard
              key={p.id}
              plugin={p}
              store={store}
              owner={browse.owned.has(p.id)}
              hasCloud={hasCloud}
              onOpen={() => setOpen(p.id)}
            />
          ))}
        </ul>
      ) : null}
      {!browse.items && !browse.error ? <span className={styles.text} role="status">Asking the store…</span> : null}
    </section>
  );
}
