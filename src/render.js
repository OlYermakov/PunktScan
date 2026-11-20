import { coordinate, validate } from './core.js?v=__BUILD__';
import { fullQuad, cellPolygon } from './imaging.js?v=__BUILD__';
import { state, errors, source } from './state.js?v=__BUILD__';
import { $, esc, toast } from './dom.js?v=__BUILD__';
import { save, listProjects } from './storage.js?v=__BUILD__';
import { renderFlow } from './flow.js?v=__BUILD__';
import { activeCorner } from './frame.js?v=__BUILD__';
import { t, tp, lang } from './i18n.js?v=__BUILD__';

export function snapshot() {
  state.history.push({
    name: state.project.name,
    rows: state.project.rows.map((r) => ({ ...r })),
    sources: state.project.sources.map((s) => ({ ...s, quad: s.quad?.map((p) => ({ ...p })) })),
  });
  if (state.history.length > 20) state.history.shift();
  $('undoBtn').disabled = false;
}
export function undo() {
  if (state.busy || !state.history.length) return;
  Object.assign(state.project, state.history.pop());
  if (!source()) state.selected = state.project.sources[0]?.id || null;
  $('projectName').value = state.project.name;
  render();
  save();
  toast(t('undo.done'));
}
export function render() {
  renderSources();
  renderPhoto();
  renderRows();
  $('undoBtn').disabled = state.busy || !state.history.length;
  $('emptyState').hidden = !!(state.project.sources.length || state.project.rows.length);
  $('imageWorkspace').hidden = !source();
  renderRecent();
}

