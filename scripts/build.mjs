import { themeCss } from './themes.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Cache-busting version: a hash of every source file and the bundled OCR versions.
// Replaces the __BUILD__ placeholder so assets never need manual version bumps.
async function walk(dir) {
  const out = [];
  for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
const hash = crypto.createHash('sha256');
for (const file of await walk('src')) {
  hash.update(file);
  hash.update(await fs.readFile(file));
}
hash.update(await fs.readFile('package-lock.json'));
hash.update(await fs.readFile('scripts/themes.mjs'));
const version = hash.digest('hex').slice(0, 10);
await fs.rm('dist', { recursive: true, force: true });
await fs.mkdir('dist', { recursive: true });
await fs.cp('src', 'dist', { recursive: true });
// Dark and high-contrast themes are derived from the stylesheet (see scripts/themes.mjs).
await fs.appendFile('dist/style.css', '\n' + themeCss(await fs.readFile('src/style.css', 'utf8')));
const tesseractVersion = JSON.parse(
  await fs.readFile('node_modules/tesseract.js/package.json', 'utf8'),
).version;
const modules = (await fs.readdir('src')).filter((f) => f.endsWith('.js') && f !== 'sw.js').sort();
for (const file of (await fs.readdir('dist')).filter((f) => /\.(js|html)$/.test(f))) {
  const f = 'dist/' + file;
  await fs.writeFile(
    f,
    (await fs.readFile(f, 'utf8'))
      .replace(/\/\* __MODULES__ \*\/ \[[^\]]*\]/, JSON.stringify(modules))
      .replaceAll('__BUILD__', version)
      .replaceAll('__TESSERACT_VERSION__', tesseractVersion),
  );
}
await fs.mkdir('dist/vendor/core', { recursive: true });
await fs.mkdir('dist/vendor/lang', { recursive: true });
for (const file of ['tesseract.min.js', 'worker.min.js'])
  await fs.copyFile('node_modules/tesseract.js/dist/' + file, 'dist/vendor/' + file);
// ocr.js creates the worker with OEM 1 (LSTM only), so Tesseract only ever loads the *-lstm
// cores (plain, SIMD or relaxed SIMD, depending on the browser). The legacy cores are skipped.
for (const file of await fs.readdir('node_modules/tesseract.js-core'))
  if (file.endsWith('-lstm.wasm.js'))
    await fs.copyFile('node_modules/tesseract.js-core/' + file, 'dist/vendor/core/' + file);
await fs.copyFile(
  'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
  'dist/vendor/lang/eng.traineddata.gz',
);
const notices = ['PunktScan\n' + (await fs.readFile('LICENSE', 'utf8'))];
for (const pkg of ['tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng']) {
  const root = 'node_modules/' + pkg,
    files = await fs.readdir(root);
  const license = files.find((f) => /^LICENSE/i.test(f));
  notices.push(
    pkg +
      '\n' +
      (license
        ? await fs.readFile(root + '/' + license, 'utf8')
        : 'English trained data for Tesseract. Apache License 2.0. https://github.com/naptha/tessdata'),
  );
}
await fs.writeFile('dist/licenses.txt', notices.join('\n\n---\n\n'));
await fs.writeFile('dist/.nojekyll', '');
async function list(dir) {
  const result = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) result.push(...(await list(p)));
    else result.push('./' + path.relative('dist', p));
  }
  return result;
}
const files = (await list('dist')).filter(
  (p) => !p.endsWith('sw.js') && !p.endsWith('offline-assets.json') && !p.endsWith('.nojekyll'),
);
for (const f of [...modules, 'style.css']) files.push('./' + f + '?v=' + version);
await fs.writeFile('dist/offline-assets.json', JSON.stringify(files));
let offlineBytes = 0;
for (const f of files) offlineBytes += (await fs.stat(path.join('dist', f.split('?')[0]))).size;
const offlineMB = String(Math.ceil(offlineBytes / 1e6));
for (const file of modules) {
  const f = 'dist/' + file;
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replaceAll('__OFFLINE_MB__', offlineMB));
}
console.log(
  `Built PunktScan ${version}: ${files.length} offline assets, ${offlineMB} MB, Tesseract.js ${tesseractVersion}.`,
);
