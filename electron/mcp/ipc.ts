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

export const CLAUDE_DOWNLOAD_URL = 'https://claude.ai/download';

export interface ClaudeSetupStatus {
  bridge: McpBridgeStatus;
  claude: { installed: boolean; configs: Array<{ path: string; state: EntryState }> };
  /** At least one Claude Desktop config launches this install. */
  configured: boolean;
  /** A config names Premation but launches something that is gone. */
  needsRepair: boolean;
  /** The bundled connector script exists. */
  connectorInstalled: boolean;
  claudeCodeCommand: string;
  manualSnippet: string;
  /** The name Premation has in Claude: `premation`, or `premation-dev` for a development build. */
  serverName: string;
}

export type ConnectResult =
  | { ok: true; status: ClaudeSetupStatus; changed: boolean }
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
 * Remove Premation from every Claude Desktop config on this machine. Run by
 * the Windows uninstaller (`--premation-mcp-uninstall`) and by Disconnect.
 */
export function removeFromClaude(p: PlatformInfo = platformInfo(), cfs: ConfigFs = nodeFs, key: string = SERVER_KEY): Array<{ path: string; ok: boolean; message?: string }> {
  return detectClaude(p, cfs).configPaths.map((file) => {
    const r = removeEntry(file, cfs, key);
    return r.ok ? { path: file, ok: true } : { path: file, ok: false, message: r.message };
  });
}

export class McpHost {
  readonly bridge: McpBridge;
  private readonly spec: McpLaunchSpec;
  private readonly script: string;
  /** `premation` for the installed app, `premation-dev` for a development build. */
  readonly key: string;
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
    this.key = o.isPackaged ? SERVER_KEY : DEV_SERVER_KEY;
  }

  status(): ClaudeSetupStatus {
    const det = detectClaude(platformInfo(), nodeFs);
    const configs = det.configPaths.map((p) => ({ path: p, state: inspectEntry(p, this.spec, nodeFs, this.key) }));
    return {
      bridge: this.bridge.status(),
      claude: { installed: det.installed, configs },
      configured: configs.some((c) => c.state === 'ok'),
      needsRepair: configs.some((c) => c.state === 'stale'),
      connectorInstalled: fs.existsSync(this.script),
      claudeCodeCommand: claudeCodeCommand(this.spec, process.platform, this.key),
      manualSnippet: manualSnippet(this.spec, this.key),
      serverName: this.key,
    };
  }

  private pushStatus(): void {
    const w = this.o.getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('mcp:status', this.status());
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

  async connect(): Promise<ConnectResult> {
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
    return { ok: true, status: this.status(), changed };
  }

  async enableOnly(): Promise<ClaudeSetupStatus> {
    await this.bridge.enable();
    return this.status();
  }

  async disconnect(): Promise<{ status: ClaudeSetupStatus; problems: string[] }> {
    const problems = removeFromClaude(platformInfo(), nodeFs, this.key).filter((r) => !r.ok).map((r) => r.message ?? r.path);
    await this.bridge.disable();
    return { status: this.status(), problems };
  }

  async repair(): Promise<ConnectResult> {
    return this.connect();
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
        // A reload or navigation drops the page's host without unmounting it cleanly.
        sender.on('did-start-loading', () => this.bridge.setPageReady(false));
        sender.once('destroyed', () => this.bridge.setPageReady(false));
      }
      this.bridge.setPageReady(ready === true);
    });
  }
}
