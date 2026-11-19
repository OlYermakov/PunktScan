import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = path.resolve('dist');
const bases = ['https://example.test/', 'https://example.test/PunktScan/'];
const index = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.webmanifest'), 'utf8'));
const offline = JSON.parse(await fs.readFile(path.join(root, 'offline-assets.json'), 'utf8'));
const sw = await fs.readFile(path.join(root, 'sw.js'), 'utf8');
const context = vm.createContext({ self: { addEventListener() {} } });
vm.runInContext(sw, context);
const shell = vm.runInContext('ASSETS', context);
const htmlAssets = Array.from(index.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g), (m) => m[1]);
const moduleAssets = [];
const modules = (await fs.readdir(root)).filter((f) => f.endsWith('.js') && f !== 'sw.js');
for (const file of modules) {
  const text = await fs.readFile(path.join(root, file), 'utf8');
  moduleAssets.push(...Array.from(text.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g), (m) => m[1]));
}
const assets = new Set([
  ...offline,
  ...shell,
  ...htmlAssets,
  ...moduleAssets,
  ...manifest.icons.map((i) => i.src),
  './sw.js',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './vendor/lang/eng.traineddata.gz',
]);
for (const base of bases) {
  for (const asset of assets) {
    const url = new URL(asset, base);
    assert.equal(url.origin, new URL(base).origin, 'External asset: ' + asset);
    assert.ok(
      url.pathname.startsWith(new URL(base).pathname),
      'Asset escapes project directory: ' + asset,
    );
    let relative = decodeURIComponent(url.pathname.slice(new URL(base).pathname.length));
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const stat = await fs.stat(path.join(root, relative));
    assert.ok(stat.isFile() && stat.size > 0, 'Missing or empty asset: ' + asset);
  }
  assert.equal(new URL(manifest.scope, base).href, base);
  assert.equal(new URL(manifest.start_url, base).href, base);
}
const cores = await fs.readdir(path.join(root, 'vendor/core'));
assert.ok(
  cores.some((f) => f.endsWith('.wasm.js')),
  'OCR WebAssembly runtime missing',
);
await fs.access(path.join(root, '.nojekyll'));
for (const file of ['index.html', 'sw.js', ...modules])
  for (const token of ['__TESSERACT_VERSION__', '__OFFLINE_MB__'])
    assert.ok(
      !(await fs.readFile(path.join(root, file), 'utf8')).includes(token),
      'Unreplaced ' + token + ' in ' + file,
    );
for (const file of ['index.html', 'sw.js', ...modules])
  assert.ok(
    !(await fs.readFile(path.join(root, file), 'utf8')).includes('__BUILD__'),
    'Unreplaced build version in ' + file,
  );
const version = vm.runInContext('SHELL', context).replace('punktscan-shell-', '');
assert.match(version, /^[0-9a-f]{10}$/, 'Invalid build version');
for (const asset of [...shell, ...htmlAssets, ...moduleAssets].filter((a) => a.includes('?v=')))
  assert.equal(asset.split('?v=')[1], version, 'Stale asset version: ' + asset);
assert.equal(new Set(offline).size, offline.length, 'Duplicate offline entries');
console.log(
  'Verified ' +
    assets.size +
    ' asset URLs at / and /PunktScan/, including PWA scope and OCR files.',
);
// Every module must be in the offline shell, and all imports must use the same versioned URL;
// otherwise the browser would load a module twice and the copies would not share state.
for (const file of modules)
  assert.ok(shell.includes('./' + file + '?v=' + version), 'Module missing from SW shell: ' + file);
for (const asset of moduleAssets)
  assert.match(asset, new RegExp('\\?v=' + version + '$'), 'Unversioned module import: ' + asset);
// Only the LSTM cores are bundled, so the worker must stay on OEM 1 (LSTM only).
assert.match(
  await fs.readFile(path.join(root, 'ocr.js'), 'utf8'),
  /createWorker\('eng', 1,/,
  'ocr.js must use OEM 1: only *-lstm Tesseract cores are bundled',
);
for (const variant of ['', '-simd', '-relaxedsimd'])
  assert.ok(cores.includes(`tesseract-core${variant}-lstm.wasm.js`), 'Missing core' + variant);
// Language dictionaries are loaded with import(): they must carry the same version too.
for (const file of modules) {
  const text = await fs.readFile(path.join(root, file), 'utf8');
  for (const [, url] of text.matchAll(/import\(\s*[`'"](\.\/[^`'"]+)[`'"]\s*\)/g))
    assert.ok(url.endsWith('?v=' + version), `Unversioned dynamic import in ${file}: ${url}`);
}
const languages = modules.filter((f) => /^lang-[a-z]{2}\.js$/.test(f));
assert.ok(languages.length >= 7, 'Missing language dictionaries: ' + languages.join(', '));
