import { coordinate, validate } from './core.js?v=__BUILD__';
import { fullQuad } from './imaging.js?v=__BUILD__';
import { state, errors, source } from './state.js?v=__BUILD__';
import { $, esc, toast } from './dom.js?v=__BUILD__';
import { save } from './storage.js?v=__BUILD__';

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
  toast('Останню зміну скасовано.');
}
export function render() {
  renderSources();
  renderPhoto();
  renderRows();
  $('undoBtn').disabled = state.busy || !state.history.length;
  $('emptyState').hidden = !!(state.project.sources.length || state.project.rows.length);
  $('imageWorkspace').hidden = !source();
}
export function renderSources() {
  $('sourceCount').textContent = state.project.sources.length;
  $('sourceList').innerHTML = state.project.sources
    .map(
      (s) =>
        `<div class="source-card ${s.id === state.selected ? 'selected' : ''}"><button type="button" class="source-select" data-source="${esc(s.id)}" aria-current="${s.id === state.selected}"><img src="${s.image}" alt=""><span class="source-info"><strong>${esc(s.name)}</strong><small>${s.recognized ? state.project.rows.filter((r) => r.sourceId === s.id).length + ' точок' : 'Готове до розпізнавання'}</small></span></button><button type="button" class="source-remove" data-remove="${esc(s.id)}" aria-label="Видалити фото ${esc(s.name)}">×</button></div>`,
    )
    .join('');
}
export function renderPhoto() {
  const s = source();
  if (!s) return;
  const img = state.view === 'processed' && s.processed ? s.processed : s.image;
  if ($('previewImg').getAttribute('src') !== img) $('previewImg').src = img;
  $('previewImg').alt = s.name;
  $('photoWrap').style.width = state.zoom * 100 + '%';
  $('frameOverlay').hidden = state.view !== 'frame';
  if (state.view === 'frame') {
    const q = s.quad || fullQuad();
    $('frameOverlay').innerHTML =
      `<polygon points="${q.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ')}" fill="#c8ef6915" stroke="#bcf34e" stroke-width="3" vector-effect="non-scaling-stroke"/>${q.map((p, i) => `<ellipse class="frame-handle" data-corner="${i}" cx="${p.x * 1000}" cy="${p.y * 1000}" rx="14" ry="${14 * (s.width / s.height)}" role="slider" tabindex="0" aria-label="Кут ${i + 1}; стрілками можна змістити межу"/>`).join('')}`;
  }
  for (const b of $('viewTabs').children) {
    b.classList.toggle('active', b.dataset.view === state.view);
    b.disabled = b.dataset.view === 'processed' && !s.processed;
  }
  $('photoCaption').textContent =
    state.view === 'frame'
      ? 'Перетягни 4 кути до меж таблиці'
      : state.view === 'processed'
        ? 'Зображення, використане для розпізнавання'
        : s.name;
  $('resetFrameBtn').hidden = state.view !== 'frame';
  $('recognizeBtn').textContent = s.recognized ? 'Розпізнати повторно' : 'Розпізнати фото';
  $('columnOrder').value = s.order || 'auto';
  $('enhanceInput').checked = s.enhance !== false;
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
    ? `${done} із ${values.length} звірено${bad ? ' · ' + bad + ' з помилками' : ''}`
    : 'Тут з’являться розпізнані координати.';
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
        return `<tr data-row="${esc(r.id)}" class="${r.verified ? 'row-reviewed' : ''}"><td><button class="review-btn ${v.issues.length ? 'bad' : r.verified ? 'good' : ''}" data-review="${esc(r.id)}" title="${r.verified ? 'Звірено; відкрити точку' : 'Звірити з оригіналом'}" aria-label="Звірити ${esc(r.name || 'точку')}">${v.issues.length ? '!' : r.verified ? '✓' : '○'}</button></td>${[
          'name',
          'e',
          'n',
          'h',
        ]
          .map((k) => {
            const issue = v.issues.find((x) => x.field === k);
            return `<td><input data-field="${k}" data-id="${esc(r.id)}" aria-label="${{ name: 'Назва', e: 'Rechtswert', n: 'Hochwert', h: 'Висота' }[k]} ${esc(r.name)}" value="${esc(r[k])}" class="${issue ? 'invalid' : ''}" placeholder="${k === 'h' ? '—' : ''}" autocomplete="off" spellcheck="false" ${k !== 'name' ? 'inputmode="decimal"' : ''}>${issue ? `<small class="cell-error">${errors[issue.code]}</small>` : ''}</td>`;
          })
          .join(
            '',
          )}<td><button class="delete-row" data-delete-row="${esc(r.id)}" aria-label="Видалити ${esc(r.name || 'точку')}">×</button></td></tr>`;
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
      input.title = unsure ? 'Невпевнене розпізнавання — звір з оригіналом' : '';
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
  $('tableEmpty').textContent = values.length
    ? 'Немає точок за цим фільтром.'
    : 'Додай фото або встав готову таблицю текстом.';
  for (const b of $('filters').children)
    b.classList.toggle('active', b.dataset.filter === state.filter);
  const isReady = values.length > 0 && done === values.length && !bad;
  $('exportBtn').disabled = !isReady || state.busy;
  $('csvBtn').disabled = !isReady || state.busy;
  $('exportStatus').textContent = isReady
    ? `${values.length} точок готові до експорту`
    : values.length
      ? `Залишилося звірити: ${values.length - done}`
      : 'Файл ще не готовий';
  $('exportHint').textContent = bad
    ? 'Спочатку виправ позначені помилки.'
    : isReady
      ? 'GSI-16 · метри · без зміни системи координат'
      : 'Натисни кружечок біля точки, щоб відкрити звіряння.';
  $('mapBtn').disabled = !values.some((v) => v.e.ok && v.n.ok);
  $('rawTextBtn').hidden = !source()?.raw;
}
export function setBusy(value) {
  state.busy = value;
  $('cancelOcrBtn').hidden = true;
  for (const id of [
    'uploadBtn',
    'startBtn',
    'demoBtn',
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
