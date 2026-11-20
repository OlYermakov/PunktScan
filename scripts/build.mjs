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
hash.update(await fs.readFile('models/ppocrv6-tiny/rec.onnx'));
const version = hash.digest('hex').slice(0, 10);
await fs.rm('dist', { recursive: true, force: true });
await fs.mkdir('dist', { recursive: true });
await fs.cp('src', 'dist', { recursive: true });
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
// Second recogniser: PaddleOCR PP-OCRv6 tiny (models/ppocrv6-tiny) on ONNX Runtime Web, which
// runs it single-threaded in WebAssembly (GitHub Pages cannot send the headers threads need).
const MODEL_SHA256 = '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6';
const model = await fs.readFile('models/ppocrv6-tiny/rec.onnx');
if (crypto.createHash('sha256').update(model).digest('hex') !== MODEL_SHA256)
  throw new Error('models/ppocrv6-tiny/rec.onnx is not the expected PP-OCRv6 tiny model.');
await fs.mkdir('dist/vendor/ort', { recursive: true });
await fs.mkdir('dist/vendor/paddle', { recursive: true });
for (const file of [
  'ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
])
  await fs.copyFile('node_modules/onnxruntime-web/dist/' + file, 'dist/vendor/ort/' + file);
await fs.writeFile('dist/vendor/paddle/rec.onnx', model);
await fs.copyFile('models/ppocrv6-tiny/dict.json', 'dist/vendor/paddle/dict.json');
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
notices.push(
  'onnxruntime-web ' +
    JSON.parse(await fs.readFile('node_modules/onnxruntime-web/package.json', 'utf8')).version +
    '\nMIT License\n\nCopyright (c) Microsoft Corporation\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  'PaddleOCR PP-OCRv6 tiny recognition model\n' +
    (await fs.readFile('models/ppocrv6-tiny/README.md', 'utf8')) +
    '\nApache License 2.0: https://www.apache.org/licenses/LICENSE-2.0',
);
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
