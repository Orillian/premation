import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineLogFile } from './engineLogFile';
import { handleEngineUnavailable, type EngineUnavailableDeps } from './engineUnavailable';

describe('EngineLogFile', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-log-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('keeps the engine lines and the supervisor events, creating the folder', () => {
    const file = path.join(dir, 'logs', 'engine.log');
    const log = new EngineLogFile(file, 'Premation 1.0.4 (win32)');
    log.write('{"t":1.000,"lvl":"error","ev":"uncaught_exception","what":"No mapping for the Unicode character"}');
    log.event('[engine] error engine_exited {"code":3}');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('Premation 1.0.4 (win32)');
    expect(text).toContain('uncaught_exception');
    expect(text).toContain('engine_exited');
  });

  it('rolls over to engine.old.log instead of growing without bound', () => {
    const file = path.join(dir, 'engine.log');
    const log = new EngineLogFile(file);
    const line = 'x'.repeat(1023);
    for (let i = 0; i < 4 * 1024 + 10; i++) log.write(line);
    expect(fs.existsSync(path.join(dir, 'engine.old.log'))).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('never throws when the folder cannot be written', () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const log = new EngineLogFile(path.join(blocker, 'engine.log'), 'header');
    expect(() => log.write('line')).not.toThrow();
  });
});

it('the crash-loop dialog names the log file for a report', async () => {
  let detail = '';
  const d: EngineUnavailableDeps = {
    showErrorBox: () => {},
    showMessageBox: async (o) => { detail = o.detail; return { response: 2 }; },
    showSaveDialog: async () => ({ canceled: true }),
    recoveryPath: null,
    logPath: '/u/AppData/Roaming/Premation/logs/engine.log',
    exists: () => false,
    copyFile: async () => {},
    retry: async () => {},
    quit: () => {},
    defaultDir: '/docs',
    joinPath: (...p) => p.join('/'),
  };
  await handleEngineUnavailable({ reason: 'premation-engine crashed 3 times within 60 s', fatal: false, logTail: [] }, d);
  expect(detail).toContain('Premation/logs/engine.log');
});
