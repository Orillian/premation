// Model 3D material panel (Premation SDK 1.2 sample). Runs in a sandboxed frame:
// no Node, no network. It talks to the editor only through postMessage
// (docs/PLUGIN_SDK.md "Plugin panels"): it reads `state` and sends setParam /
// requestPreview. Every edit goes through the engine, so undo and redo work.
/* global window, document */
'use strict';

// The param keys (model3d.cpp: kBaseColor = 8, kRoughness = 9, kSpecular = 10, kSceneDepth = 13).
const COLOR = 'p8';
const ROUGHNESS = 'p9';
const SPECULAR = 'p10';
const DEPTH = 'p13';

let nextId = 1;
const pending = new Map();
const $ = (id) => document.getElementById(id);

function send(msg) {
  window.parent.postMessage(Object.assign({ premation: 1 }, msg), '*');
}

function request(msg) {
  const id = nextId++;
  send(Object.assign({ id }, msg));
  return new Promise((resolve) => pending.set(id, resolve));
}

function status(text) { $('status').textContent = text || ''; }

/** A colour value as stored ({ r, g, b, a } or [r, g, b, a], 0..1) → #rrggbb. */
function toHex(v) {
  const c = Array.isArray(v) ? v : v && typeof v === 'object' ? [v.r, v.g, v.b] : null;
  if (!c) return null;
  return '#' + c.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, Number(x) || 0)) * 255).toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

function slider(key, id, value) {
  if (typeof value !== 'number') return;
  $(id).value = String(value);
  $(id + 'Value').textContent = String(Math.round(value));
}

async function set(key, value) {
  const r = await request({ type: 'setParam', key, value });
  status(r.ok ? '' : r.error);
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.premation !== 1) return;
  if (m.type === 'state') {
    const v = m.values || {};
    const hex = toHex(v[COLOR]);
    if (hex) $('color').value = hex;
    slider(ROUGHNESS, 'roughness', v[ROUGHNESS]);
    slider(SPECULAR, 'specular', v[SPECULAR]);
    $('depth').checked = v[DEPTH] === true || v[DEPTH] === 1;
  } else if (m.type === 'reply' && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});

$('color').addEventListener('change', (e) => set(COLOR, fromHex(e.target.value)));
$('roughness').addEventListener('input', (e) => { $('roughnessValue').textContent = e.target.value; });
$('roughness').addEventListener('change', (e) => set(ROUGHNESS, Number(e.target.value)));
$('specular').addEventListener('input', (e) => { $('specularValue').textContent = e.target.value; });
$('specular').addEventListener('change', (e) => set(SPECULAR, Number(e.target.value)));
$('depth').addEventListener('change', (e) => set(DEPTH, e.target.checked));
$('clay').addEventListener('click', async () => {
  await set(COLOR, fromHex('#b08a6e'));
  await set(ROUGHNESS, 90);
  await set(SPECULAR, 5);
});
$('chrome').addEventListener('click', async () => {
  await set(ROUGHNESS, 8);
  await set(SPECULAR, 100);
});
$('preview').addEventListener('click', async () => {
  const r = await request({ type: 'requestPreview', maxSize: 320 });
  if (r.ok && r.image) { $('frame').src = r.image; $('frame').hidden = false; } else status(r.error || 'No preview.');
});

send({ type: 'ready' });

// Edit > Undo / Redo while focus is in this frame: the editor's shortcuts never see a key pressed
// in a sandboxed frame, so the panel forwards them (docs/PLUGIN_SDK.md "Plugin panels"). A text
// field keeps its own undo.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = e.target;
  const typing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search|number|email|url|password)$/.test(t.type)));
  if (typing) return;
  const k = e.key.toLowerCase();
  const action = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && !e.shiftKey ? 'redo' : null;
  if (!action) return;
  e.preventDefault();
  window.parent.postMessage({ premation: 1, type: 'shortcut', action }, '*');
});
