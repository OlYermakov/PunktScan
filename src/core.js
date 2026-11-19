// Exact decimal handling: coordinates never pass through binary floating point for export.
export function coordinate(raw, optional = false) {
  let s = String(raw ?? '').trim().replace(/\u2212/g, '-');
  if (!s) return optional ? {ok:true, empty:true, value:'', mm:null} : {ok:false, error:'required'};
  if (/\s/.test(s)) {
    if (!/^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,3})?$/.test(s)) return {ok:false,error:'number'};
    s = s.replace(/\s/g,'');
  }
  if (s.includes('.') && s.includes(',')) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    const [whole, fraction, ...rest] = s.split(decimal);
    const re = new RegExp('^[+-]?\\d{1,3}(?:\\'+group+'\\d{3})+$');
    if (rest.length || !re.test(whole)) return {ok:false,error:'number'};
    s = whole.split(group).join('')+'.'+fraction;
  } else s = s.replace(',', '.');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(s)) return {ok:false,error:'number'};
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 3) return {ok:false,error:'precision'};
  const negative = whole.startsWith('-');
  let mm = BigInt(whole.replace(/^[+-]/,'')) * 1000n + BigInt(frac.padEnd(3,'0'));
  if (mm > 9999999999999999n) return {ok:false,error:'range'};
  if (negative) mm = -mm;
  const abs = mm < 0n ? -mm : mm;
  return {ok:true, mm, value:(mm < 0n?'-':'')+(abs/1000n)+'.'+String(abs%1000n).padStart(3,'0'), short:frac.length<3};
}

export function pointName(raw) {
  const name = String(raw ?? '').replace(/\s/g,'');
  if (!name) return {ok:false,error:'nameRequired', name};
  if (name.length > 16) return {ok:false,error:'nameLength', name};
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return {ok:false,error:'nameChars', name};
  return {ok:true,name,key:name.replace(/^0+(?=.)/,'').toLowerCase()};
}

export function validate(rows) {
  const names = new Map();
  const values = rows.map(row=>{
    const name=pointName(row.name), e=coordinate(row.e), n=coordinate(row.n), h=coordinate(row.h,true);
    const issues=[];
    if (!name.ok) issues.push({field:'name',code:name.error});
    if (!e.ok) issues.push({field:'e',code:e.error});
    if (!n.ok) issues.push({field:'n',code:n.error});
    if (!h.ok) issues.push({field:'h',code:h.error});
    if(name.ok) names.set(name.key,(names.get(name.key)||0)+1);
    return {row,name,e,n,h,issues};
  });
  for(const v of values) if(v.name.ok && names.get(v.name.key)>1) v.issues.push({field:'name',code:'duplicate'});
  return values;
}

export function gsi(rows) {
  if(!rows.length) throw new Error('empty');
  const values=validate(rows);
  if(values.some(v=>v.issues.length)) throw new Error('invalid');
  if(rows.some(r=>!r.verified)) throw new Error('unverified');
  return values.map((v,i)=>{
    const words=[`11${String((i+1)%10000).padStart(4,'0')}+${v.name.name.padStart(16,'0')}`];
    for(const [wi,c] of [['81',v.e],['82',v.n],['83',v.h]]) if(!c.empty){
      const abs=c.mm<0n?-c.mm:c.mm;
      words.push(`${wi}..00${c.mm<0n?'-':'+'}${String(abs).padStart(16,'0')}`);
    }
    return '*'+words.join(' ')+' \r\n';
  }).join('');
}

export function csv(rows) {
  const values=validate(rows);
  if(!rows.length||values.some(v=>v.issues.length)||rows.some(r=>!r.verified)) throw new Error('invalid');
  const cell=s=>'"'+String(s).replaceAll('"','""')+'"';
  // Reject spreadsheet formula triggers through pointName validation; neutralize leading minus IDs.
  return '\ufeff'+[['Punkt','Rechtswert','Hochwert','Hoehe'],...values.map(v=>[(/^[=+\-@]/.test(v.name.name)?"'":'')+v.name.name,v.e.value.replace('.',','),v.n.value.replace('.',','),v.h.value.replace('.',',')])].map(r=>r.map(cell).join(';')).join('\r\n')+'\r\n';
}

