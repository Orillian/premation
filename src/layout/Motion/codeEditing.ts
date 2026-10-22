/**
 * Plain-text editing moves for the expression editor's textarea: what Tab,
 * Shift+Tab, Enter and Ctrl+/ do to a multi-line rig. Pure (text + selection
 * in, text + selection out) so the keyboard handler stays a dispatcher and the
 * behaviour is testable without a DOM.
 */

export interface CodeEdit {
  text: string;
  start: number;
  end: number;
}

export const INDENT = '  ';

/** Offsets of the first character of every line the selection touches. */
function lineStartsIn(text: string, start: number, end: number): number[] {
  const first = text.lastIndexOf('\n', start - 1) + 1;
  // A selection ending at the very start of a line does not include that line.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const out = [first];
  for (let i = text.indexOf('\n', first); i >= 0 && i < last; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

/** Tab: a caret inserts an indent; a selection indents every line it touches. */
export function indent(text: string, start: number, end: number): CodeEdit {
  if (start === end || !text.slice(start, end).includes('\n')) {
    return { text: text.slice(0, start) + INDENT + text.slice(end), start: start + INDENT.length, end: start + INDENT.length };
  }
  const starts = lineStartsIn(text, start, end);
  let out = text;
  for (const s of [...starts].reverse()) out = out.slice(0, s) + INDENT + out.slice(s);
  return { text: out, start: start + INDENT.length, end: end + INDENT.length * starts.length };
}

/** Shift+Tab: remove up to one indent from every line the selection (or caret) touches. */
export function outdent(text: string, start: number, end: number): CodeEdit {
  const starts = lineStartsIn(text, start, end);
  let out = text;
  let removedBeforeStart = 0;
  let removed = 0;
  for (const s of [...starts].reverse()) {
    let n = 0;
    while (n < INDENT.length && out[s + n] === ' ') n++;
    if (n === 0 && out[s] === '\t') n = 1;
    if (n === 0) continue;
    out = out.slice(0, s) + out.slice(s + n);
    removed += n;
    if (s < start) removedBeforeStart += Math.min(n, start - s);
  }
  return { text: out, start: Math.max(0, start - removedBeforeStart), end: Math.max(0, end - removed) };
}

/**
 * Enter: a new line at the current line's indentation, one level deeper after
 * an opening brace or bracket — and, between `{` and `}`, the closer moves to a
 * line of its own.
 */
export function newline(text: string, start: number, end: number): CodeEdit {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lead = /^[ \t]*/.exec(text.slice(lineStart, start))?.[0] ?? '';
  const before = text.slice(lineStart, start).trimEnd();
  const opens = /[{[(]$/.test(before);
  const inner = opens ? lead + INDENT : lead;
  const closer = text.slice(end).match(/^[ \t]*([}\])])/);
  if (opens && closer) {
    const ins = `\n${inner}\n${lead}`;
    return { text: text.slice(0, start) + ins + text.slice(end).replace(/^[ \t]*/, ''), start: start + 1 + inner.length, end: start + 1 + inner.length };
  }
  const ins = `\n${inner}`;
  return { text: text.slice(0, start) + ins + text.slice(end), start: start + ins.length, end: start + ins.length };
}

/** Ctrl+/: comment every touched line out with `// `, or back in when all of them already are. */
export function toggleLineComment(text: string, start: number, end: number): CodeEdit {
  const starts = lineStartsIn(text, start, end);
  const lineAt = (s: number): string => {
    const nl = text.indexOf('\n', s);
    return text.slice(s, nl < 0 ? text.length : nl);
  };
  const lines = starts.map(lineAt).filter((l) => l.trim() !== '');
  const allCommented = lines.length > 0 && lines.every((l) => l.trimStart().startsWith('//'));
  let out = text;
  let delta = 0;
  let deltaBeforeStart = 0;
  for (const s of [...starts].reverse()) {
    const line = lineAt(s);
    if (line.trim() === '') continue;
    const lead = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (allCommented) {
      const n = line.slice(lead).startsWith('// ') ? 3 : 2;
      out = out.slice(0, s + lead) + out.slice(s + lead + n);
      delta -= n;
      if (s + lead < start) deltaBeforeStart -= Math.min(n, start - (s + lead));
    } else {
      out = out.slice(0, s + lead) + '// ' + out.slice(s + lead);
      delta += 3;
      if (s + lead < start) deltaBeforeStart += 3;
    }
  }
  return { text: out, start: Math.max(0, start + deltaBeforeStart), end: Math.max(0, end + delta) };
}

/** 1-based line of a character offset. */
export function lineOfOffset(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
