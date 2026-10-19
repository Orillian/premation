// Program X (docs/PROGRAM_DEEP_EFFECTS.md): writes the wiring of the deep
// effects from ./spec.mjs — the engine catalog entry, the TypeScript def and
// EffectType member, the effects-browser folder, the time-dependent list and
// the AI tool's effect enum. Idempotent: every block sits between
// `deepfx:<part>:begin/end` markers and is rewritten whole.
//
//   node scripts/deep-effects/gen.mjs        then   npm run engine-api:gen
//
// The C++ side (packers, shaders) is hand-written: effects_spatial_x*.cpp.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEEP_EFFECTS } from './spec.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const write = (p, s) => writeFileSync(join(ROOT, p), s);
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

const types = new Set(DEEP_EFFECTS.map((e) => e.type));
if (types.size !== DEEP_EFFECTS.length) throw new Error('spec: a type is listed twice');

/** Replace (or insert before `anchor`) the block between the markers. */
function block(src, part, lines, anchor, indent = '  ') {
  const eol = eolOf(src);
  const begin = `${indent}// deepfx:${part}:begin`;
  const end = `${indent}// deepfx:${part}:end`;
  const body = [begin, ...lines, end].join(eol) + eol;
  const b = src.indexOf(begin);
  if (b >= 0) {
    const e = src.indexOf(end, b);
    if (e < 0) throw new Error(`${part}: begin without end`);
    const after = src.indexOf(eol, e) + eol.length;
    return src.slice(0, b) + body + src.slice(after);
  }
  const at = typeof anchor === 'number' ? anchor : src.indexOf(anchor);
  if (at < 0) throw new Error(`${part}: anchor not found: ${anchor}`);
  return src.slice(0, at) + body + src.slice(at);
}

// ── native/engine/catalog/effects.json ───────────────────────────────────────
function catalogParam(p) {
  const o = { key: p.key, label: p.label, type: p.type };
  if (p.group !== undefined) o.group = p.group;
  if (p.unit !== undefined) o.unit = p.unit;
  if (p.options !== undefined) o.options = p.options.map((label, value) => (typeof label === 'object' ? label : { value, label }));
  if (p.min !== undefined) o.min = p.min;
  if (p.max !== undefined) o.max = p.max;
  if (p.precision !== undefined) o.precision = p.precision;
  if (p.noneLabel !== undefined) o.noneLabel = p.noneLabel;
  o.default = p.default ?? (p.type === 'checkbox' ? false : p.type === 'layer' ? '' : p.type === 'color' ? '#ffffff' : 0);
  return o;
}
function timeParams(e) {
  return e.time
    ? [
        { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
        { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
      ]
    : [];
}
{
  const p = 'native/engine/catalog/effects.json';
  const src = read(p);
  const eol = eolOf(src);
  const list = JSON.parse(src).filter((e) => !types.has(e.type));
  for (const e of DEEP_EFFECTS) {
    list.push({ type: e.type, label: e.label, gpuOnly: true, params: [...e.params, ...timeParams(e)].map(catalogParam) });
  }
  write(p, (JSON.stringify(list, null, 2) + '\n').replace(/\n/g, eol));
}

// ── src/core/effects/effects.ts ──────────────────────────────────────────────
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
function tsParam(p0) {
  const p = catalogParam(p0);
  const parts = [`key: ${q(p.key)}`, `label: ${q(p.label)}`, `type: ${q(p.type)}`];
  if (p.group !== undefined) parts.push(`group: ${q(p.group)}`);
  if (p.unit !== undefined) parts.push(`unit: ${q(p.unit)}`);
  if (p.min !== undefined) parts.push(`min: ${p.min}`);
  if (p.max !== undefined) parts.push(`max: ${p.max}`);
  if (p.precision !== undefined) parts.push(`precision: ${p.precision}`);
  if (p.noneLabel !== undefined) parts.push(`noneLabel: ${q(p.noneLabel)}`);
  parts.push(`default: ${typeof p.default === 'string' ? q(p.default) : JSON.stringify(p.default)}`);
  if (p.options !== undefined) parts.push(`options: [${p.options.map((o) => `{ value: ${o.value}, label: ${q(o.label)} }`).join(', ')}]`);
  return `      { ${parts.join(', ')} },`;
}
{
  const p = 'src/core/effects/effects.ts';
  let src = read(p);
  src = block(src, 'union', DEEP_EFFECTS.map((e) => `  | ${q(e.type)}`), "  | 'scribble';");
  const defs = [];
  for (const e of DEEP_EFFECTS) {
    defs.push('  {');
    defs.push(`    /* ${e.desc} GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */`);
    defs.push(`    type: ${q(e.type)},`);
    defs.push(`    label: ${q(e.label)},`);
    defs.push('    gpuOnly: true,');
    defs.push('    params: [');
    for (const prm of [...e.params, ...timeParams(e)]) defs.push(tsParam(prm));
    defs.push('    ],');
    defs.push("    css: () => '',");
    defs.push('  },');
  }
  const eol = eolOf(src);
  const defsEnd = src.indexOf(`${eol}];${eol}`, src.indexOf('export const EFFECT_DEFS'));
  if (defsEnd < 0) throw new Error('EFFECT_DEFS end not found');
  src = block(src, 'defs', defs, defsEnd + eol.length);
  const tAnchor = src.indexOf('  // fx60:b10:end');
  src = block(src, 'time', DEEP_EFFECTS.filter((e) => e.time).map((e) => `  [${q(e.type)}, 'time'],`), src.indexOf(eol, tAnchor) + eol.length);
  write(p, src);
}

// ── src/layout/Effects/effectCategory.ts ─────────────────────────────────────
{
  const p = 'src/layout/Effects/effectCategory.ts';
  let src = read(p);
  const eol = eolOf(src);
  const start = src.indexOf('export const EFFECT_CATEGORY:');
  const close = src.indexOf(`${eol}};`, start);
  src = block(src, 'category', DEEP_EFFECTS.map((e) => `  ${q(e.type)}: ${q(e.category)},`), close + eol.length);
  write(p, src);
}

// ── packages/ai-tools/src/tools/write.ts (add_effect's type enum) ─────────────
{
  const p = 'packages/ai-tools/src/tools/write.ts';
  let src = read(p);
  const anchor = "          'depth-matte', 'depth-fog', 'depth-extract',";
  const eol = eolOf(src);
  const lines = [];
  let line = '         ';
  for (const e of DEEP_EFFECTS) {
    const item = ` ${q(e.type)},`;
    if (line.length + item.length > 118) { lines.push(line); line = '         '; }
    line += item;
  }
  if (line.trim()) lines.push(line);
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error('ai anchor');
  src = block(src, 'ai', lines, at + anchor.length + eol.length, '          ');
  write(p, src);
}

console.log(`deep effects: ${DEEP_EFFECTS.length} written`);