// Saved projects of this browser: thumbnail, name, date and how far the review got.
export function projectItems(items = listProjects()) {
  const date = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' });
  return items
    .map((p) => {
      const name = p.name || t('project.untitled');
      return `<li class="project-item"><button type="button" class="project-open" data-project-open="${esc(p.id)}"><span class="project-thumb">${p.thumb ? `<img src="${p.thumb}" alt="">` : '▧'}</span><span class="project-text"><strong>${esc(name)}</strong><small>${esc(t('projects.meta', { date: p.updated ? date.format(p.updated) : '', points: tp('n.points', p.points), verified: p.verified }))}</small></span></button><button type="button" class="project-delete" data-project-delete="${esc(p.id)}" aria-label="${esc(t('projects.delete', { name }))}">×</button></li>`;
    })
    .join('');
}
export function renderRecent() {
  const items = listProjects();
  $('recentProjects').hidden = !items.length;
  $('recentList').innerHTML = projectItems(items);
}
export function renderSources() {
  $('sourceCount').textContent = state.project.sources.length;
  $('sourceList').innerHTML = state.project.sources
    .map(
      (s) =>
        `<div class="source-card ${s.id === state.selected ? 'selected' : ''}"><button type="button" class="source-select" data-source="${esc(s.id)}" aria-current="${s.id === state.selected}"><img src="${s.image}" alt=""><span class="source-info"><strong>${esc(s.name)}</strong><small>${s.recognized ? tp('n.points', state.project.rows.filter((r) => r.sourceId === s.id).length) : t('photo.ready')}</small></span></button><button type="button" class="source-remove" data-remove="${esc(s.id)}" aria-label="${esc(t('photo.remove', { name: s.name }))}">×</button></div>`,
    )
    .join('');
}
export function renderPhoto() {
  const s = source();
  if (!s) return;
  if (state.view === 'result' && !s.recognized) state.view = 'original';
  const img = state.view === 'processed' && s.processed ? s.processed : s.image;
  if ($('previewImg').getAttribute('src') !== img) $('previewImg').src = img;
  $('previewImg').alt = s.name;
  $('photoWrap').style.width = state.zoom * 100 + '%';
  // SVG elements have no `hidden` property: the attribute is set directly.
  $('frameOverlay').toggleAttribute('hidden', state.view !== 'frame');
  if (state.view === 'frame') {
    const q = s.quad || fullQuad();
    // Handles keep a finger-friendly size on screen whatever the photo's aspect ratio or zoom.
    const box = $('frameOverlay').getBoundingClientRect(),
      radius = matchMedia('(pointer: coarse)').matches ? 12 : 8,
      handle = {
        rx: (radius * 1000) / (box.width || 300),
        ry: (radius * 1000) / (box.height || 300),
      };
    $('frameOverlay').innerHTML =
      `<polygon points="${q.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ')}" fill="#c8ef6915" stroke="#bcf34e" stroke-width="3" vector-effect="non-scaling-stroke"/>${q.map((p, i) => `<ellipse data-corner="${i}" cx="${p.x * 1000}" cy="${p.y * 1000}" class="frame-handle${i === activeCorner() ? ' active' : ''}" rx="${handle.rx}" ry="${handle.ry}" role="slider" tabindex="0" aria-label="${t('photo.corner', { n: i + 1 })}"/>`).join('')}`;
  }
  for (const b of $('viewTabs').children) {
    b.classList.toggle('active', b.dataset.view === state.view);
    b.disabled =
      (b.dataset.view === 'processed' && !s.processed) ||
      (b.dataset.view === 'result' && !s.recognized);
  }
  renderOverlay();
  $('photoCaption').textContent =
    state.view === 'frame'
      ? t('photo.captionFrame')
      : state.view === 'processed'
        ? t('photo.captionProcessed')
        : state.view === 'result'
          ? t('photo.captionResult')
          : s.name;
  $('resetFrameBtn').hidden = state.view !== 'frame';
  $('recognizeBtn').textContent = t(s.recognized ? 'recog.rerun' : 'recog.run');
  $('columnOrder').value = s.order || 'auto';
  $('enhanceInput').checked = s.enhance !== false;
  // Advanced settings stay folded unless one of them was changed.
  if (s.order && s.order !== 'auto') $('advancedSettings').open = true;
  if (s.enhance === false) $('advancedSettings').open = true;
  $('recognizeAllBtn').hidden = state.project.sources.filter((s) => !s.recognized).length < 2;
}
export function renderRows(paint = true) {
  const values = validate(state.project.rows),
    bad = values.filter((v) => v.issues.length).length,
    done = values.filter((v) => v.row.verified && !v.issues.length).length;
  $('pointCount').textContent = values.length;
  $('reviewCount').textContent = values.length - done;
  $('errorCount').textContent = bad;
  $('pointSummary').textContent = values.length
    ? t('points.summary', { done, total: values.length }) +
      (bad ? t('points.summaryErrors', { bad }) : '')
    : t('points.summaryEmpty');
  const query = $('searchInput').value.trim().toLocaleLowerCase();
  const shown = values.filter(
    (v) =>
      (state.filter === 'all' ||
        (state.filter === 'errors' && v.issues.length) ||
        (state.filter === 'review' && (!v.row.verified || v.issues.length))) &&
      v.row.name.toLocaleLowerCase().includes(query),
  );
  if (paint)
    $('pointsBody').innerHTML = shown
      .map((v) => {
        const r = v.row;
        return `<tr data-row="${esc(r.id)}" class="${r.verified ? 'row-reviewed' : ''}"><td class="cell-status"><button class="review-btn ${v.issues.length ? 'bad' : r.verified ? 'good' : ''}" data-review="${esc(r.id)}" title="${t(r.verified ? 'row.reviewTitleDone' : 'row.reviewTitle')}" aria-label="${esc(t('row.reviewLabel', { name: r.name || t('row.pointFallback') }))}">${v.issues.length ? '!' : r.verified ? '✓' : '○'}</button></td>${[
          'name',
          'e',
          'n',
          'h',
        ]
          .map((k) => {
            const issue = v.issues.find((x) => x.field === k);
            return `<td class="cell-${k}" data-label="${{ name: '', e: 'E · Rechtswert', n: 'N · Hochwert', h: 'H · Höhe' }[k]}"><input data-field="${k}" data-id="${esc(r.id)}" aria-label="${esc(t('field.' + k) + ' ' + r.name)}" value="${esc(r[k])}" class="${issue ? 'invalid' : ''}" placeholder="${k === 'h' ? '—' : ''}" autocomplete="off" spellcheck="false" ${k !== 'name' ? 'inputmode="decimal"' : ''}>${issue ? `<small class="cell-error">${errors[issue.code]}</small>` : ''}</td>`;
          })
          .join(
            '',
          )}<td class="cell-delete"><button class="delete-row" data-delete-row="${esc(r.id)}" aria-label="${esc(t('row.delete', { name: r.name || t('row.pointFallback') }))}">×</button></td></tr>`;
      })
      .join('');
  for (const tr of $('pointsBody').querySelectorAll('tr[data-row]')) {
    const v = values.find((v) => v.row.id === tr.dataset.row);
    if (!v) continue;
    tr.classList.toggle('row-reviewed', v.row.verified);
    const b = tr.querySelector('.review-btn');
    b.disabled = state.busy;
    tr.querySelector('.delete-row').disabled = state.busy;
    b.className = 'review-btn ' + (v.issues.length ? 'bad' : v.row.verified ? 'good' : '');
    b.textContent = v.issues.length ? '!' : v.row.verified ? '✓' : '○';
    for (const input of tr.querySelectorAll('[data-field]')) {
      input.disabled = state.busy;
      const k = input.dataset.field,
        i = ['name', 'e', 'n', 'h'].indexOf(k),
        issue = v.issues.find((x) => x.field === k);
      const unsure =
        !v.row.verified &&
        ((v.row.cellConfidence?.[i] ?? 100) < 70 ||
          v.row.disputed?.[i] ||
          (k !== 'name' && k !== 'h' && coordinate(v.row[k]).short));
      input.classList.toggle('invalid', !!issue);
      input.classList.toggle('uncertain', !!unsure);
      input.title = unsure ? t('row.uncertain') : '';
      let message = input.parentElement.querySelector('.cell-error');
      if (issue) {
        if (!message) {
          message = document.createElement('small');
          message.className = 'cell-error';
          input.after(message);
        }
        message.textContent = errors[issue.code];
      } else message?.remove();
    }
  }
  $('tableEmpty').hidden = shown.length > 0;
  $('tableEmpty').textContent = values.length ? t('table.emptyFilter') : t('table.emptyNone');
  for (const b of $('filters').children)
    b.classList.toggle('active', b.dataset.filter === state.filter);
  const isReady = values.length > 0 && done === values.length && !bad;
  $('exportBtn').disabled = !isReady || state.busy;
  $('csvBtn').disabled = !isReady || state.busy;
  $('exportStatus').textContent = isReady
    ? t('export.ready', { points: tp('n.points', values.length) })
    : values.length
      ? t('export.remaining', { n: values.length - done })
      : t('export.notReady');
  $('exportHint').textContent = bad
    ? t('export.hintErrors')
    : isReady
      ? t('export.hintReady')
      : t('export.hintReview');
  $('mapBtn').disabled = !values.some((v) => v.e.ok && v.n.ok);
  $('rawTextBtn').hidden = !source()?.raw;
  renderOverlay(values);
  renderFileSummary(values);
  renderFlow();
}
export function setBusy(value) {
  state.busy = value;
  $('cancelOcrBtn').hidden = true;
  for (const id of [
    'uploadBtn',
    'photoInput',
    'pasteBtn',
    'openProjectBtn',
    'newProjectBtn',
    'undoBtn',
    'addPointBtn',
    'recognizeBtn',
    'recognizeAllBtn',
    'autoFrameBtn',
    'resetFrameBtn',
    'rotateBtn',
    'columnOrder',
    'enhanceInput',
  ])
    $(id).disabled = value;
  $('progressArea').hidden = !value;
  $('sourceList').style.pointerEvents = value ? 'none' : '';
  $('frameOverlay').style.pointerEvents = value ? 'none' : '';
  renderRows();
}

