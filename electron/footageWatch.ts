/**
 * Footage file watching for Edit ▸ Edit Original (AE's Ctrl+E) and the
 * reload that follows: the user saves the file in Photoshop / an image editor
 * / an audio editor, and the editor reloads that footage.
 *
 * One `FootageWatcher` per editor window (electron/ipc/footageFiles.ts owns
 * the map and the IPC). It is pure — no `electron`, no `fs` — so the debounce
 * and dedupe rules are unit-tested with fake timers and a fake disk.
 *
 * HOW A SAVE IS SEEN
 *
 *  - The page hands over every footage path the project uses (`setPaths`).
 *    Each path is stat'ed once for a baseline (size + mtime).
 *  - The DIRECTORIES of those paths are watched (non-recursive `fs.watch`),
 *    the page's priority paths (files the user just sent to another app)
 *    first, at most `maxDirs` of them. A directory, not the file: an
 *    atomic-save editor writes `name.tmp`, deletes `name`, renames the temp
 *    over it — a watch on the file's inode would go deaf at the first save.
 *  - An event names a file in the directory (or nothing, on some platforms):
 *    the watched paths it can mean become candidates, and a trailing debounce
 *    (`debounceMs`, capped at `maxWaitMs` so a file written continuously still
 *    lands) flushes them.
 *  - A flush re-stats the candidates and reports the ones whose stamp moved.
 *    A file that is momentarily gone (between the delete and the rename) is
 *    retried `missingRetries` times before it is reported as gone.
 *  - `check()` re-stats every path — the window-focus fallback, which also
 *    covers directories past the cap, network shares where change events do
 *    not arrive, and a watch that errored.
 *
 * Every stat goes through one queue, so a flush and a focus check never both
 * report the same change. Nothing here runs per frame: work happens only on a
 * file-system event, a focus, or a change of the watched set.
 */

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface WatchHandle {
  close(): void;
}

export interface FootageWatchDeps {
  /** Null when the path does not exist or cannot be read as a file. */
  stat(path: string): Promise<FileStamp | null>;
  /**
   * Watch one directory, non-recursively. `onEvent` gets the entry name the
   * OS reported (null when it reported none); `onError` means the watch is
   * dead (the folder was deleted, the share went away). Null = cannot watch.
   */
  watchDir(dir: string, onEvent: (filename: string | null) => void, onError: () => void): WatchHandle | null;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Changed paths, exactly as the page passed them. */
  emit(paths: string[]): void;
  /** Path rules: `win32` (case-insensitive, `\` or `/`), `darwin` (case-insensitive), else POSIX. */
  platform: string;
  /** Milliseconds, monotonic enough for a debounce (default `Date.now`). */
  now?: () => number;
}

export interface FootageWatchOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  maxDirs?: number;
  missingRetries?: number;
}

export const DEFAULT_DEBOUNCE_MS = 300;
export const DEFAULT_MAX_WAIT_MS = 2000;
export const DEFAULT_MAX_DIRS = 64;
export const DEFAULT_MISSING_RETRIES = 2;

/** Pure: the comparison key of a path — separators unified, case folded where the file system folds it. */
export function pathKey(p: string, platform: string): string {
  let k = p.trim();
  if (platform === 'win32') k = k.replace(/\\/g, '/');
  // Collapse repeated separators, keeping a UNC prefix (`//server/share`).
  const unc = k.startsWith('//');
  k = k.replace(/\/{2,}/g, '/');
  if (unc) k = `/${k}`;
  if (k.length > 1 && k.endsWith('/') && !/^[A-Za-z]:\/$/.test(k)) k = k.slice(0, -1);
  return platform === 'win32' || platform === 'darwin' ? k.toLowerCase() : k;
}

/** Pure: a key's directory key and entry name. */
export function splitKey(key: string): { dir: string; name: string } {
  const i = key.lastIndexOf('/');
  if (i < 0) return { dir: '.', name: key };
  if (i === 0) return { dir: '/', name: key.slice(1) };
  // `c:/x.png` → dir `c:/`, so the drive root stays a valid directory.
  const dir = /^[A-Za-z]:$/.test(key.slice(0, i)) ? key.slice(0, i + 1) : key.slice(0, i);
  return { dir, name: key.slice(i + 1) };
}

