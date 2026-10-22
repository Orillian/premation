/**
 * Text utility commands — Find and Replace Text, Find and Replace Fonts,
 * Create Masks from Text, and the Source Text expression editor.
 *
 * Registered from this directory rather than the app's boot block, the
 * `timelineFitCommands` pattern: the dialogs, the core modules and the
 * commands ship as one unit. Installed from `installOverlayCommands`
 * (ModalHost, mounted once), which also arms the missing-font check on
 * project open and binds the Source Text provider.
 *
 * Menu rows wanted in `menuModel.ts` (not edited here):
 *   Edit ▸  { commandId: 'text.findReplace',           label: 'Find and Replace Text…' }   Ctrl/Cmd+Shift+H
 *   Edit ▸  { commandId: 'text.replaceFonts',          label: 'Find and Replace Fonts…' }
 *   Layer ▸ Create ▸ { commandId: 'layer.masksFromText', label: 'Create Masks from Text' }  (beside layer.shapesFromText)
 *   Animation ▸ { commandId: 'text.sourceTextExpression', label: 'Source Text Expression…' }
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { documentMirror } from '@stores/documentMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { canOutlineText } from './textMirror';
import { masksFromTextEdit } from './textEdits';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { openFindReplaceTextDialog } from './FindReplaceTextDialog';
import { openFindAndReplaceFonts } from './ReplaceFontsDialog';
import { openSourceTextExpressionEditor } from './SourceTextExpressionDialog';
import { installMissingFontsWatcher } from './missingFontsWatcher';
import { t } from '@core/i18n';

export const TEXT_FIND_REPLACE_COMMAND = asCommandId('text.findReplace');
export const TEXT_REPLACE_FONTS_COMMAND = asCommandId('text.replaceFonts');
export const LAYER_MASKS_FROM_TEXT_COMMAND = asCommandId('layer.masksFromText');
export const TEXT_SOURCE_EXPRESSION_COMMAND = asCommandId('text.sourceTextExpression');

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 2600 });
}

/** The one selected layer, when it is a text layer. */
function selectedTextLayer(): string | null {
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 1) return null;
  const id = ids[0]!;
  return uiKindOf(documentMirror().layer(id)) === 'text' ? id : null;
}

export function buildTextToolCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TEXT_FIND_REPLACE_COMMAND,
      label: t('text.commands.findAndReplaceText', 'Find and Replace Text…'),
      description: t('text.commands.findTextInTheSelected', 'Find text in the selected layers, this comp or every comp — Source Text keyframes included — and replace it in one undo.'),
      icon: 'search',
      shortcut: { key: 'h', meta: true, shift: true },
      enabled: () => true,
      execute: () => {
        openFindReplaceTextDialog();
      },
    },
    {
      id: TEXT_REPLACE_FONTS_COMMAND,
      label: t('text.commands.findAndReplaceFonts', 'Find and Replace Fonts…'),
      description: t('text.commands.listEveryFontTheProject', 'List every font the project uses, flag the missing ones, and swap any of them on every layer and styled run.'),
      icon: 'type',
      enabled: () => true,
      execute: async () => {
        await openFindAndReplaceFonts();
      },
    },
    {
      id: LAYER_MASKS_FROM_TEXT_COMMAND,
      label: t('text.commands.createMasksFromText', 'Create Masks from Text'),
      description: t('text.commands.aCompSizedSolidIn', 'A comp-sized solid in the text colour with one mask per glyph outline; the text layer is hidden.'),
      icon: 'type',
      enabled: () => {
        const id = selectedTextLayer();
        return id !== null && canOutlineText(documentMirror(), id);
      },
      execute: async () => {
        const id = selectedTextLayer();
        if (!id) return;
        const made = await masksFromTextEdit(id);
        if (!made) {
          notify(t('text.commands.outlineFailed', 'Could not outline this text — is it empty?'), 'warning');
          return;
        }
        notify(
          made.source === 'outlines'
            ? t('text.commands.masksFromOutlines', 'Created {n} masks from the font’s own outlines', { n: made.masks })
            : t('text.commands.masksFromTraced', 'Created {n} masks from traced outlines (allow local fonts for exact curves)', { n: made.masks }),
          'success',
        );
      },
    },
    {
      id: TEXT_SOURCE_EXPRESSION_COMMAND,
      label: t('text.commands.sourceTextExpression', 'Source Text Expression…'),
      description: t('text.commands.driveTheSelectedTextLayer', 'Drive the selected text layer’s Source Text with an expression — text.sourceText, the text style API and per-character styling.'),
      icon: 'track',
      enabled: () => selectedTextLayer() !== null,
      execute: () => {
        const id = selectedTextLayer();
        if (id) openSourceTextExpressionEditor(id);
      },
    },
  ];
}

let installed = false;

/** Register the commands, bind shortcuts, arm the font check. Idempotent. */
export function installTextToolCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildTextToolCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
  installMissingFontsWatcher();
}
