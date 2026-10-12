// Layer Stats — a plugin PANEL without an effect (SDK 1.2, docs/PLUGIN_SDK.md
// "Panels"). It runs in the editor's sandboxed frame (no Node, no network) and
// reaches the document only through the editor's message API:
//   { type: 'query',   id, request }   the engine API's queries, as JSON
//   { type: 'command', id, request, label? }  an edit (origin `plugin`, ONE undo entry)
// The editor sends { type: 'context', comp, layers, time } on ready and after
// every document, selection or time change.
/* global window, document */
'use strict';

const PLUGIN = 'com.premation.samples.statspanel';
let nextId = 1;
const pending = new Map();
let context = { comp: '', layers: [], time: 0 };

function send(msg) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ premation: 1, id, ...msg }, '*');
  });
}

const query = (request) => send({ type: 'query', request });
const command = (request, label) => send({ type: 'command', request, label });

function status(text) {
  document.getElementById('status').textContent = text;
}

async function refresh() {
  const compEl = document.getElementById('comp');
  const kindsEl = document.getElementById('kinds');
  const layersEl = document.getElementById('layers');
  kindsEl.textContent = '';
  layersEl.textContent = '';
  if (!context.comp) {
    compEl.textContent = 'No composition.';
    return;
  }
  try {
    const r = await query({ type: 'getComposition', comp: context.comp });
    compEl.textContent = `${r.comp.settings.name}: ${r.layers.length} layer${r.layers.length === 1 ? '' : 's'}`;
    const counts = new Map();
    for (const l of r.layers) counts.set(l.kind, (counts.get(l.kind) || 0) + 1);
    for (const [kind, n] of counts) {
      const li = document.createElement('li');
      li.textContent = `${kind} ${n}`;
      kindsEl.appendChild(li);
    }
    for (const l of r.layers) {
      const li = document.createElement('li');
      li.textContent = l.name;
      if (context.layers.includes(l.id)) li.className = 'selected';
      layersEl.appendChild(li);
    }
  } catch (e) {
    compEl.textContent = `Could not read the composition: ${e.message}`;
  }
}

document.getElementById('number').addEventListener('click', async () => {
  const prefix = document.getElementById('prefix').value.trim() || 'Layer';
  if (context.layers.length === 0) {
    status('Select layers first.');
    return;
  }
  try {
    // The plugin's own command (one undo entry), through the engine API like any edit.
    const r = await command(
      { type: 'runPluginCommand', plugin: PLUGIN, command: 'number', comp: context.comp, layers: context.layers, time: context.time, args: JSON.stringify({ prefix }) },
      'Number Layers',
    );
    status(r.message || 'Done.');
  } catch (e) {
    status(e.message);
  }
});

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const msg = e.data;
  if (!msg || msg.premation !== 1) return;
  if (msg.type === 'reply') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'failed'));
  } else if (msg.type === 'context') {
    context = { comp: msg.comp || '', layers: msg.layers || [], time: msg.time || 0 };
    void refresh();
  }
});

window.parent.postMessage({ premation: 1, type: 'ready' }, '*');
