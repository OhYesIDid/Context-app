#!/usr/bin/env node
/**
 * Generates Android mipmap launcher PNGs from contxt-logo-d4-hex.svg
 * Uses Chrome headless to rasterise the SVG, jimp-compact to resize.
 *
 * Usage: node scripts/gen-android-icons.js
 */

const { execFileSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT    = path.join(__dirname, '..');
const SVG_SRC = path.join(ROOT, 'assets', 'contxt-logo-d4-hex.svg');
const RES_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

// mipmap density → launcher icon size in px
const SIZES = {
  'mipmap-mdpi':    48,
  'mipmap-hdpi':    72,
  'mipmap-xhdpi':   96,
  'mipmap-xxhdpi':  144,
  'mipmap-xxxhdpi': 192,
};

// ── 1. Render SVG → 1024×1024 PNG via Chrome headless ─────────────────────
function chromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Chrome not found');
}

function renderSvgToPng(svgPath, outPath, size) {
  const tmpHtml = path.join(os.tmpdir(), 'icon_render.html');
  const svgContent = fs.readFileSync(svgPath, 'utf8');
  fs.writeFileSync(tmpHtml, `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;background:transparent}</style></head>
<body><div style="width:${size}px;height:${size}px;overflow:hidden">${svgContent}</div></body></html>`);

  const chrome = chromePath();
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--window-size=${size},${size}`,
    `--screenshot=${outPath}`,
    `file:///${tmpHtml.replace(/\\/g, '/')}`,
  ], { stdio: 'pipe' });
}

// ── 2. Resize 1024×1024 PNG → target size using jimp-compact ───────────────
async function resizeIcon(srcPng, dstPng, size) {
  const Jimp = require(path.join(ROOT, 'node_modules', 'jimp-compact'));
  const img = await Jimp.read(srcPng);
  await img.resize(size, size).writeAsync(dstPng);
}

async function main() {
  const tmpPng = path.join(os.tmpdir(), 'contxt_icon_1024.png');

  console.log('Rendering SVG at 1024×1024 via Chrome headless…');
  renderSvgToPng(SVG_SRC, tmpPng, 1024);
  console.log(`  → ${tmpPng}`);

  for (const [density, px] of Object.entries(SIZES)) {
    const dir = path.join(RES_DIR, density);
    if (!fs.existsSync(dir)) { console.warn(`  skip ${density} (dir missing)`); continue; }

    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const dst = path.join(dir, name);
      await resizeIcon(tmpPng, dst, px);
      console.log(`  ✓ ${density}/${name}  (${px}×${px})`);
    }
  }

  console.log('\nDone. Rebuild the app to pick up the new icons.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
