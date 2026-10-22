/**
 * The consent dialog a user script waits on before it runs (the app's
 * `setScriptConsentPrompt`, core/scripting/scriptHost.ts): the script's name
 * and what it asks for — read the document, change it — with Allow Once and
 * Cancel. Built like the stock dialogs (components/Modal/Dialogs.tsx): the
 * modal's footer slot from `DialogFooter`, the way out on the left.
 *
 * Nothing is remembered: every run asks, as a plugin's install consent does.
 * A dismissed dialog (Esc, ×) is a refusal.
 */

import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { DialogFooter } from '@components/Modal';
import { setScriptConsentPrompt, type ScriptConsentRequest } from '@core/scripting/scriptHost';
import type { ScriptPermission } from '@core/scripting/protocol';
import { t } from '@core/i18n';
import styles from './ScriptEditorPanel.module.css';

function permissionText(p: ScriptPermission): { title: string; detail: string } {
  switch (p) {
    case 'document.read':
      return {
        title: t('scripts.consent.read', 'Read the project'),
        detail: t('scripts.consent.readDetail', 'Compositions, layers, properties, keyframes and expressions.'),
      };
    case 'document.write':
      return {
        title: t('scripts.consent.write', 'Change the project'),
        detail: t('scripts.consent.writeDetail', 'Every change lands in one undo step; a script that fails changes nothing.'),
      };
  }
}

/** Ask the user whether `req` may run. Resolves false when dismissed. */
export function askScriptConsent(req: ScriptConsentRequest): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value: boolean, close: () => void): void => {
      resolved = true;
      close();
      resolve(value);
    };
    openModal({
      title: t('scripts.consent.title', 'Run “{name}”?', { name: req.name }),
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      },
      render: () => (
        <div className={styles.consent}>
          <p className={styles.consentMessage}>
            {t('scripts.consent.message', 'This script runs in a sandbox with no file or network access. It asks to:')}
          </p>
          <ul className={styles.consentList}>
            {(req.permissions.length > 0 ? req.permissions : (['document.read'] as const)).map((p) => {
              const text = permissionText(p);
              return (
                <li key={p} className={styles.consentItem}>
                  <span className={styles.consentItemTitle}>{text.title}</span>
                  <span className={styles.consentItemDetail}>{text.detail}</span>
                </li>
              );
            })}
          </ul>
          <p className={styles.consentNote}>{t('scripts.consent.note', 'Only run scripts you trust.')}</p>
        </div>
      ),
      footer: (close) => (
        <DialogFooter
          secondary={<Button variant="ghost" onClick={() => settle(false, close)}>{t('ui.modal.cancel', 'Cancel')}</Button>}
          primary={<Button variant="primary" onClick={() => settle(true, close)}>{t('scripts.consent.allowOnce', 'Allow Once')}</Button>}
        />
      ),
    });
  });
}

let installed = false;

/** Register the dialog as the app's script consent prompt (idempotent). */
export function installScriptConsentPrompt(): void {
  if (installed) return;
  installed = true;
  setScriptConsentPrompt(askScriptConsent);
}
