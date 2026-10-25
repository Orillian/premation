// Measure each chrome glyph's ink box (headless Electron, getBBox) → JSON.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [out] = process.argv.slice(2);
const src = fs.readFileSync(path.resolve('src/components/Icon/drawnIcons.ts'), 'utf8');
const names = [...src.matchAll(/^  '([a-z0-9-]+)',$/gm)].map((m) => m[1]).filter((n) => n !== 'diamond');
const glyphs = {};
for (const n of names) {
  const m = src.match(new RegExp("^  '" + n + "': '(.*?)',$", 'm'));
  if (!m) throw new Error('no glyph ' + n);
  glyphs[n] = m[1].replace(/\\'/g, "'");
}
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  const res = await win.webContents.executeJavaScript(`(() => {
    const g = ${JSON.stringify(glyphs)};
    const out = {};
    for (const [n, markup] of Object.entries(g)) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '160'); svg.setAttribute('height', '160');
      svg.innerHTML = markup;
      document.body.appendChild(svg);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const el of svg.querySelectorAll('path,circle,rect,ellipse,line,polygon')) {
        const b = el.getBBox();
        if (b.width === 0 && b.height === 0) continue;
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
      }
      out[n] = { x0, y0, x1, y1 };
      svg.remove();
    }
    return out;
  })()`);
  fs.writeFileSync(path.resolve(out), JSON.stringify(res, null, 1));
  app.quit();
});
