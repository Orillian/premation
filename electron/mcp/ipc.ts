/**
 * Claude for Premation, main-process side: the Settings page's channels and
 * the pieces that tie the bridge, Claude's config and the self-test together
 * (docs/MCP_PLAN.md §3.2–3.4).
 *
 *   mcp:getStatus      everything the Settings card shows
 *   mcp:connect        turn on + add Premation to Claude Desktop's config
 *   mcp:enable         turn on only (Claude Code users, who add it themselves)
 *   mcp:disconnect     remove Premation from Claude's config + turn off
 *   mcp:repair         rewrite a stale entry (the app moved after an update)
 *   mcp:test           run the end-to-end self-test
 *   mcp:getClaude      open Claude's download page
 *   mcp:result         the page answers a relayed tool call
 *   mcp:pageReady      the editor page can (or can no longer) take calls
 *
 * "Configured" is never reported as "connected": Claude's config can say
 * Premation while Claude has not been restarted to read it. Connected means a
 * client is on the pipe right now — the bridge knows that, so the card says it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { shell, type BrowserWindow, type WebContents } from 'electron';
import { handle, on } from '../ipcGuard';
import { McpBridge, type McpBridgeStatus } from './bridge';
import {
  DEV_SERVER_KEY,
  SERVER_KEY,
  claudeCodeCommand,
  detectClaude,
  inspectEntry,
  manualSnippet,
  removeEntry,
  upsertEntry,
  type ConfigFs,
  type EntryState,
  type McpLaunchSpec,
  type PlatformInfo,
} from './claudeConfig';
import { runSelfTest, type TestStep } from './selfTest';
import { EXTENSION_FILE, inspectExtension, writeExtension, type ExtensionState } from './extension';

export const CLAUDE_DOWNLOAD_URL = 'https://claude.ai/download';

export interface ClaudeSetupStatus {
  bridge: McpBridgeStatus;
  claude: {
    installed: boolean;
    configs: Array<{ path: string; state: EntryState }>;
    /** Premation installed as a Claude Desktop extension (the route with the logo). */
    extension: ExtensionState;
  };
  /** How Claude Desktop reaches Premation now, if at all. */
  method: 'extension' | 'config' | null;
  /** Premation is installed in Claude Desktop (extension or config entry) for THIS app. */
  configured: boolean;
  /** Claude names Premation but launches an old copy (the app or its data moved). */
  needsRepair: boolean;
  /** The extension bundle Connect last wrote, if it exists — for "open it again". */
  extensionFile: string | null;
  /** The bundled connector script exists. */
  connectorInstalled: boolean;
  claudeCodeCommand: string;
  manualSnippet: string;
  /** The name Premation has in Claude. */
  serverName: string;
  /** A development build (it replaces an installed Premation's entry in Claude). */
  devBuild: boolean;
}

export type ConnectResult =
  | { ok: true; status: ClaudeSetupStatus; changed: boolean; method: 'extension' | 'config'; extensionFile?: string; openError?: string }
  | { ok: false; code: 'not-installed' | 'malformed' | 'io' | 'unreadable' | 'no-connector'; message: string; status: ClaudeSetupStatus };

export interface McpHostOptions {
  userDataDir: string;
  appVersion: string;
  isPackaged: boolean;
  resourcesPath: string;
  /** The repo root in development (`build/mcp/` lives there). */
  appPath: string;
  execPath: string;
  getWindow(): BrowserWindow | null;
  log?(line: string): void;
}

/** Where the bundled server script is for this build. */
export function connectorScriptPath(o: Pick<McpHostOptions, 'isPackaged' | 'resourcesPath' | 'appPath'>): string {
  return o.isPackaged
    ? path.join(o.resourcesPath, 'mcp', 'premation-mcp.cjs')
    : path.join(o.appPath, 'build', 'mcp', 'premation-mcp.cjs');
}

/** What Claude's config launches: this app's own binary, as Node, on the script. */
export function launchSpecFor(o: Pick<McpHostOptions, 'isPackaged' | 'resourcesPath' | 'appPath' | 'execPath'>, mcpDir: string): McpLaunchSpec {
  return {
    command: o.execPath,
    args: [connectorScriptPath(o)],
    env: { ELECTRON_RUN_AS_NODE: '1', PREMATION_MCP_DIR: mcpDir },
  };
}

export function platformInfo(): PlatformInfo {
  return {
    platform: process.platform,
    home: process.env.HOME ?? process.env.USERPROFILE ?? '',
    ...(process.env.APPDATA ? { appData: process.env.APPDATA } : {}),
    ...(process.env.LOCALAPPDATA ? { localAppData: process.env.LOCALAPPDATA } : {}),
  };
}

const nodeFs: ConfigFs = fs;