/** Pure: did the stamp move? Missing → present and present → missing are both changes. */
export function stampChanged(before: FileStamp | null | undefined, after: FileStamp | null): boolean {
  if (before === undefined) return false; // no baseline yet: this read IS the baseline
  if (before === null || after === null) return before !== after;
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

interface Entry {
  /** The path as the page spelled it (what `emit` reports). */
  path: string;
  key: string;
  dirKey: string;
  name: string;
  /** undefined until the first stat lands. */
  stamp: FileStamp | null | undefined;
  /** Consecutive flushes that found the file missing (atomic-save window). */
  missingSeen: number;
}

interface DirWatch {
  /** One of the paths in it, as the page spelled it — its directory is what is watched. */
  dirPath: string;
  handle: WatchHandle | null;
}

export class FootageWatcher {
  private readonly deps: FootageWatchDeps;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxDirs: number;
  private readonly missingRetries: number;

  private entries = new Map<string, Entry>();
  private dirs = new Map<string, DirWatch>();
  private candidates = new Set<string>();
  private timer: unknown = null;
  private firstEventAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(deps: FootageWatchDeps, options: FootageWatchOptions = {}) {
    this.deps = deps;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS;
    this.missingRetries = options.missingRetries ?? DEFAULT_MISSING_RETRIES;
  }

  /** The watched directory keys (tests, diagnostics). */
  watchedDirs(): string[] {
    return [...this.dirs.entries()].filter(([, d]) => d.handle !== null).map(([k]) => k);
  }

  /** The watched path count (tests, diagnostics). */
  size(): number {
    return this.entries.size;
  }

  /**
   * Replace the watched set. `priority` paths (a subset, typically the files
   * just opened with Edit Original) get their directories watched first.
   * Paths no longer listed stop being watched; their directory watch closes
   * when no listed path is left in it. Resolves once new baselines are read.
   */
  setPaths(paths: readonly string[], priority: readonly string[] = []): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const platform = this.deps.platform;
    const next = new Map<string, Entry>();
    for (const p of paths) {
      if (typeof p !== 'string' || p.trim() === '') continue;
      const key = pathKey(p, platform);
      if (next.has(key)) continue;
      const kept = this.entries.get(key);
      if (kept) {
        next.set(key, kept);
        continue;
      }
      const { dir, name } = splitKey(key);
      next.set(key, { path: p, key, dirKey: dir, name, stamp: undefined, missingSeen: 0 });
    }
    this.entries = next;
    for (const k of [...this.candidates]) if (!next.has(k)) this.candidates.delete(k);

    // Directories, priority first, then in the page's order; at most maxDirs.
    const prioritySet = new Set(priority.map((p) => pathKey(p, platform)));
    const ordered = [...next.values()].sort((a, b) => Number(prioritySet.has(b.key)) - Number(prioritySet.has(a.key)));
    const wanted = new Map<string, string>();
    for (const e of ordered) {
      if (wanted.has(e.dirKey)) continue;
      if (wanted.size >= this.maxDirs) break;
      wanted.set(e.dirKey, e.path);
    }
    for (const [dirKey, d] of [...this.dirs]) {
      if (wanted.has(dirKey)) continue;
      d.handle?.close();
      this.dirs.delete(dirKey);
    }
    for (const [dirKey, dirPath] of wanted) {
      if (this.dirs.has(dirKey)) continue;
      this.dirs.set(dirKey, { dirPath, handle: this.openDir(dirKey, dirPath) });
    }

    const fresh = [...next.values()].filter((e) => e.stamp === undefined);
    if (fresh.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      for (const e of fresh) {
        if (this.entries.get(e.key) !== e) continue;
        e.stamp = await this.safeStat(e.path);
      }
    });
  }

  /** Re-stat every watched path now; returns (and does not emit) the changed ones. */
  check(): Promise<string[]> {
    if (this.disposed) return Promise.resolve([]);
    return this.enqueue(async () => {
      const changed: string[] = [];
      for (const e of [...this.entries.values()]) {
        const after = await this.safeStat(e.path);
        if (this.entries.get(e.key) !== e) continue;
        if (stampChanged(e.stamp, after)) changed.push(e.path);
        e.stamp = after;
        e.missingSeen = 0;
        this.candidates.delete(e.key);
      }
      return changed;
    });
  }

  /** Close every directory watch and forget everything. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    for (const d of this.dirs.values()) d.handle?.close();
    this.dirs.clear();
    this.entries.clear();
    this.candidates.clear();
  }

  /** A raw directory event (exported for the test; the watch callback calls it). */
  onDirEvent(dirKey: string, filename: string | null): void {
    if (this.disposed) return;
    const name = filename === null ? null : pathKey(filename, this.deps.platform);
    let hit = false;
    for (const e of this.entries.values()) {
      if (e.dirKey !== dirKey) continue;
      if (name !== null && e.name !== name) continue;
      this.candidates.add(e.key);
      hit = true;
    }
    if (hit) this.schedule();
  }

  private openDir(dirKey: string, dirPath: string): WatchHandle | null {
    // The directory as the OS spells it: the page's path minus its last segment.
    const cut = Math.max(dirPath.lastIndexOf('/'), this.deps.platform === 'win32' ? dirPath.lastIndexOf('\\') : -1);
    let dir = cut <= 0 ? (cut === 0 ? dirPath.slice(0, 1) : '.') : dirPath.slice(0, cut);
    if (/^[A-Za-z]:$/.test(dir)) dir += this.deps.platform === 'win32' ? '\\' : '/';
    try {
      return this.deps.watchDir(
        dir,
        (filename) => this.onDirEvent(dirKey, filename),
        () => {
          // A dead watch (folder deleted, share gone): drop it; the focus check still covers its files.
          const d = this.dirs.get(dirKey);
          if (d?.handle) {
            d.handle.close();
            d.handle = null;
          }
        },
      );
    } catch {
      return null;
    }
  }

  private schedule(): void {
    const now = this.now();
    if (this.timer === null) this.firstEventAt = now;
    else this.deps.clearTimeout(this.timer);
    const waited = now - this.firstEventAt;
    const delay = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - waited));
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private flush(): Promise<void> {
    const keys = [...this.candidates];
    this.candidates.clear();
    if (keys.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      const changed: string[] = [];
      let retry = false;
      for (const key of keys) {
        const e = this.entries.get(key);
        if (!e) continue;
        const after = await this.safeStat(e.path);
        if (this.entries.get(key) !== e) continue;
        if (after === null && e.stamp !== null && e.missingSeen < this.missingRetries) {
          // Probably mid atomic save (deleted, not yet renamed back): look again.
          e.missingSeen += 1;
          this.candidates.add(key);
          retry = true;
          continue;
        }
        e.missingSeen = 0;
        if (stampChanged(e.stamp, after)) changed.push(e.path);
        e.stamp = after;
      }
      if (changed.length > 0 && !this.disposed) this.deps.emit(changed);
      if (retry && !this.disposed) this.schedule();
    });
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async safeStat(path: string): Promise<FileStamp | null> {
    try {
      return await this.deps.stat(path);
    } catch {
      return null;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

/** Pure: a numbered-sequence pattern in a file NAME (`shot_####.png`, `shot_%04d.png`, `shot_[####].png`). */
export function sequencePattern(name: string): RegExp | null {
  const m = /^(.*?)(\[#+\]|#+|%0?(\d*)d)(.*)$/.exec(name);
  if (!m) return null;
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = m[1] ?? '';
  const tail = m[4] ?? '';
  return new RegExp(`^${esc(head)}(\\d+)${esc(tail)}$`, 'i');
}

/** Pure: the lowest-numbered entry matching a sequence pattern name, or null. */
export function firstSequenceFrame(patternName: string, entries: readonly string[]): string | null {
  const re = sequencePattern(patternName);
  if (!re) return null;
  let best: { name: string; n: number } | null = null;
  for (const e of entries) {
    const m = re.exec(e);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (!best || n < best.n) best = { name: e, n };
  }
  return best?.name ?? null;
}

/**
 * The file types `shell:openFile` hands to the OS: footage the editor imports
 * (stills, layered art, vectors, video, audio, 3D, LUTs). An ALLOWLIST, not a
 * list of what is dangerous: the OS's default action for a type nobody listed
 * (.html, .chm, a macro document, a script with an unusual extension) can run
 * code, and the path comes from the page.
 */
const OPENABLE = new Set([
  // stills and layered art
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'bmp', 'tif', 'tiff', 'tga', 'webp', 'avif', 'heic', 'heif', 'psd', 'psb',
  'exr', 'hdr', 'dpx', 'cin', 'dds', 'ico', 'jxl', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2',
  // vectors
  'svg', 'ai', 'eps', 'pdf',
  // video
  'mp4', 'm4v', 'mov', 'qt', 'mkv', 'webm', 'avi', 'mxf', 'mpg', 'mpeg', 'm2v', 'mts', 'm2ts', 'ts', 'wmv', 'flv', '3gp',
  'r3d', 'braw', 'ari', 'gifv',
  // audio
  'wav', 'aif', 'aiff', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wma',
  // 3D, animation, colour
  'glb', 'gltf', 'obj', 'fbx', 'usd', 'usda', 'usdc', 'usdz', 'abc', 'stl', 'ply', 'lottie', 'cube', '3dl', 'csp',
]);

/** Pure: may Edit Original hand this file to the OS's default application? */
export function isOpenableFootage(p: string): boolean {
  const name = p.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false; // no extension: no footage type, and the OS would guess
  return OPENABLE.has(name.slice(dot + 1).toLowerCase());
}
