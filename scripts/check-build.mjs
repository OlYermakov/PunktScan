import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root=path.resolve('dist');
const bases=['https://example.test/','https://example.test/PunktScan/'];
const index=await fs.readFile(path.join(root,'index.html'),'utf8');
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.webmanifest'),'utf8'));
const offline=JSON.parse(await fs.readFile(path.join(root,'offline-assets.json'),'utf8'));
const sw=await fs.readFile(path.join(root,'sw.js'),'utf8');
const context=vm.createContext({self:{addEventListener(){}}});
vm.runInContext(sw,context);
const shell=vm.runInContext('ASSETS',context);
const htmlAssets=Array.from(index.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g),m=>m[1]);
const moduleAssets=[];
for(const file of ['app.js','core.js','imaging.js']){
 const text=await fs.readFile(path.join(root,file),'utf8');
 moduleAssets.push(...Array.from(text.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g),m=>m[1]));
}
const assets=new Set([...offline,...shell,...htmlAssets,...moduleAssets,...manifest.icons.map(i=>i.src),'./sw.js','./vendor/tesseract.min.js','./vendor/worker.min.js','./vendor/lang/eng.traineddata.gz']);
for(const base of bases){
 for(const asset of assets){
  const url=new URL(asset,base);
  assert.equal(url.origin,new URL(base).origin,'External asset: '+asset);
  assert.ok(url.pathname.startsWith(new URL(base).pathname),'Asset escapes project directory: '+asset);
  let relative=decodeURIComponent(url.pathname.slice(new URL(base).pathname.length));
  if(!relative||relative.endsWith('/'))relative+='index.html';
  const stat=await fs.stat(path.join(root,relative));
  assert.ok(stat.isFile()&&stat.size>0,'Missing or empty asset: '+asset);
 }
 assert.equal(new URL(manifest.scope,base).href,base);
 assert.equal(new URL(manifest.start_url,base).href,base);
}
const cores=await fs.readdir(path.join(root,'vendor/core'));
assert.ok(cores.some(f=>f.endsWith('.wasm.js')),'OCR WebAssembly runtime missing');
await fs.access(path.join(root,'.nojekyll'));
assert.equal(new Set(offline).size,offline.length,'Duplicate offline entries');
console.log('Verified '+assets.size+' asset URLs at / and /PunktScan/, including PWA scope and OCR files.');
