/**
 * AI setup — lives in the Settings page, not a dialog.
 *
 * Two ways to power the assistant, presented as a choice:
 *   • Motion AI — our provider account, metered and billed to the user. No key
 *     to manage. (Disabled while in development; the server says so.)
 *   • Your own key — the user's OpenAI / Anthropic / Gemini account.
 *
 * A key is sent once to the backend gateway, stored encrypted against the
 * account, and used server-side when the assistant calls the provider. There is
 * no read path: what comes back is a masked hint, so this component never sees
 * a real key after saving one — and neither does any other client.
 *
 * **This file used to violate its own docstring.** `save()` mirrored the
 * plaintext key into `localStorage` and `refresh()` read it back and re-uploaded
 * it. That is removed; `core/api/purgeLocalKeys.ts` cleans up what earlier
 * builds wrote, and an ESLint rule now fails the build on any `localStorage`
 * write whose key name looks like a credential.
 *
 * Saving and removing go through `aiProviderStore`, not straight to `api`, so
 * that one place decides what a key change means for the assistant: refresh the
 * status, re-point the selection, and update the cross-launch cache. When this
 * component owned that logic, every other surface that changed a key (and the
 * assistant panel itself) saw a stale gate.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import {
  isAuthenticated,
  type AiKeyStatus,
  type AiProviderId,
  type MediaProviderId,
} from '@core/api/client';
import { keyStorageRequiresAccount, keyStorageIsPersistent } from '@core/ai/aiKeyStore';
import {
  fetchMediaKeyStatuses,
  forgetMediaKey,
  persistMediaKey,
  supportsMediaProviderLocally,
} from '@core/ai/mediaKeyStore';
import { useAiProviderStore } from '@stores/aiProviderStore';
import { useAiMediaPrefsStore } from '@stores/aiMediaPrefsStore';
import { VIDEO_MODELS } from '@motion/ai-tools';
import { t } from '@core/i18n';
import styles from './AiSettingsSection.module.css';

interface ProviderMeta {
  id: AiProviderId;
  label: string;
  /** Where a user actually gets a key — saves them a search. */
  href: string;
  placeholder: string;
}

interface MediaProviderMeta {
  id: MediaProviderId;
  label: string;
  purpose: string;
  href: string;
  placeholder: string;
}

const PROVIDERS: readonly ProviderMeta[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', href: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', href: 'https://platform.openai.com/api-keys', placeholder: 'sk-…' },
  { id: 'gemini', label: 'Gemini (Google)', href: 'https://aistudio.google.com/app/apikey', placeholder: 'AIza…' },
];

/** Video / speech / 3D — separate vault from chat LLMs. A function: `purpose` is translated at call time. */
function mediaProviders(): readonly MediaProviderMeta[] {
  return [
  {
    id: 'fal',
    label: 'fal.ai',
    purpose: t('settings.ai.purpose.video', 'Text-to-video'),
    href: 'https://fal.ai/dashboard/keys',
    placeholder: 'fal-…',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    purpose: t('settings.ai.purpose.voice', 'Voice-over'),
    href: 'https://elevenlabs.io/app/settings/api-keys',
    placeholder: 'sk_…',
  },
  {
    id: 'tripo',
    label: 'Tripo',
    purpose: t('settings.ai.purpose.model3d', 'Text-to-3D'),
    href: 'https://platform.tripo3d.ai',
    placeholder: 'tsk_…',
  },
  ];
}

const EMPTY: AiKeyStatus = { present: false, hint: '' };

/**
 * Catch a key pasted into the wrong provider's box.
 *
 * The server stores any 8+ character string it is given, so a Claude key pasted
 * under OpenAI saves cleanly, marks OpenAI "Connected", and then fails on the
 * user's first prompt with an auth error from a provider they did not think
 * they were talking to. The prefixes here are unmistakable and stable enough to
 * be worth checking; anything unrecognised is allowed through, because a key
 * format we have not seen is far more likely to be new than wrong.
 */
/**
 * Which provider a key looks like it came from, or null for "no idea".
 *
 * Ordered most-specific-first: an Anthropic key also starts with `sk-`, so the
 * `sk-ant-` test has to run before the OpenAI one or every Claude key would be
 * classified as OpenAI.
 */
function classifyKey(key: string): AiProviderId | null {
  if (/^sk-ant-/.test(key)) return 'anthropic';
  if (/^AIza/.test(key)) return 'gemini';
  if (/^sk-/.test(key)) return 'openai';
  return null;
}

