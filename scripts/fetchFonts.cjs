#!/usr/bin/env node
/**
 * `node scripts/fetchFonts.cjs` — download the fonts Premation ships into
 * resources/fonts and regenerate resources/fonts/fonts.json (README there).
 *
 * Every family is SIL Open Font License 1.1, fetched from the google/fonts
 * repository with its OFL.txt. A file already present is kept (delete it to
 * fetch again). Nothing here runs at install or build time: the folder is
 * checked in once fetched, and electron-builder ships it.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const OUT = path.join(__dirname, '..', 'resources', 'fonts');
const RAW = 'https://raw.githubusercontent.com/google/fonts/main/ofl';

/**
 * Per-character fallbacks, in fallback order: one variable upright face each.
 * family → [google/fonts folder, file].
 */
const FALLBACKS = [
  ['Inter', 'inter', 'Inter[opsz,wght].ttf'],
  ['Noto Sans', 'notosans', 'NotoSans[wdth,wght].ttf'],
  ['Noto Serif', 'notoserif', 'NotoSerif[wdth,wght].ttf'],
  ['Noto Sans JP', 'notosansjp', 'NotoSansJP[wght].ttf'],
  ['Noto Serif JP', 'notoserifjp', 'NotoSerifJP[wght].ttf'],
  ['Noto Sans SC', 'notosanssc', 'NotoSansSC[wght].ttf'],
  ['Noto Sans TC', 'notosanstc', 'NotoSansTC[wght].ttf'],
  ['Noto Sans KR', 'notosanskr', 'NotoSansKR[wght].ttf'],
  ['Noto Sans Devanagari', 'notosansdevanagari', 'NotoSansDevanagari[wdth,wght].ttf'],
  ['Noto Sans Thai', 'notosansthai', 'NotoSansThai[wdth,wght].ttf'],
  ['Noto Sans Arabic', 'notosansarabic', 'NotoSansArabic[wdth,wght].ttf'],
  ['Noto Sans Hebrew', 'notosanshebrew', 'NotoSansHebrew[wdth,wght].ttf'],
];

/**
 * Design families the font menu offers — drawn when picked, never used as a
 * fallback. Each face: [file, weight, style]. A variable file stands for its
 * whole `wght` range (the engine reads the axis); weight is its default.
 */
const DESIGN = [
  ['Roboto', 'roboto', [['Roboto[wdth,wght].ttf', 400, 'normal'], ['Roboto-Italic[wdth,wght].ttf', 400, 'italic']]],
  ['Open Sans', 'opensans', [['OpenSans[wdth,wght].ttf', 400, 'normal'], ['OpenSans-Italic[wdth,wght].ttf', 400, 'italic']]],
  ['Montserrat', 'montserrat', [['Montserrat[wght].ttf', 400, 'normal'], ['Montserrat-Italic[wght].ttf', 400, 'italic']]],
  ['Outfit', 'outfit', [['Outfit[wght].ttf', 400, 'normal']]],
  ['Playfair Display', 'playfairdisplay', [['PlayfairDisplay[wght].ttf', 400, 'normal'], ['PlayfairDisplay-Italic[wght].ttf', 400, 'italic']]],
  ['Lora', 'lora', [['Lora[wght].ttf', 400, 'normal'], ['Lora-Italic[wght].ttf', 400, 'italic']]],
  ['Merriweather', 'merriweather', [['Merriweather[opsz,wdth,wght].ttf', 400, 'normal'], ['Merriweather-Italic[opsz,wdth,wght].ttf', 400, 'italic']]],
  ['Fira Code', 'firacode', [['FiraCode[wght].ttf', 400, 'normal']]],
  ['PT Sans', 'ptsans', [
    ['PT_Sans-Web-Regular.ttf', 400, 'normal'], ['PT_Sans-Web-Bold.ttf', 700, 'normal'],
    ['PT_Sans-Web-Italic.ttf', 400, 'italic'], ['PT_Sans-Web-BoldItalic.ttf', 700, 'italic'],
  ]],
  ['Oswald', 'oswald', [['Oswald[wght].ttf', 400, 'normal']]],
  ['Raleway', 'raleway', [['Raleway[wght].ttf', 400, 'normal'], ['Raleway-Italic[wght].ttf', 400, 'italic']]],
  ['DM Sans', 'dmsans', [['DMSans[opsz,wght].ttf', 400, 'normal'], ['DMSans-Italic[opsz,wght].ttf', 400, 'italic']]],
  ['Space Grotesk', 'spacegrotesk', [['SpaceGrotesk[wght].ttf', 400, 'normal']]],
  ['Bebas Neue', 'bebasneue', [['BebasNeue-Regular.ttf', 400, 'normal']]],
  ['Anton', 'anton', [['Anton-Regular.ttf', 400, 'normal']]],
  ['Poppins', 'poppins', [
    ['Poppins-Thin.ttf', 100, 'normal'], ['Poppins-ExtraLight.ttf', 200, 'normal'], ['Poppins-Light.ttf', 300, 'normal'],
    ['Poppins-Regular.ttf', 400, 'normal'], ['Poppins-Medium.ttf', 500, 'normal'], ['Poppins-SemiBold.ttf', 600, 'normal'],
    ['Poppins-Bold.ttf', 700, 'normal'], ['Poppins-ExtraBold.ttf', 800, 'normal'], ['Poppins-Black.ttf', 900, 'normal'],
    ['Poppins-Italic.ttf', 400, 'italic'], ['Poppins-BoldItalic.ttf', 700, 'italic'],
  ]],
];