// Recognised cells drawn over the original photo: green = sure or checked, yellow = look again,
// red = error. A row the recogniser missed stands out because nothing is drawn over it.
export function cellStatus(v, i) {
  const field = ['name', 'e', 'n', 'h'][i],
    r = v.row;
  if (v.issues.some((x) => x.field === field)) return 'error';
  if (r.verified) return 'verified';
  const doubtful =
    r.uncertainChars?.[i]?.length || r.disputed?.[i] || (r.cellConfidence?.[i] ?? 100) < 70;
  return doubtful ? 'check' : 'ok';
}
export function renderOverlay(values = validate(state.project.rows)) {
  const s = source(),
    svg = $('resultOverlay');
  const off = !s || state.view !== 'result' || !s.resultQuad;
  svg.toggleAttribute('hidden', off);
  if (off) return;
  const rank = { error: 3, check: 2, ok: 1, verified: 0 },
    shapes = [];
  for (const v of values) {
    const r = v.row;
    if (r.sourceId !== s.id) continue;
    const cells = (r.cells ?? [])
      .map((box, i) => [box, i])
      .filter(
        ([box, i]) => box && r[['name', 'e', 'n', 'h'][i]] !== undefined && box.x1 - box.x0 > 2,
      );
    // Rows read line by line have no cell boxes: the whole row is drawn with its worst status.
    const parts = cells.length
      ? cells.map(([box, i]) => [box, cellStatus(v, i)])
      : r.bbox
        ? [[r.bbox, [0, 1, 2, 3].map((i) => cellStatus(v, i)).sort((a, b) => rank[b] - rank[a])[0]]]
        : [];
    for (const [box, status] of parts) {
      const pts = cellPolygon(s.resultQuad, box, s.pw, s.ph)
        .map((p) => `${(p.x * 1000).toFixed(1)},${(p.y * 1000).toFixed(1)}`)
        .join(' ');
      shapes.push(
        `<polygon class="cell-${status}" data-row="${esc(r.id)}" points="${pts}"><title>${esc(r.name || t('row.pointFallback'))}</title></polygon>`,
      );
    }
  }
  svg.innerHTML = shapes.join('');
}

// Phones, file step: a short summary of the file the bottom bar will send or save.
function renderFileSummary(values) {
  const box = $('fileSummary');
  const ready = values.length && values.every((v) => v.row.verified && !v.issues.length);
  box.hidden = !ready;
  if (!ready) return;
  const withH = values.filter((v) => !v.h.empty).length,
    fine = values.some((v) => [v.e, v.n, v.h].some((c) => c.fine));
  box.innerHTML = `<span class="eyebrow">${t('step.file')}</span><h2>${esc(state.project.name || t('project.untitled'))}</h2><p class="file-count">${tp('n.points', values.length)}</p><p class="small">${t('file.withHeight', { n: withH })} · ${t(fine ? 'file.unitTenth' : 'file.unitMm')}</p><p class="small">${t('file.hint')}</p><button class="text-btn" data-open-map>${t('table.map')}</button>`;
}