/**
 * Remove Premation's config-file entries from every Claude Desktop config on
 * this machine — `premation`, and `premation-dev` that early development
 * builds wrote. Run by the Windows uninstaller (`--premation-mcp-uninstall`)
 * and by Disconnect. An installed EXTENSION is Claude's to remove.
 */
export function removeFromClaude(p: PlatformInfo = platformInfo(), cfs: ConfigFs = nodeFs): Array<{ path: string; ok: boolean; message?: string }> {
  return detectClaude(p, cfs).configPaths.flatMap((file) => [SERVER_KEY, DEV_SERVER_KEY].map((key) => {
    const r = removeEntry(file, cfs, key);
    return r.ok ? { path: file, ok: true } : { path: file, ok: false, message: r.message };
  }));
}

export class McpHost {
  readonly bridge: McpBridge;
  private readonly spec: McpLaunchSpec;
  private readonly script: string;
  /** Premation's name in Claude — the same for a development build (owner decision). */
  readonly key = SERVER_KEY;
  private readonly readySenders = new WeakSet<WebContents>();

  constructor(private readonly o: McpHostOptions) {
    this.bridge = new McpBridge({
      userDataDir: o.userDataDir,
      platform: process.platform,
      appVersion: o.appVersion,
      getPage: () => {
        const w = o.getWindow();
        return w && !w.isDestroyed() ? w.webContents : null;
      },
      onStatus: () => this.pushStatus(),
      log: (line) => o.log?.(line),
    });
    this.spec = launchSpecFor(o, this.bridge.paths.dir);
    this.script = connectorScriptPath(o);
  }

  private extensionInputs() {
    const o = this.o;
    return {
      appVersion: o.appVersion,
      scriptPath: this.script,
      toolsPath: path.join(path.dirname(this.script), 'tools.json'),
      iconPath: o.isPackaged ? path.join(o.resourcesPath, 'build', 'icon.png') : path.join(o.appPath, 'build', 'icon.png'),
      mcpDir: this.bridge.paths.dir,
    };
  }

  status(): ClaudeSetupStatus {
    const det = detectClaude(platformInfo(), nodeFs);
    const configs = det.configPaths.map((p) => ({ path: p, state: inspectEntry(p, this.spec, nodeFs, this.key) }));
    const extStates = det.configPaths.map((p) => inspectExtension(path.dirname(p), this.bridge.paths.dir));
    const extension: ExtensionState = extStates.includes('ok') ? 'ok' : extStates.includes('stale') ? 'stale' : 'absent';
    const configOk = configs.some((c) => c.state === 'ok');
    const extFile = path.join(this.bridge.paths.dir, EXTENSION_FILE);
    return {
      bridge: this.bridge.status(),
      claude: { installed: det.installed, configs, extension },
      method: extension === 'ok' ? 'extension' : configOk ? 'config' : null,
      configured: extension === 'ok' || configOk,
      needsRepair: extension !== 'ok' && !configOk && (extension === 'stale' || configs.some((c) => c.state === 'stale')),
      extensionFile: fs.existsSync(extFile) ? extFile : null,
      devBuild: !this.o.isPackaged,
      connectorInstalled: fs.existsSync(this.script),
      claudeCodeCommand: claudeCodeCommand(this.spec, process.platform, this.key),
      manualSnippet: manualSnippet(this.spec, this.key),
      serverName: this.key,
    };
  }

  private pushStatus(): void {
    const w = this.o.getWindow();
    // The page's `destroyed` (setPageReady(false)) arrives while the window
    // still stands but its webContents is gone: sending then throws in main.
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('mcp:status', this.status());
  }

  /** At launch: listen again if Claude was on, and fix an entry an update left stale. */
  async start(): Promise<void> {
    await this.bridge.restore();
    if (!this.bridge.status().enabled) return;
    const det = detectClaude(platformInfo(), nodeFs);
    for (const file of det.configPaths) {
      if (inspectEntry(file, this.spec, nodeFs, this.key) === 'stale') {
        const r = upsertEntry(file, this.spec, nodeFs, this.key);
        this.o.log?.(`[mcp] repaired ${file}: ${r.ok ? 'ok' : r.message}`);
      }
    }
  }

