import {
  coordinate,
  validate,
  gsi,
  csv,
  parseText,
  safeFilename,
  checkProject,
} from './core.js?v=__BUILD__';
import { fullQuad, validQuad, originalRegion, cellRegion } from './imaging.js?v=__BUILD__';
import { uid, state, errors, ready, projectName } from './state.js?v=__BUILD__';
import { $, toast, notice, imageFrom, download, esc } from './dom.js?v=__BUILD__';
import { save } from './storage.js?v=__BUILD__';
import { t, lang } from './i18n.js?v=__BUILD__';
import { snapshot, render, renderSources, renderPhoto, renderRows } from './render.js?v=__BUILD__';

export function warnings(v) {
  const out = [];
  if (v.e.ok && v.n.ok) {
    if (v.e.short || v.n.short) out.push(t('warn.short'));
    if (Math.abs(Number(v.e.value)) > 100000000 || Math.abs(Number(v.n.value)) > 100000000)
      out.push(t('warn.large'));
    const same = state.project.rows.filter(
      (r) =>
        r.id !== v.row.id &&
        coordinate(r.e).value === v.e.value &&
        coordinate(r.n).value === v.n.value,
    );
    if (same.length) out.push(t('warn.same', { names: same.map((r) => r.name).join(', ') }));
  }
  if (v.e.ok && v.n.ok && state.project.rows.length >= 3) {
    for (const k of ['e', 'n']) {
      const others = state.project.rows
        .filter((r) => r.id !== v.row.id)
        .map((r) => coordinate(r[k]))
        .filter((c) => c.ok)
        .map((c) => Math.abs(Number(c.value)))
        .sort((a, b) => a - b);
      const median = others[Math.floor(others.length / 2)];
      if (
        median > 1000 &&
        (Math.abs(Number(v[k].value)) > median * 3 || Math.abs(Number(v[k].value)) < median / 3)
      ) {
        out.push(t('warn.scale', { axis: k.toUpperCase() }));
        break;
      }
    }
  }
  if ((v.row.confidence !== undefined && v.row.confidence < 70) || v.row.disputed?.some(Boolean))
    out.push(t('warn.unsure'));
  return [...new Set(out)];
}
let reviewId = null,
  dialogKind = '',
  closingReview = false;
