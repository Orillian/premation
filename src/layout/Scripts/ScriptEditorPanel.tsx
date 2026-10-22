/**
 * The Script Editor panel (File ▸ Scripts ▸ Open Script Editor): write an
 * After Effects-style script, run it, read its console.
 *
 *   - the code: monospace, a line-number gutter (scrolled with the code
 *     through a ref, not a render), Tab inserts two spaces, Ctrl/Cmd+Enter runs;
 *   - New / Open… / Save (Save As for a new buffer) in the user Scripts folder
 *     (electron/ipc/scripts.ts) — the buffer lives in `scriptsStore`, so
 *     closing the panel keeps it;
 *   - the console: `$.writeln` / `alert` / `premation.log` output, the run's
 *     result and its error with the line it was thrown at (that line is also
 *     marked in the gutter).
 *
 * A run is `runUserScript` — the sandbox, the consent dialog, one undo entry.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { t } from '@core/i18n';
import { useScriptsStore } from '@stores/scriptsStore';
import {
  openScriptInEditor,
  runUserScript,
  saveScriptFromEditor,
  scriptsFolderAvailable,
} from './userScripts';
import styles from './ScriptEditorPanel.module.css';

const INDENT = '  ';

export function ScriptEditorPanel(): JSX.Element {
  const source = useScriptsStore((s) => s.source);
  const fileName = useScriptsStore((s) => s.fileName);
  const dirty = useScriptsStore((s) => s.dirty);
  const running = useScriptsStore((s) => s.running);
  const lines = useScriptsStore((s) => s.console);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const consoleRef = useRef<HTMLPreElement>(null);
  /** The caret to restore after a programmatic edit (Tab). */
  const caret = useRef<number | null>(null);
  const canUseFolder = scriptsFolderAvailable();

  const lineCount = useMemo(() => source.split('\n').length, [source]);

  useLayoutEffect(() => {
    const el = codeRef.current;
    if (el && caret.current !== null) {
      el.selectionStart = el.selectionEnd = caret.current;
      caret.current = null;
    }
  }, [source]);

  // The newest console line stays in view.
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = async (): Promise<void> => {
    const s = useScriptsStore.getState();
    setErrorLine(null);
    const r = await runUserScript(s.source, s.fileName);
    if (r && !r.ok && r.errorLine !== undefined) setErrorLine(r.errorLine);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (!running) void run();
      return;
    }
    if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b, value } = el;
      if (e.shiftKey) {
        // Outdent the caret's line by up to one indent.
        const lineStart = value.lastIndexOf('\n', a - 1) + 1;
        const lead = /^ {1,2}/.exec(value.slice(lineStart))?.[0].length ?? 0;
        if (lead === 0) return;
        caret.current = Math.max(lineStart, a - lead);
        useScriptsStore.getState().setSource(value.slice(0, lineStart) + value.slice(lineStart + lead));
        return;
      }
      caret.current = a + INDENT.length;
      useScriptsStore.getState().setSource(value.slice(0, a) + INDENT + value.slice(b));
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <span className={styles.fileName} title={fileName}>
          {fileName}
          {dirty ? <span className={styles.dirty}> •</span> : null}
        </span>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Icon name="plus" size="sm" />}
          title={t('scripts.editor.new', 'New Script')}
          onClick={() => { setErrorLine(null); useScriptsStore.getState().newFile(); }}
        >
          {t('scripts.editor.new', 'New Script')}
        </Button>
        {canUseFolder ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="folder-open" size="sm" />}
              title={t('scripts.editor.open', 'Open Script…')}
              onClick={() => { setErrorLine(null); void openScriptInEditor(); }}
            >
              {t('scripts.editor.open', 'Open Script…')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="download" size="sm" />}
              title={t('scripts.editor.save', 'Save Script (Shift-click: Save As…)')}
              onClick={(e) => { void saveScriptFromEditor(e.altKey || e.shiftKey); }}
            >
              {t('scripts.editor.save', 'Save Script (Shift-click: Save As…)')}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Icon name="play" size="sm" />}
          disabled={running}
          title={t('scripts.editor.runHint', 'Run (Ctrl+Enter)')}
          onClick={() => { void run(); }}
        >
          {running ? t('scripts.editor.running', 'Running…') : t('scripts.editor.run', 'Run')}
        </Button>
      </div>

      <div className={styles.editor}>
        <pre ref={gutterRef} className={styles.gutter} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className={styles.gutterLine} data-error={errorLine === i + 1 ? '' : undefined}>{i + 1}</div>
          ))}
        </pre>
        <textarea
          ref={codeRef}
          className={styles.code}
          value={source}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label={t('scripts.editor.codeLabel', 'Script source')}
          onChange={(e) => { setErrorLine(null); useScriptsStore.getState().setSource(e.target.value); }}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>

      <div className={styles.consoleBar}>
        <span className={styles.consoleTitle}>{t('scripts.editor.console', 'Console')}</span>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Icon name="eraser" size="sm" />}
          title={t('scripts.editor.clear', 'Clear Console')}
          disabled={lines.length === 0}
          onClick={() => useScriptsStore.getState().clearConsole()}
        >
          {t('scripts.editor.clear', 'Clear Console')}
        </Button>
      </div>
      <pre ref={consoleRef} className={styles.console} role="log" aria-live="polite">
        {lines.length === 0 ? (
          <span className={styles.consoleEmpty}>{t('scripts.editor.consoleEmpty', 'Output from $.writeln, alert and premation.log appears here.')}</span>
        ) : (
          lines.map((l) => (
            <div key={l.id} className={styles.line} data-kind={l.kind}>{l.text}</div>
          ))
        )}
      </pre>
    </div>
  );
}
