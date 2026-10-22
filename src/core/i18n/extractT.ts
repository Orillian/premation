/**
 * Finds `t('key', 'English fallback')` calls in source text, for the
 * translator source file (`locales/en.json`).
 *
 * Only LITERAL calls are found — a key or fallback built at runtime cannot be
 * listed ahead of time, which is one more reason the `t()` rules say to pass
 * both as plain strings. Quotes may be ' " or ` (without `${}`); the call may
 * span lines.
 */

export interface ExtractedString {
  key: string;
  english: string;
}

const STR = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|\x60((?:[^\x60\\$]|\\.)*)\x60`;
const CALL = new RegExp(String.raw`(?<![\w$.])t\(\s*(?:${STR})\s*,\s*(?:${STR})`, 'g');

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

/** JS string escapes, so en.json holds the string the call site renders (`\n` is a newline, not "n"). */
function unescape(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e: string) => {
    if (e.startsWith('u{')) return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    return ESCAPES[e] ?? e;
  });
}

export function extractTCalls(sourceText: string): ExtractedString[] {
  const out: ExtractedString[] = [];
  for (const m of sourceText.matchAll(CALL)) {
    const key = m[1] ?? m[2] ?? m[3];
    const english = m[4] ?? m[5] ?? m[6];
    if (key === undefined || english === undefined) continue;
    out.push({ key: unescape(key), english: unescape(english) });
  }
  return out;
}
