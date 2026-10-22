/**
 * A command's label in the UI language.
 *
 * Commands register with an English `label` from many modules, so the key is
 * derived from the stable command id — `command.<id>` — rather than written at
 * each registration. `locales/en.json` lists every registered command under
 * that namespace (see `sourceCatalogue.test.ts`), so translators see them like
 * any other string. A label that is already a `t()` getter resolves itself and
 * passes through unchanged when no `command.*` translation exists.
 *
 * Display only: search haystacks may add it, but code that keys on a label
 * (shortcut categories, recency) keeps reading `command.label`.
 */

import { t } from '@core/i18n';

export function commandLabel(command: { readonly id: unknown; readonly label: string }): string {
  return t(`command.${String(command.id)}`, command.label);
}