export function showDialog(title, body, footer = '', kind = '') {
  dialogKind = kind;
  $('dialogContent').innerHTML =
    `<div class="dialog-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="${t('common.close')}">×</button></div><div class="dialog-body">${body}</div>${footer ? `<div class="dialog-footer">${footer}</div>` : ''}`;
  if (!$('dialog').open) $('dialog').showModal();
}
export function closeDialog() {
  if (dialogKind === 'review') flushReview();
  $('dialog').close();
  reviewId = null;
  dialogKind = '';
  renderRows();
}
export function showReview(id) {
  const index = state.project.rows.findIndex((r) => r.id === id);
  if (index < 0) return;
  const r = state.project.rows[index],
    s = state.project.sources.find((s) => s.id === r.sourceId);
  reviewId = id;
  if (s) {
    state.selected = s.id;
    renderSources();
    renderPhoto();
  }
  const values = validate(state.project.rows),
    v = values.find((v) => v.row.id === id),
    warn = warnings(v),
    morePending = values.some((x) => x.row.id !== id && (!x.row.verified || x.issues.length));
  // Grid recognition stores one box per cell: show each photo cell right above its field.
  const hasCells = Boolean(s?.resultQuad && r.cells?.length);
  const labels = {
    name: t('review.name'),
    e: t('review.e'),
    n: t('review.n'),
    h: t('review.h'),
  };
  const field = (k, i) =>
    `<div class="review-field review-field-${k}"><label for="review-${k}">${labels[k]}</label>${hasCells && r.cells[i] ? `<canvas class="cell-crop" data-crop-field="${k}" aria-hidden="true"></canvas>` : ''}<div class="review-input"><input id="review-${k}" data-review-field="${k}" value="${esc(r[k])}" autocomplete="off" spellcheck="false" ${k !== 'name' ? 'inputmode="decimal"' : ''}>${k !== 'name' ? `<button type="button" class="sign-btn" data-sign="${k}" aria-label="${esc(t('review.sign', { label: labels[k] }))}">±</button>` : ''}</div></div>`;
  const photo = s
    ? `<div class="row-crop ${hasCells ? 'has-cells' : ''}"><div class="review-crop-scroll"><canvas id="reviewCrop" class="review-image"></canvas></div>${hasCells ? '' : `<p class="crop-hint small">${t('review.scrollHint')}</p>`}</div>`
    : `<p class="small">${t('review.noPhoto')}</p>`;
  const body = `<span class="eyebrow">${t(s ? 'review.eyebrowPhoto' : 'review.eyebrowManual')}</span>${photo}<div class="review-fields">${['name', 'e', 'n', 'h'].map(field).join('')}</div><div id="reviewErrors"></div>${warn.length ? `<div class="review-message">${warn.map(esc).join('<br>')}</div>` : ''}<p class="small">${t('review.note')}</p>${s ? `<details style="margin-top:15px"><summary class="small">${esc(t('review.fullPhoto', { name: s.name }))}</summary><div class="review-original"><img src="${s.image}" alt="${t('review.originalAlt')}"></div></details>` : ''}`;
  showDialog(
    t('review.title'),
    body,
    `<div class="review-navigation"><button class="icon-btn" id="prevReview" aria-label="${t('review.prev')}" ${index === 0 ? 'disabled' : ''}>‹</button><span>${index + 1} / ${state.project.rows.length}</span><button class="icon-btn" id="nextReview" aria-label="${t('review.next')}" ${index === state.project.rows.length - 1 ? 'disabled' : ''}>›</button></div><button class="button subtle" data-close>${t('common.close')}</button><button class="button primary" id="verifyNextBtn">${t(morePending ? 'review.verifiedNext' : 'review.verified')}</button>`,
    'review',
  );
  if (s) drawReview(s, r);
  updateReviewErrors();
}
export async function drawReview(s, r) {
  const image = await imageFrom(s.image);
  if (reviewId !== r.id || !$('reviewCrop')) return;
  let region = { x: 0, y: 0, w: s.width, h: s.height };
  if (r.bbox && s.resultQuad)
    region = originalRegion(s.resultQuad, r.bbox, s.pw, s.ph, s.width, s.height);
  drawRegion($('reviewCrop'), image, region, 2000);
  for (const c of document.querySelectorAll('[data-crop-field]')) {
    const cell = r.cells[['name', 'e', 'n', 'h'].indexOf(c.dataset.cropField)];
    drawRegion(c, image, cellRegion(s.resultQuad, cell, s.pw, s.ph, s.width, s.height), 900);
  }
}
function drawRegion(c, image, region, maxWidth) {
  c.width = Math.max(1, Math.min(maxWidth, Math.round(region.w)));
  c.height = Math.max(20, Math.round((region.h * c.width) / region.w));
  c.getContext('2d').drawImage(
    image,
    region.x,
    region.y,
    region.w,
    region.h,
    0,
    0,
    c.width,
    c.height,
  );
}
export function flushReview() {
  if (closingReview || !reviewId) return;
  const r = state.project.rows.find((r) => r.id === reviewId);
  if (!r || !$('review-name')) return;
  const changes = ['name', 'e', 'n', 'h'].filter((k) => r[k] !== $('review-' + k).value);
  if (changes.length) {
    snapshot();
    for (const k of changes) r[k] = $('review-' + k).value;
    r.verified = false;
    save();
  }
}
export function updateReviewErrors() {
  if (!reviewId) return;
  const r = state.project.rows.find((r) => r.id === reviewId);
  if (!r) return;
  const draft = {
    ...r,
    ...Object.fromEntries(['name', 'e', 'n', 'h'].map((k) => [k, $('review-' + k).value])),
  };
  const v = validate(state.project.rows.map((p) => (p.id === r.id ? draft : p))).find(
    (v) => v.row.id === r.id,
  );
  for (const k of ['name', 'e', 'n', 'h'])
    $('review-' + k).classList.toggle(
      'invalid',
      v.issues.some((i) => i.field === k),
    );
  $('reviewErrors').innerHTML = v.issues.length
    ? '<p class="review-message">' +
      v.issues
        .map(
          (i) =>
            `${i.field === 'name' ? t('field.name') : i.field.toUpperCase()}: ${errors[i.code]}`,
        )
        .map(esc)
        .join('<br>') +
      '</p>'
    : '';
  $('verifyNextBtn').disabled = v.issues.length > 0;
}
export function verifyNext() {
  flushReview();
  const i = state.project.rows.findIndex((r) => r.id === reviewId),
    r = state.project.rows[i],
    v = validate(state.project.rows).find((v) => v.row.id === reviewId);
  if (!r || v.issues.length) return;
  snapshot();
  Object.assign(r, { name: v.name.name, e: v.e.value, n: v.n.value, h: v.h.value, verified: true });
  save();
  // Continue with the next point that still needs checking, wrapping around to earlier ones.
  const rows = state.project.rows,
    issues = new Set(
      validate(rows)
        .filter((x) => x.issues.length)
        .map((x) => x.row.id),
    ),
    pending = (x) => !x.verified || issues.has(x.id),
    next = rows.slice(i + 1).find(pending) ?? rows.slice(0, i).find(pending);
  if (next) {
    showReview(next.id);
  } else {
    closingReview = true;
    closeDialog();
    closingReview = false;
    toast(t('review.finished'));
  }
  renderRows();
}
export function pasteDialog() {
  showDialog(
    t('paste.title'),
    `<p class="small">${t('paste.helpHtml')}</p><label class="field-label" for="pasteOrder">${t('paste.orderLabel')}</label><select id="pasteOrder"><option value="en">${t('paste.orderEN')}</option><option value="ne">${t('paste.orderNE')}</option></select><textarea id="pasteText" class="paste-area" placeholder="Af201;3500030.210;5600557.311\nAf202;3500029.444;5600557.784" spellcheck="false"></textarea><p id="pasteInfo" class="small"></p>`,
    `<button class="button subtle" data-close>${t('common.cancel')}</button><button class="button primary" id="pasteApply">${t('paste.apply')}</button>`,
    'paste',
  );
}
export function applyPaste() {
  const parsed = parseText($('pasteText').value, $('pasteOrder').value);
  if (!parsed.rows.length) {
    $('pasteInfo').textContent = t('paste.none');
    return;
  }
  snapshot();
  for (const r of parsed.rows)
    state.project.rows.push({ ...r, id: uid(), sourceId: null, verified: false });
  closeDialog();
  render();
  save();
  if (parsed.skipped.length)
    notice(
      t('paste.skipped', {
        lines: parsed.skipped.map((s) => `${s.line}: ${s.text}`).join(' · '),
      }),
    );
  toast(t('paste.added', { n: parsed.rows.length }));
}
export function exportDialog(format) {
  if (!ready()) return;
  const vals = validate(state.project.rows),
    withH = vals.filter((v) => !v.h.empty).length;
  // Any value with 4 decimals switches the GSI file to the 0.1 mm unit (see gsi() in core.js).
  const fine = vals.some((v) => [v.e, v.n, v.h].some((c) => c.fine));
  const text = format === 'GSI' ? gsi(state.project.rows) : csv(state.project.rows);
  showDialog(
    t('export.title', { format }),
    `<div class="export-summary"><div><strong>${state.project.rows.length}</strong><span>${t('export.verified')}</span></div><div><strong>${withH}</strong><span>${t('export.withH')}</span></div><div><strong>${state.project.rows.length - withH}</strong><span>${t('export.withoutH')}</span></div></div><label class="field-label" for="exportName">${t('export.fileName')}</label><input id="exportName" class="file-name" value="${esc(state.project.name || 'Absteckpunkte')}" maxlength="100"><p class="small">${format === 'GSI' ? t('export.gsiInfo', { step: (fine ? 0.0001 : 0.001).toLocaleString(lang, { minimumFractionDigits: fine ? 4 : 3 }) }) + (fine ? ' ' + t('export.unitNote') : '') : t('export.csvInfo')}</p><div class="export-preview">${esc(text.split('\r\n').slice(0, 3).join('\n'))}${state.project.rows.length > 3 ? '\n…' : ''}</div><p class="small">${t('export.note')}</p>`,
    `<button class="button subtle" data-close>${t('common.cancel')}</button><button class="button primary" id="confirmExport" data-format="${format}">${t('export.save', { format })}</button>`,
    'export',
  );
}
export function saveProject() {
  download(
    JSON.stringify({ ...state.project, savedAt: new Date().toISOString() }, null, 2),
    'application/json',
    safeFilename(state.project.name || 'PunktScan-Projekt', 'json'),
  );
  toast(t('project.savedToast'));
}
export async function openProject(file) {
  if (!file) return;
  try {
    if (file.size > 120 * 1024 * 1024) throw new Error(t('project.tooBig'));
    const imported = checkProject(JSON.parse(await file.text()));
    if (
      (state.project.rows.length || state.project.sources.length) &&
      !confirm(t('project.replaceConfirm'))
    )
      return;
    snapshot();
    const ids = new Map();
    for (const s of imported.sources) {
      const id = uid();
      ids.set(s.id, id);
      s.id = id;
      if (!validQuad(s.quad)) s.quad = fullQuad();
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s.processed || ''))
        delete s.processed;
    }
    imported.rows = imported.rows.map((r) => ({
      ...r,
      id: uid(),
      sourceId: r.sourceId ? ids.get(r.sourceId) : null,
      verified: false,
    }));
    state.project = { ...imported, name: projectName(imported.name) };
    state.selected = state.project.sources[0]?.id || null;
    state.view = 'original';
    state.zoom = 1;
    $('projectName').value = state.project.name;
    render();
    save();
    notice(t('project.opened'));
  } catch (e) {
    notice(
      t('project.openFailed') + (e.message === 'project' ? t('project.badFormat') : e.message),
    );
  } finally {
    $('projectInput').value = '';
  }
}
export function mapDialog() {
  const pts = validate(state.project.rows)
    .filter((v) => v.e.ok && v.n.ok)
    .map((v) => ({
      x: Number(v.e.value),
      y: Number(v.n.value),
      name: v.name.name,
      ok: v.row.verified,
    }));
  if (!pts.length) return;
  const minX = Math.min(...pts.map((p) => p.x)),
    maxX = Math.max(...pts.map((p) => p.x)),
    minY = Math.min(...pts.map((p) => p.y)),
    maxY = Math.max(...pts.map((p) => p.y));
  const span = Math.max(maxX - minX, maxY - minY, 1),
    cx = (minX + maxX) / 2,
    cy = (minY + maxY) / 2,
    f = 360 / span;
  const html = `<p class="small">${t('map.note')}</p><div class="map-wrap" style="margin-top:15px"><svg viewBox="0 0 800 480" role="img" aria-label="${t('map.label')}"><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#dce7d3"/></pattern></defs><rect width="800" height="480" fill="url(#grid)"/><text x="400" y="25" text-anchor="middle" fill="#638050" font-size="14">N</text><text x="770" y="240" fill="#638050" font-size="14">E</text>${pts.map((p) => `<g><circle cx="${400 + (p.x - cx) * f}" cy="${240 - (p.y - cy) * f}" r="5" fill="${p.ok ? '#426e36' : '#c39336'}" stroke="#fff" stroke-width="2"><title>${esc(p.name)}: E ${p.x.toFixed(3)}, N ${p.y.toFixed(3)}</title></circle><text x="${409 + (p.x - cx) * f}" y="${236 - (p.y - cy) * f}" fill="#3b5e2e" font-size="11">${esc(p.name)}</text></g>`).join('')}</svg></div><p class="batch-note">${t('map.extent', { de: (maxX - minX).toFixed(3), dn: (maxY - minY).toFixed(3) })}</p>`;
  showDialog(
    t('table.map'),
    html,
    `<button class="button subtle" data-close>${t('common.close')}</button>`,
    'map',
  );
}
export function helpDialog() {
  showDialog(
    t('help.title'),
    `<div class="help-content">${t('help.html', { version: '__TESSERACT_VERSION__' })}</div>`,
    `<button class="button primary" data-close>${t('common.ok')}</button>`,
    'help',
  );
}
export async function prepareOffline() {
  showDialog(
    t('offline.title'),
    `<p class="small">${t('offline.text', { mb: '__OFFLINE_MB__' })}</p><p id="offlineStatus" class="offline-progress">${t('offline.checking')}</p>`,
    `<button class="button subtle" data-close>${t('common.close')}</button><button class="button primary" id="cacheOfflineBtn">${t('offline.download')}</button>`,
    'offline',
  );
  try {
    if (!('serviceWorker' in navigator) || !window.isSecureContext)
      throw new Error(t('offline.needHttps'));
    await navigator.serviceWorker.ready;
    const cache = await caches.open('punktscan-offline-v1');
    const marker = await cache.match(new URL('./offline-ready', location.href));
    const complete = marker && (await marker.text()) === '4';
    if ($('offlineStatus'))
      $('offlineStatus').textContent = complete ? t('offline.ready') : t('offline.notReady');
  } catch (e) {
    if ($('offlineStatus')) $('offlineStatus').textContent = e.message;
  }
}
export async function cacheOffline() {
  const button = $('cacheOfflineBtn');
  button.disabled = true;
  try {
    const files = await (await fetch('./offline-assets.json')).json();
    await caches.delete('punktscan-offline-loading');
    const target = await caches.open('punktscan-offline-v1');
    await target.delete(new URL('./offline-ready', location.href));
    for (let i = 0; i < files.length; i++) {
      if ($('offlineStatus'))
        $('offlineStatus').textContent = t('offline.progress', { i: i + 1, total: files.length });
      const response = await fetch(files[i], { cache: 'reload' });
      if (!response.ok) throw new Error(t('offline.fetchFailed', { file: files[i] }));
      await target.put(new Request(new URL(files[i], location.href)), response);
    }
    await target.put(new URL('./offline-ready', location.href), new Response('4'));
    if ($('offlineStatus')) $('offlineStatus').textContent = t('offline.done');
    navigator.storage?.persist?.().catch(() => {});
    $('offlineBtn').textContent = t('offline.button');
  } catch (e) {
    if ($('offlineStatus')) $('offlineStatus').textContent = t('offline.failed') + e.message;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}
export function stepReview(delta) {
  flushReview();
  const next = state.project.rows[state.project.rows.findIndex((r) => r.id === reviewId) + delta];
  if (next) showReview(next.id);
}
// The iPhone decimal keypad has no minus key: the ± button flips the sign instead.
export function toggleSign(k) {
  const input = $('review-' + k);
  if (!input) return;
  const value = input.value.trim();
  input.value = /^[-\u2212]/.test(value) ? value.slice(1) : '-' + value;
  updateReviewErrors();
}