export function parseText(text, order='en') {
  const result=[], skipped=[];
  const lines=String(text).replace(/\r/g,'').split('\n');
  for(let i=0;i<lines.length;i++) {
    const original=lines[i].trim(); if(!original) continue;
    if(/rechtswert|hochwert|easting|northing|koordinaten|punktnummer|absteckpunkt|^punkt[;\t ]|^name[;\t ]/i.test(original)) continue;
    let name,e,n,h='';
    if(/[;\t]/.test(original)) {
      const cols=original.split(/[;\t]/).map(v=>v.trim().replace(/^"|"$/g,'').replace(/""/g,'"'));
      if(cols.length>=3 && cols.length<=4) [name,e,n,h='']=cols;
    }
    if(name===undefined) {
      const clean=original.replace(/[|¦]/g,' ').trim();
      const tokens=clean.split(/\s+/);
      let start=tokens.findIndex((v,j)=>j>0 && /^[+\-]?[0-9OolISB][0-9OolISB.,]*[.,][0-9OolISB]+$/.test(v));
      if(start<0 && tokens.length>=3) {
        // Integer coordinates are supported; a split alphanumeric identifier consumes two tokens.
        start = /^[A-Za-z]+$/.test(tokens[0]) && /^\d+$/.test(tokens[1]) && tokens.length>=4 ? 2 : 1;
        if(!tokens.slice(start).every(v=>/^[+-]?\d+$/.test(v))) start=-1;
      }
      if(start>0) {
        name=tokens.slice(0,start).join('');
        [e='',n='',h='']=tokens.slice(start);
        if(tokens.length-start>3) { skipped.push({line:i+1,text:original}); continue; }
      }
    }
    if(name!==undefined) result.push({name,e:order==='ne'?n:e,n:order==='ne'?e:n,h,raw:original,line:i+1});
    else skipped.push({line:i+1,text:original});
  }
  return {rows:result,skipped};
}

export function flattenLines(data) {
  return (data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
}

export function parseOCR(data, order='en') {
  const lines=flattenLines(data);
  const parsed=parseText(data.text||'',order);
  for(const r of parsed.rows){
    const compact=s=>s.replace(/[\s|¦]/g,'');
    const l=lines.find(l=>compact(l.text||'')===compact(r.raw));
    r.bbox=l?.bbox||null;
    const words=l?.words||[];
    r.confidence=words.length?Math.min(...words.map(w=>w.confidence??0)):(data.confidence??0);
  }
  return parsed;
}

export function detectOrder(text) {
  for(const line of String(text).split('\n')) {
    const e=line.search(/rechtswert|easting|\beast\b/i), n=line.search(/hochwert|northing|\bnorth\b/i);
    if(e>=0&&n>=0) return e<n?'en':'ne';
  }
  return null;
}

export function isTableHeader(cells) {
  const values=cells.map(value=>String(value??'').trim());
  // A point named "Punkt" with numeric coordinates is still a data row.
  if(values.slice(1).some(value=>/\d/.test(value)))return false;
  const label=(values[0]||'').replace(/\s/g,'');
  return Boolean(detectOrder(values.join(' '))) || /^(?:koordinat|absteckpunkt)/i.test(label) || /^(?:punkt(?:nr\.?|nummer)?|name|point(?:no\.?|number)?)$/i.test(label);
}

export function safeFilename(name, ext) {
  return (String(name).trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,100)||'PunktScan')+'.'+ext;
}

export function chooseReading(candidates) {
  const normalized=candidates.map(c=>({...c,text:c.text.trim().replace(/\s+/g,' '),parsed:coordinate(c.text)}));
  const complete=normalized.filter(c=>c.parsed.ok&&!c.parsed.short);
  const pool=complete.length?complete:normalized;
  const best=[...pool].sort((a,b)=>b.confidence-a.confidence)[0];
  return {...best,disputed:new Set(normalized.filter(c=>c.text).map(c=>c.text.replace(',','.'))).size>1};
}

export function checkProject(p) {
  if(!p||p.format!=='PunktScan'||p.version!==1||!Array.isArray(p.rows)||!Array.isArray(p.sources)||p.rows.length>10000||p.sources.length>30) throw new Error('project');
  const sourceIds=new Set(p.sources.map(s=>s.id));
  if(sourceIds.size!==p.sources.length) throw new Error('project');
  if(p.sources.some(s=>typeof s.id!=='string'||typeof s.name!=='string'||typeof s.image!=='string'||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s.image)||!Number.isInteger(s.width)||!Number.isInteger(s.height)||s.width<1||s.height<1||s.width>2400||s.height>2400)) throw new Error('project');
  if(p.rows.some(r=>!r||!['name','e','n','h'].every(k=>typeof r[k]==='string')||(r.sourceId&&!sourceIds.has(r.sourceId)))) throw new Error('project');
  // Imported review flags are deliberately reset: imported data must be checked locally.
  return {...p,name:String(p.name||'PunktScan').slice(0,100),rows:p.rows.map(r=>({...r,verified:false}))};
}
