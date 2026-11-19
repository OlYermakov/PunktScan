import fs from 'node:fs/promises';
import path from 'node:path';
await fs.rm('dist',{recursive:true,force:true});
await fs.mkdir('dist',{recursive:true});
await fs.cp('src','dist',{recursive:true});
await fs.mkdir('dist/vendor/core',{recursive:true});await fs.mkdir('dist/vendor/lang',{recursive:true});
for(const file of ['tesseract.min.js','worker.min.js'])await fs.copyFile('node_modules/tesseract.js/dist/'+file,'dist/vendor/'+file);
for(const file of await fs.readdir('node_modules/tesseract.js-core'))if(file.endsWith('.wasm.js'))await fs.copyFile('node_modules/tesseract.js-core/'+file,'dist/vendor/core/'+file);
await fs.copyFile('node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz','dist/vendor/lang/eng.traineddata.gz');
const notices=[];
for(const pkg of ['tesseract.js','tesseract.js-core','@tesseract.js-data/eng']){
 const root='node_modules/'+pkg,files=await fs.readdir(root);const license=files.find(f=>/^LICENSE/i.test(f));
 notices.push(pkg+'\n'+(license?await fs.readFile(root+'/'+license,'utf8'):'English trained data for Tesseract. Apache License 2.0. https://github.com/naptha/tessdata'));
}
await fs.writeFile('dist/licenses.txt',notices.join('\n\n---\n\n'));
await fs.writeFile('dist/.nojekyll','');
async function list(dir){const result=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())result.push(...await list(p));else result.push('./'+path.relative('dist',p));}return result;}
const files=(await list('dist')).filter(p=>!p.endsWith('sw.js')&&!p.endsWith('offline-assets.json')&&!p.endsWith('.nojekyll'));
for(const f of ['app.js','core.js','imaging.js','style.css'])files.push('./'+f+'?v=7');
await fs.writeFile('dist/offline-assets.json',JSON.stringify(files));
console.log('Built PunktScan: '+files.length+' offline assets.');
