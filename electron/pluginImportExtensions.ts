/**
 * P7b: the footage extensions installed native plugins import (manifest
 * `importers[].extensions`, docs/PLUGIN_SDK.md "Importers"), for the media
 * file picker's filter. Read from the bundles' manifests — no plugin code runs
 * in main; the engine decides at import whether a loaded plugin reads the file.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST = 'premation-plugin.json';
const EXT_RE = /^[a-z0-9]{1,16}$/;

async function manifestExtensions(file: string): Promise<string[]> {
  try {
    const m = JSON.parse(await readFile(file, 'utf8')) as { importers?: unknown };
    if (!Array.isArray(m.importers)) return [];
    const out: string[] = [];
    for (const imp of m.importers) {
      const exts = imp && typeof imp === 'object' ? (imp as { extensions?: unknown }).extensions : undefined;
      if (!Array.isArray(exts)) continue;
      for (const e of exts) {
        const x = typeof e === 'string' ? e.replace(/^\./, '').toLowerCase() : '';
        if (EXT_RE.test(x)) out.push(x);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Every importer extension of the bundles in `roots` (a root may itself be a bundle). Never throws. */
export async function pluginImportExtensions(roots: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    for (const e of await manifestExtensions(path.join(root, MANIFEST))) found.add(e);
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries.slice(0, 500)) {
      for (const e of await manifestExtensions(path.join(root, name, MANIFEST))) found.add(e);
    }
  }
  return [...found].sort();
}