  /**
   * Connect, the way that shows Premation's logo in Claude: write the
   * extension bundle and open it, so Claude Desktop shows its install screen.
   * The config-file entries an earlier Connect wrote are removed, so Claude
   * does not list Premation twice.
   */
  async connect(): Promise<ConnectResult> {
    if (!fs.existsSync(this.script)) {
      return { ok: false, code: 'no-connector', message: `Premation's Claude connector is missing (${this.script}). Reinstall Premation.`, status: this.status() };
    }
    const det = detectClaude(platformInfo(), nodeFs);
    if (!det.installed) {
      return { ok: false, code: 'not-installed', message: 'Claude Desktop isn\'t installed.', status: this.status() };
    }
    await this.bridge.enable();
    let file: string;
    try {
      file = writeExtension(this.extensionInputs());
    } catch (err) {
      return { ok: false, code: 'io', message: err instanceof Error ? err.message : String(err), status: this.status() };
    }
    removeFromClaude();
    // Opens with whatever owns .mcpb — Claude Desktop. An empty string is success.
    const openError = await shell.openPath(file);
    this.o.log?.(`[mcp] opened extension ${file}${openError ? `: ${openError}` : ''}`);
    this.pushStatus();
    return { ok: true, status: this.status(), changed: true, method: 'extension', extensionFile: file, ...(openError ? { openError } : {}) };
  }

  /** Show the bundle in Explorer / Finder, to drag it into Claude by hand. */
  revealExtension(): void {
    const file = path.join(this.bridge.paths.dir, EXTENSION_FILE);
    if (fs.existsSync(file)) shell.showItemInFolder(file);
  }

  /** The older route: a `claude_desktop_config.json` entry (generic icon, fully removable). */
  async connectConfig(): Promise<ConnectResult> {
    if (!fs.existsSync(this.script)) {
      return { ok: false, code: 'no-connector', message: `Premation's Claude connector is missing (${this.script}). Reinstall Premation.`, status: this.status() };
    }
    const det = detectClaude(platformInfo(), nodeFs);
    if (!det.installed || det.configPaths.length === 0) {
      return { ok: false, code: 'not-installed', message: 'Claude Desktop isn\'t installed.', status: this.status() };
    }
    await this.bridge.enable();
    let changed = false;
    for (const file of det.configPaths) {
      const r = upsertEntry(file, this.spec, nodeFs, this.key);
      if (!r.ok) return { ok: false, code: r.code, message: r.message, status: this.status() };
      changed ||= r.changed;
    }
    this.pushStatus();
    return { ok: true, status: this.status(), changed, method: 'config' };
  }

  async enableOnly(): Promise<ClaudeSetupStatus> {
    await this.bridge.enable();
    return this.status();
  }

  /**
   * Turn Claude off: Premation stops accepting connections and rotates its
   * token, and config-file entries are removed. An installed extension stays
   * in Claude until the user removes it there (`extensionInstalled` says so).
   */
  async disconnect(): Promise<{ status: ClaudeSetupStatus; problems: string[]; extensionInstalled: boolean }> {
    const problems = removeFromClaude().filter((r) => !r.ok).map((r) => r.message ?? r.path);
    await this.bridge.disable();
    const status = this.status();
    return { status, problems, extensionInstalled: status.claude.extension !== 'absent' };
  }

  /** Re-point Claude at this copy of Premation, by the route it uses now. */
  async repair(): Promise<ConnectResult> {
    const s = this.status();
    return s.claude.extension === 'absent' && s.claude.configs.some((c) => c.state === 'stale') ? this.connectConfig() : this.connect();
  }

  stop(): Promise<void> {
    return this.bridge.stop();
  }

  async test(): Promise<TestStep[]> {
    return runSelfTest(this.spec, this.script);
  }

  register(): void {
    handle('mcp:getStatus', () => this.status());
    handle('mcp:connect', () => this.connect());
    handle('mcp:connectConfig', () => this.connectConfig());
    handle('mcp:revealExtension', () => this.revealExtension());
    handle('mcp:enable', () => this.enableOnly());
    handle('mcp:disconnect', () => this.disconnect());
    handle('mcp:repair', () => this.repair());
    handle('mcp:test', () => this.test());
    handle('mcp:getClaude', () => shell.openExternal(CLAUDE_DOWNLOAD_URL));
    handle('mcp:result', (event, id: unknown, result: unknown) => {
      // Only the editor window runs Claude's calls; a pop-out never gets one.
      if (event.sender !== this.o.getWindow()?.webContents) return;
      this.bridge.resolveCall(id, result);
    });
    on('mcp:pageReady', (event, ready: unknown) => {
      const sender = event.sender;
      if (sender !== this.o.getWindow()?.webContents) return;
      if (!this.readySenders.has(sender)) {
        this.readySenders.add(sender);
        // A reload or a navigation to another document drops the page's host
        // without unmounting it cleanly. Not `did-start-loading`: that also
        // fires for the router's in-page (hash) navigations — home → editor —
        // and would fail the very create_project that caused it.
        sender.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) this.bridge.setPageReady(false);
        });
        sender.once('destroyed', () => this.bridge.setPageReady(false));
      }
      this.bridge.setPageReady(ready === true);
    });
  }
}