export function AiSettingsSection(): JSX.Element {
  const [drafts, setDrafts] = useState<Partial<Record<AiProviderId, string>>>({});
  const videoModelId = useAiMediaPrefsStore((s) => s.videoModel);
  const setVideoModelId = useAiMediaPrefsStore((s) => s.setVideoModel);
  const [mediaDrafts, setMediaDrafts] = useState<Partial<Record<MediaProviderId, string>>>({});
  const [busy, setBusy] = useState<AiProviderId | MediaProviderId | null>(null);
  const [error, setError] = useState<string>('');
  const [mediaStatus, setMediaStatus] = useState<Partial<Record<MediaProviderId, AiKeyStatus>>>({});

  const provider = useAiProviderStore((s) => s.provider);
  const setProvider = useAiProviderStore((s) => s.setProvider);
  const models = useAiProviderStore((s) => s.models);
  const setModel = useAiProviderStore((s) => s.setModel);
  const modelsFor = useAiProviderStore((s) => s.modelsFor);
  // The store is the single copy of key state, so this panel and the assistant
  // can never disagree about which providers are connected. It used to hold its
  // own `useState` fetched separately, which is how "Connected" here and "no
  // key" in the chat could both be on screen at once.
  const status = useAiProviderStore((s) => s.status);
  const refresh = useAiProviderStore((s) => s.refreshStatus);
  const saveKey = useAiProviderStore((s) => s.saveKey);
  const clearKey = useAiProviderStore((s) => s.clearKey);

  /**
   * Whether a key saved here survives a restart.
   *
   * Always true when the backend holds it. In the local edition it depends on the
   * OS having a keystore — a Linux box with no secret service has none, and the
   * vault deliberately stores nothing rather than writing a plaintext file that
   * would look identical and protect nothing. The assistant still works for the
   * session; saying so beats letting the user wonder why they retype it every
   * morning.
   */
  const [persistent, setPersistent] = useState(true);

  const reloadMedia = useCallback(async () => {
    if (keyStorageRequiresAccount() && !isAuthenticated()) return;
    try {
      setMediaStatus(await fetchMediaKeyStatuses());
    } catch {
      setMediaStatus({});
    }
  }, []);

  const reload = useCallback(async () => {
    // No `isAuthenticated()` gate: only the SERVER edition needs a session to
    // answer this. Gating the local edition on one would mean its key status could
    // never load — there is no account to be authenticated against — so the panel
    // would sit at "not connected" with a key already in the keystore.
    if (keyStorageRequiresAccount() && !isAuthenticated()) return;
    // Whichever store this build uses is the ONLY source of key state. This used
    // to also read a plaintext `localStorage` mirror and re-upload from it — see
    // core/api/purgeLocalKeys.ts for why that is gone.
    await refresh({ force: true });
    setPersistent(await keyStorageIsPersistent());
    await reloadMedia();
  }, [refresh, reloadMedia]);

  useEffect(() => { void reload(); }, [reload]);

  // Only the server edition can be signed out of.
  if (keyStorageRequiresAccount() && !isAuthenticated()) {
    return (
      <div className={styles.section}>
        <p className={styles.intro}>
          {t('settings.ai.signIn', 'Sign in to set up the assistant.')}
        </p>
      </div>
    );
  }

  const save = async (id: AiProviderId): Promise<void> => {
    const key = (drafts[id] ?? '').trim();
    if (!key) return;
    setError('');

    const looksLike = classifyKey(key);
    if (looksLike && looksLike !== id) {
      // Refused here rather than saved and discovered at the first prompt: the
      // server takes any string, so the mistake would surface as an auth error
      // from a provider the user did not think they were using.
      setError(
        t('settings.ai.wrongProvider', "That looks like a {provider} key. Paste it in that provider's field instead.", {
          provider: PROVIDERS.find((p) => p.id === looksLike)?.label ?? looksLike,
        }),
      );
      return;
    }

    setBusy(id);
    try {
      // The store uploads it, marks the provider connected, and selects it —
      // the selection matters, because a key saved for a provider nobody is
      // pointed at leaves the assistant saying "connect a provider".
      const res = await saveKey(id, key);
      if (!res.ok) {
        setError(
          res.reason === 'unavailable'
            ? t('settings.ai.error.unavailable', 'Keys can’t be stored right now (encryption is not configured). It has NOT been saved.')
            : res.reason === 'network'
              ? t('settings.ai.error.networkSave', 'Could not reach the server to save the key.')
              : res.reason === 'unsupported'
                ? t('settings.ai.error.chatUnsupported', 'This chat provider can’t be connected in this build.')
                : t('settings.ai.error.save', 'Could not save that key.'),
        );
        return;
      }
      // NO local mirror. The key exists in this process only for the duration of
      // this call; the encrypted server store is the only copy that persists.
      // Drop the plaintext the moment it's handed off.
      setDrafts((d) => ({ ...d, [id]: '' }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: AiProviderId): Promise<void> => {
    setBusy(id);
    setError('');
    try {
      const res = await clearKey(id);
      if (!res.ok) setError(t('settings.ai.error.networkRemove', 'Could not reach the server to remove the key.'));
    } finally {
      setBusy(null);
    }
  };

  const saveMedia = async (id: MediaProviderId): Promise<void> => {
    const key = (mediaDrafts[id] ?? '').trim();
    if (!key) return;
    setError('');
    if (!supportsMediaProviderLocally(id) && keyStorageRequiresAccount() === false) {
      setError(t('settings.ai.error.mediaUnsupported', 'This media provider can’t be connected in this build.'));
      return;
    }
    setBusy(id);
    try {
      const res = await persistMediaKey(id, key);
      if (!res.ok) {
        setError(
          res.reason === 'unsupported'
            ? t('settings.ai.error.mediaUnsupported', 'This media provider can’t be connected in this build.')
            : res.reason === 'network'
              ? t('settings.ai.error.networkSave', 'Could not reach the server to save the key.')
              : t('settings.ai.error.mediaSave', 'Could not save that media key.'),
        );
        return;
      }
      setMediaDrafts((d) => ({ ...d, [id]: '' }));
      await reloadMedia();
    } finally {
      setBusy(null);
    }
  };

  const removeMedia = async (id: MediaProviderId): Promise<void> => {
    setBusy(id);
    setError('');
    try {
      await forgetMediaKey(id);
      await reloadMedia();
    } finally {
      setBusy(null);
    }
  };

  const runsLocally = !keyStorageRequiresAccount();

  return (
    <div className={styles.section}>
      <p className={styles.intro}>
        {t(
          'settings.ai.intro',
          'Connect your own AI API keys (Anthropic, OpenAI, or Gemini). Your prompts go straight to your provider account with no added fees.',
        )}
      </p>

      {/*
        How the key is protected, said plainly, because the two editions protect
        it in genuinely different places and a security-minded user will want to
        know which. The claim is the same in both — the key never lives in the
        renderer where a page bug or DevTools could read it.
      */}
      <p className={styles.subtle}>
        {runsLocally
          ? t('settings.ai.protectedLocal', 'Your key is encrypted with your operating system’s keystore and never leaves this device.')
          : t('settings.ai.protectedServer', 'Your key is encrypted on our server and never sent back to any app.')}
      </p>

      {/*
        The honest local-edition caveat: no OS keystore means no persistence. The
        assistant works this session; the key is forgotten on quit. Only shown
        when it is actually true, so it does not nag the vast majority for whom it
        is not.
      */}
      {runsLocally && !persistent && (
        <p className={styles.warning}>
          {t(
            'settings.ai.noKeystore',
            'This device has no secure keystore, so a key you add will work now but be forgotten when you quit. You’ll re-enter it next launch.',
          )}
        </p>
      )}

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.providers}>
        {PROVIDERS.map((p) => {
          const s = status?.[p.id] ?? EMPTY;
            const draft = drafts[p.id] ?? '';
            const isActive = provider === p.id;
            return (
              <div
                key={p.id}
                className={`${styles.row} ${s.present ? styles.rowConnected : ''} ${
                  isActive && s.present ? styles.rowOn : ''
                }`}
              >
                <div className={styles.rowInfo}>
                  <span className={styles.rowLabel}>
                    <Icon name={s.present ? 'lock' : 'keyframe'} size="md" className={s.present ? styles.lockIconSecure : styles.lockIconInactive} />
                    {p.label}
                  </span>
                  {s.present ? (
                    <span className={styles.hint} title={t('settings.ai.encryptedAtRest', 'Encrypted at rest')}>
                      {t('settings.ai.connected', 'Connected · {hint}', { hint: s.hint || '••••' })}
                    </span>
                  ) : (
                    <span className={styles.notConnectedHint}>{t('settings.ai.notConfigured', 'Not configured')}</span>
                  )}
                </div>

                <div className={styles.rowRight}>
                  {s.present ? (
                    <>
                      <select
                        className={styles.select}
                        aria-label={t('settings.ai.modelAria', '{provider} model', { provider: p.label })}
                        value={models[p.id] ?? ''}
                        onChange={(e) => setModel(p.id, e.target.value)}
                      >
                        <option value="">{t('settings.ai.defaultModel', 'Default Model')}</option>
                        {modelsFor(p.id).map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                      {isActive ? (
                        <span className={styles.activeMark}>
                          <span className={styles.greenDot} /> {t('settings.ai.active', 'Active')}
                        </span>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => setProvider(p.id)}>
                          {t('settings.ai.useThis', 'Use this')}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" disabled={busy === p.id} onClick={() => void remove(p.id)}>
                        {t('settings.ai.remove', 'Remove')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <input
                        type="password"
                        className={styles.input}
                        value={draft}
                        placeholder={p.placeholder}
                        aria-label={t('settings.ai.keyAria', '{provider} API key', { provider: p.label })}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') void save(p.id); }}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!draft.trim() || busy === p.id}
                        onClick={() => void save(p.id)}
                      >
                        {t('settings.ai.save', 'Save')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          <p className={styles.links}>
            {t('settings.ai.chatKeysLinks', 'Chat keys power the assistant’s planning. Get a key:')} {PROVIDERS.map((p, i) => (
              <span key={p.id}>
                {i > 0 ? ' · ' : ''}
                <a href={p.href} target="_blank" rel="noreferrer">{p.label.split(' ')[0]}</a>
              </span>
            ))}
          </p>
        </div>

      <p className={styles.intro} style={{ marginTop: 8 }}>
        {/* Placeholders are split out so the tool names keep their <code> styling in any word order. */}
        {t(
          'settings.ai.mediaIntro',
          'Media generation (video, voice, 3D) uses separate keys. These are only spent when the assistant calls {video}, {speech}, or {model3d}.',
        )
          .split(/(\{video\}|\{speech\}|\{model3d\})/)
          .map((part, i) =>
            part === '{video}' ? (
              <code key={i}>generate_video</code>
            ) : part === '{speech}' ? (
              <code key={i}>generate_speech</code>
            ) : part === '{model3d}' ? (
              <code key={i}>generate_3d_model</code>
            ) : (
              part
            ),
          )}
      </p>

      <div className={styles.providers}>
        {mediaProviders().map((p) => {
          const s = mediaStatus[p.id] ?? EMPTY;
          const draft = mediaDrafts[p.id] ?? '';
          return (
            <div
              key={p.id}
              className={`${styles.row} ${s.present ? styles.rowConnected : ''}`}
            >
              <div className={styles.rowInfo}>
                <span className={styles.rowLabel}>
                  <Icon name={s.present ? 'lock' : 'keyframe'} size="md" className={s.present ? styles.lockIconSecure : styles.lockIconInactive} />
                  {p.label}
                </span>
                {s.present ? (
                  <span className={styles.hint} title={t('settings.ai.encryptedAtRest', 'Encrypted at rest')}>
                    {t('settings.ai.mediaConnected', 'Connected · {purpose} · {hint}', { purpose: p.purpose, hint: s.hint || '••••' })}
                  </span>
                ) : (
                  <span className={styles.notConnectedHint}>
                    {t('settings.ai.mediaNotConfigured', '{purpose} · Not configured', { purpose: p.purpose })}
                  </span>
                )}
              </div>
              <div className={styles.rowRight}>
                {s.present ? (
                  <Button variant="ghost" size="sm" disabled={busy === p.id} onClick={() => void removeMedia(p.id)}>
                    {t('settings.ai.remove', 'Remove')}
                  </Button>
                ) : (
                  <>
                    <input
                      type="password"
                      className={styles.input}
                      value={draft}
                      placeholder={p.placeholder}
                      aria-label={t('settings.ai.keyAria', '{provider} API key', { provider: p.label })}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setMediaDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') void saveMedia(p.id); }}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!draft.trim() || busy === p.id}
                      onClick={() => void saveMedia(p.id)}
                    >
                      {t('settings.ai.save', 'Save')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* What generate_video uses when a call names no model. Free preview
            by default: footage costs money per clip, so spending starts only
            when someone picks a paid model here. */}
        <div className={styles.row}>
          <div className={styles.rowInfo}>
            <span className={styles.rowLabel}>{t('settings.ai.defaultVideoModel', 'Default video model')}</span>
            <span className={styles.hint}>
              {VIDEO_MODELS.find((m) => m.id === videoModelId)?.note ?? ''}
              {VIDEO_MODELS.find((m) => m.id === videoModelId)?.paid && !(mediaStatus.fal ?? EMPTY).present ? ` ${t('settings.ai.needsFal', 'Needs a fal.ai key.')}` : ''}
            </span>
          </div>
          <div className={styles.rowRight}>
            <select
              className={styles.select}
              aria-label={t('settings.ai.defaultVideoModel', 'Default video model')}
              value={videoModelId}
              onChange={(e) => setVideoModelId(e.target.value)}
            >
              {VIDEO_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>

        <p className={styles.links}>
          {t('settings.ai.mediaKeysLinks', 'Get a media key:')} {mediaProviders().map((p, i) => (
            <span key={p.id}>
              {i > 0 ? ' · ' : ''}
              <a href={p.href} target="_blank" rel="noreferrer">{p.label}</a>
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

export default AiSettingsSection;
