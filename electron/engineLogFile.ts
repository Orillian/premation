/**
 * The engine's log on disk: `<userData>/logs/engine.log`.
 *
 * premation-engine writes its log to stderr (JSON lines, native/engine/src/core/log.cpp)
 * and its last words when it dies on an uncaught exception (main.cpp `on_terminate`).
 * A shipped build has no terminal, so without this file a user whose engine
 * crash-loops has nothing to send us (user report 2026-10-23). Main also writes
 * the supervisor's own events here (engine_exited, engine_unavailable, …).
 *
 * Kept small: past MAX_BYTES the file becomes engine.old.log and a new one
 * starts, so two files at most. Writes are synchronous and few (the engine
 * logs events, not frames); a failing disk never throws into the caller.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;

export class EngineLogFile {
  private bytes: number;
  private broken = false;

  constructor(readonly file: string, header?: string) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch {
      this.bytes = 0;
      this.broken = true;
    }
    if (header) this.write(`── ${new Date().toISOString()} ${header}`);
  }

  /** One line (a newline is added). */
  write(line: string): void {
    if (this.broken) return;
    const text = `${line}\n`;
    try {
      if (this.bytes + text.length > MAX_BYTES) {
        fs.renameSync(this.file, this.file.replace(/\.log$/, '.old.log'));
        this.bytes = 0;
      }
      fs.appendFileSync(this.file, text, 'utf8');
      this.bytes += Buffer.byteLength(text);
    } catch {
      // A full or read-only disk: the log goes quiet; the engine does not care.
      this.broken = true;
    }
  }

  /** A supervisor event, timestamped (engine lines carry their own `t`). */
  event(text: string): void {
    this.write(`${new Date().toISOString()} ${text}`);
  }
}