function get(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        get(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${url}: HTTP ${res.statusCode}`));
        return;
      }
      const tmp = `${dest}.part`;
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      file.on('error', reject);
    }).on('error', reject);
  });
}

/** The `fvar` axes of an sfnt file: [{tag, min, default, max}], [] for a static face. */
function variableAxes(file) {
  const b = fs.readFileSync(file);
  const numTables = b.readUInt16BE(4);
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (b.toString('latin1', rec, rec + 4) !== 'fvar') continue;
    const at = b.readUInt32BE(rec + 8);
    const axesAt = at + b.readUInt16BE(at + 4);
    const count = b.readUInt16BE(at + 8);
    const size = b.readUInt16BE(at + 10);
    const fixed = (o) => Math.round((b.readInt32BE(o) / 65536) * 100) / 100;
    const axes = [];
    for (let k = 0; k < count; k += 1) {
      const a = axesAt + k * size;
      axes.push({ tag: b.toString('latin1', a, a + 4), min: fixed(a + 4), default: fixed(a + 8), max: fixed(a + 12) });
    }
    return axes;
  }
  return [];
}

const withAxes = (face) => {
  const axes = variableAxes(path.join(OUT, face.file));
  return axes.length ? { ...face, axes } : face;
};

const localName = (file) => file.replace(/[[\],]/g, (c) => ({ '[': '-', ']': '', ',': '-' })[c]);

async function fetchFace(family, folder, file) {
  const local = localName(file);
  const dest = path.join(OUT, local);
  const license = path.join(OUT, `${folder}-OFL.txt`);
  if (!fs.existsSync(dest)) {
    process.stdout.write(`fetching ${family} (${file})… `);
    await get(`${RAW}/${folder}/${encodeURIComponent(file)}`, dest);
    console.log(`${Math.round(fs.statSync(dest).size / 1024)} KiB`);
  }
  if (!fs.existsSync(license)) await get(`${RAW}/${folder}/OFL.txt`, license);
  return local;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const faces = [];
  let wanted = 0;
  for (const [family, folder, file] of FALLBACKS) {
    wanted += 1;
    try {
      faces.push(withAxes({ family, weight: 400, style: 'normal', file: await fetchFace(family, folder, file), fallback: true }));
    } catch (e) {
      console.error(`\n${family}: ${e.message} — left out of fonts.json`);
    }
  }
  for (const [family, folder, list] of DESIGN) {
    for (const [file, weight, style] of list) {
      wanted += 1;
      try {
        faces.push(withAxes({ family, weight, style, file: await fetchFace(family, folder, file) }));
      } catch (e) {
        console.error(`\n${family}: ${e.message} — left out of fonts.json`);
      }
    }
  }
  const manifest = {
    _comment: 'Generated by scripts/fetchFonts.cjs — the fonts Premation ships (resources/fonts/README.md). Faces marked `fallback` are per-character fallbacks, in this order; the rest are design families for the font menu.',
    faces,
  };
  fs.writeFileSync(path.join(OUT, 'fonts.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`fonts.json: ${faces.length} of ${wanted} faces`);
}

main().catch((e) => { console.error(e); process.exit(1); });
