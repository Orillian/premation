/**
 * File ▸ Scripts' commands (After Effects' layout): Run Script File…, the
 * Script Editor panel, the Scripts folder. Registered with the static commands
 * (Providers' `buildStaticCommands`), so each is in the command palette and
 * the native menu too. The scripts IN the folder are menu entries, not
 * commands: they are user data (scriptsMenu.ts).
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useLayoutStore } from '@stores/layoutStore';
import { installScriptConsentPrompt } from './scriptConsent';
import {
  openScriptsFolder,
  refreshScriptList,
  runScriptFile,
  scriptsFolderAvailable,
  SCRIPT_EDITOR_PANEL,
  watchScriptsFolder,
} from './userScripts';

export function buildScriptCommands(): ReadonlyArray<Command> {
  // The consent dialog is what every run waits on; without it the core
  // refuses (scriptHost's default). Registered with the commands that run scripts.
  installScriptConsentPrompt();
  watchScriptsFolder();
  return [
    {
      id: asCommandId('file.runScriptFile'),
      label: 'Run Script File…',
      description: 'Run an After Effects-style .jsx or .js script on the project (one undo step)',
      icon: 'code',
      enabled: () => scriptsFolderAvailable(),
      execute: () => runScriptFile(),
    },
    {
      id: asCommandId('view.scriptEditor'),
      label: 'Script Editor',
      description: 'Write, open, save and run scripts, with a console',
      icon: 'code',
      enabled: () => true,
      execute: () => useLayoutStore.getState().openPanel(SCRIPT_EDITOR_PANEL),
    },
    {
      id: asCommandId('file.openScriptsFolder'),
      label: 'Open Scripts Folder',
      description: 'Show the folder File ▸ Scripts lists',
      icon: 'folder-open',
      enabled: () => scriptsFolderAvailable(),
      execute: () => openScriptsFolder(),
    },
    {
      id: asCommandId('file.refreshScripts'),
      label: 'Refresh Scripts List',
      icon: 'refresh',
      enabled: () => scriptsFolderAvailable(),
      execute: () => refreshScriptList(),
    },
  ];
}
