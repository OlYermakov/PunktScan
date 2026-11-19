import {
  coordinate,
  validate,
  gsi,
  csv,
  parseText,
  parseOCR,
  detectOrder,
  isTableHeader,
  safeFilename,
  checkProject,
  chooseReading,
} from './core.js?v=__BUILD__';
import {
  findTable,
  fullQuad,
  validQuad,
  rectify,
  gridCells,
  originalRegion,
  thresholdCell,
} from './imaging.js?v=__BUILD__';

const $ = (id) => document.getElementById(id),
  esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
const uid = () =>
  crypto.randomUUID?.() || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2);
const blank = () => ({
  format: 'PunktScan',
  version: 1,
  name: 'Новий об’єкт',
  sources: [],
  rows: [],
});
let ocrController = null;
let project = blank(),
  selected = null,
  view = 'original',
  zoom = 1,
  filter = 'all',
  history = [],
  busy = false,
  worker = null,
  cancelled = false,
  saveTimer,
  toastTimer,
  db = null,
  saveChain = Promise.resolve(),
  reviewId = null,
  dialogKind = '',
  closingReview = false;
const errors = {
  required: 'Потрібне значення',
  number: 'Перевір цифри та роздільник',
  precision: 'Понад 3 знаки: виправ вручну',
  range: 'Поза діапазоном GSI-16',
  nameRequired: 'Потрібна назва',
  nameLength: 'Не більше 16 символів',
  nameChars: 'Латиниця, цифри, _ . -',
  duplicate: 'Назва повторюється',
};
const source = () => project.sources.find((s) => s.id === selected);
const ready = () =>
  project.rows.length > 0 &&
  validate(project.rows).every((v) => !v.issues.length && v.row.verified);
function toast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4500);
}
function notice(text = '') {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}
function snapshot() {
  history.push({
    name: project.name,
    rows: project.rows.map((r) => ({ ...r })),
    sources: project.sources.map((s) => ({ ...s, quad: s.quad?.map((p) => ({ ...p })) })),
  });
  if (history.length > 20) history.shift();
  $('undoBtn').disabled = false;
}
function undo() {
  if (busy || !history.length) return;
  Object.assign(project, history.pop());
  if (!source()) selected = project.sources[0]?.id || null;
  $('projectName').value = project.name;
  render();
  save();
  toast('Останню зміну скасовано.');
}
function save() {
  clearTimeout(saveTimer);
  $('saveState').textContent = 'Збереження…';
  saveTimer = setTimeout(persist, 550);
}
function persist() {
  if (!db) {
    $('saveState').textContent = 'Збережи проєкт файлом';
    return;
  }
  const data = structuredClone(project);
  saveChain = saveChain
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve, reject) => {
          const tx = db.transaction('projects', 'readwrite');
          tx.objectStore('projects').put(data, 'current');
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    )
    .then(() => ($('saveState').textContent = 'Чернетку збережено'))
    .catch(() => {
      $('saveState').textContent = 'Не вдалося зберегти';
      notice(
        'Браузер не зміг зберегти чернетку. Завантаж проєкт файлом, щоб не втратити фото та точки.',
      );
    });
}
async function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('punktscan-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('projects');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function restore() {
  try {
    db = await openDB();
    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction('projects');
      const r = tx.objectStore('projects').get('current');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (stored?.format === 'PunktScan' && stored.version === 1) {
      project = stored;
      selected = project.sources[0]?.id || null;
      $('projectName').value = project.name;
      $('saveState').textContent = 'Чернетку відновлено';
    }
  } catch {
    $('saveState').textContent = 'Збереження файлом';
    notice('Локальне збереження недоступне. Користуйся кнопкою «Зберегти проєкт».');
  }
  render();
}
function render() {
  renderSources();
  renderPhoto();
  renderRows();
  $('undoBtn').disabled = busy || !history.length;
  $('emptyState').hidden = !!(project.sources.length || project.rows.length);
  $('imageWorkspace').hidden = !source();
}
function renderSources() {
  $('sourceCount').textContent = project.sources.length;
  $('sourceList').innerHTML = project.sources
    .map(
      (s) =>
        `<div class="source-card ${s.id === selected ? 'selected' : ''}" data-source="${esc(s.id)}" role="button" tabindex="0" aria-label="${esc(s.name)}"><img src="${s.image}" alt=""><div class="source-info"><strong>${esc(s.name)}</strong><small>${s.recognized ? project.rows.filter((r) => r.sourceId === s.id).length + ' точок' : 'Готове до розпізнавання'}</small></div><button class="source-remove" data-remove="${esc(s.id)}" aria-label="Видалити фото ${esc(s.name)}">×</button></div>`,
    )
    .join('');
}
function renderPhoto() {
  const s = source();
  if (!s) return;
  const img = view === 'processed' && s.processed ? s.processed : s.image;
  if ($('previewImg').getAttribute('src') !== img) $('previewImg').src = img;
  $('previewImg').alt = s.name;
  $('photoWrap').style.width = zoom * 100 + '%';
  $('frameOverlay').hidden = view !== 'frame';
  if (view === 'frame') {
    const q = s.quad || fullQuad();
    $('frameOverlay').innerHTML =
      `<polygon points="${q.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ')}" fill="#c8ef6915" stroke="#bcf34e" stroke-width="3" vector-effect="non-scaling-stroke"/>${q.map((p, i) => `<ellipse class="frame-handle" data-corner="${i}" cx="${p.x * 1000}" cy="${p.y * 1000}" rx="14" ry="${14 * (s.width / s.height)}" role="slider" tabindex="0" aria-label="Кут ${i + 1}; стрілками можна змістити межу"/>`).join('')}`;
  }
  for (const b of $('viewTabs').children) {
    b.classList.toggle('active', b.dataset.view === view);
    b.disabled = b.dataset.view === 'processed' && !s.processed;
  }
  $('photoCaption').textContent =
    view === 'frame'
      ? 'Перетягни 4 кути до меж таблиці'
      : view === 'processed'
        ? 'Зображення, використане для розпізнавання'
        : s.name;
  $('resetFrameBtn').hidden = view !== 'frame';
  $('recognizeBtn').textContent = s.recognized ? 'Розпізнати повторно' : 'Розпізнати фото';
  $('columnOrder').value = s.order || 'auto';
  $('enhanceInput').checked = s.enhance !== false;
  $('recognizeAllBtn').hidden = project.sources.filter((s) => !s.recognized).length < 2;
}
function warnings(v) {
  const out = [];
  if (v.e.ok && v.n.ok) {
    if (v.e.short || v.n.short)
      out.push(
        'Координата має менше трьох десяткових знаків. Перевір, чи не пропущено крапку або цифру.',
      );
    if (Math.abs(Number(v.e.value)) > 100000000 || Math.abs(Number(v.n.value)) > 100000000)
      out.push('Нетипово велика координата. Розпізнавання могло пропустити десяткову крапку.');
    const same = project.rows.filter(
      (r) =>
        r.id !== v.row.id &&
        coordinate(r.e).value === v.e.value &&
        coordinate(r.n).value === v.n.value,
    );
    if (same.length)
      out.push(
        'Інша точка має ті самі планові координати: ' + same.map((r) => r.name).join(', ') + '.',
      );
  }
  if (v.e.ok && v.n.ok && project.rows.length >= 3) {
    for (const k of ['e', 'n']) {
      const others = project.rows
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
        out.push(
          'Координата ' +
            k.toUpperCase() +
            ' за масштабом суттєво відрізняється від інших точок. Перевір кількість цифр.',
        );
        break;
      }
    }
  }
  if ((v.row.confidence !== undefined && v.row.confidence < 70) || v.row.disputed?.some(Boolean))
    out.push(
      'Є невпевнено розпізнані символи або різні результати проходів. Звір назву, усі цифри та десяткові крапки.',
    );
  return [...new Set(out)];
}
function renderRows(paint = true) {
  const values = validate(project.rows),
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
      (filter === 'all' ||
        (filter === 'errors' && v.issues.length) ||
        (filter === 'review' && (!v.row.verified || v.issues.length))) &&
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
    b.disabled = busy;
    tr.querySelector('.delete-row').disabled = busy;
    b.className = 'review-btn ' + (v.issues.length ? 'bad' : v.row.verified ? 'good' : '');
    b.textContent = v.issues.length ? '!' : v.row.verified ? '✓' : '○';
    for (const input of tr.querySelectorAll('[data-field]')) {
      input.disabled = busy;
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
  for (const b of $('filters').children) b.classList.toggle('active', b.dataset.filter === filter);
  const isReady = values.length > 0 && done === values.length && !bad;
  $('exportBtn').disabled = !isReady || busy;
  $('csvBtn').disabled = !isReady || busy;
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
function setBusy(value) {
  busy = value;
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
async function imageFrom(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () =>
      reject(
        new Error(
          'Не вдалося прочитати зображення. Для HEIC збережи копію JPG або зроби скриншот.',
        ),
      );
    im.src = url;
  });
}
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
async function pixelsFor(s) {
  const im = await imageFrom(s.image),
    c = canvas(s.width, s.height);
  c.getContext('2d').drawImage(im, 0, 0);
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
}
function canvasFrom(data) {
  const c = canvas(data.width, data.height);
  c.getContext('2d').putImageData(new ImageData(data.data, data.width, data.height), 0, 0);
  return c;
}
async function addPhotos(files) {
  if (busy) return;
  if (project.sources.length + files.length > 20) {
    toast('В одному проєкті — до 20 фото.');
    return;
  }
  snapshot();
  setBusy(true);
  $('progressText').textContent = 'Відкриття фото…';
  notice();
  const failures = [];
  for (const file of files) {
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error(file.name + ': файл більший за 20 МБ.');
      if (file.type === 'image/svg+xml')
        throw new Error('SVG не є фотографією. Додай JPG, PNG або WebP.');
      const url = URL.createObjectURL(file);
      let im;
      try {
        im = await imageFrom(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (im.width * im.height > 60000000)
        throw new Error(file.name + ': надто велике зображення. Зменш його до 60 мегапікселів.');
      const ratio = Math.min(1, 2400 / Math.max(im.width, im.height)),
        w = Math.round(im.width * ratio),
        h = Math.round(im.height * ratio);
      if (w < 80 || h < 60) throw new Error(file.name + ': зображення надто мале.');
      const c = canvas(w, h),
        ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(im, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h);
      await new Promise((r) => setTimeout(r, 0));
      const quad = findTable(px.data, w, h) || fullQuad();
      const s = {
        id: uid(),
        name: file.name,
        width: w,
        height: h,
        image: c.toDataURL('image/png'),
        quad,
        order: 'auto',
        enhance: true,
        recognized: false,
      };
      project.sources.push(s);
      selected = s.id;
    } catch (e) {
      failures.push(e.message);
    }
  }
  setBusy(false);
  view = 'frame';
  zoom = 1;
  render();
  save();
  if (failures.length) notice(failures.join('\n'));
  $('photoInput').value = '';
}
function progress(text, value) {
  $('progressText').textContent = text;
  $('ocrProgress').value = Math.max(0, Math.min(1, value));
}
async function getWorker(signal) {
  if (worker) return worker;
  if (!window.Tesseract)
    throw new Error('Модуль розпізнавання не завантажився. Онови сторінку з інтернетом.');
  progress('Завантаження модуля…', 0.02);
  const w = await Tesseract.createWorker('eng', 1, {
    workerPath: new URL('./vendor/worker.min.js', location.href).href,
    corePath: new URL('./vendor/core/', location.href).href,
    langPath: new URL('./vendor/lang', location.href).href,
    cacheMethod: 'none',
    logger: (m) => {
      if (!signal.aborted && /loading|initializing/.test(m.status))
        progress('Підготовка локального модуля…', 0.02 + 0.08 * (m.progress || 0));
    },
  });
  if (signal.aborted) {
    await w.terminate();
    throw new Error('cancel');
  }
  worker = w;
  return w;
}
async function recognizeOne(s, signal) {
  if (signal.aborted) throw new Error('cancel');
  if (!validQuad(s.quad)) throw new Error('Кути рамки перетинаються. Виправ межі таблиці.');
  const w = await getWorker(signal);
  progress('Вирівнювання таблиці…', 0.1);
  await new Promise((r) => setTimeout(r, 10));
  const input = await pixelsFor(s),
    plain = rectify(input.data, s.width, s.height, s.quad, false),
    grid = gridCells(plain.data, plain.width, plain.height);
  const prepared = s.enhance ? rectify(input.data, s.width, s.height, s.quad, true) : plain;
  const c = canvasFrom(prepared),
    plainCanvas = canvasFrom(plain);
  const rows = [],
    raw = [],
    skipped = [];
  let order = s.order === 'ne' ? 'ne' : 'en',
    autoOrder = null;
  if (grid) {
    await w.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' });
    for (let i = 0; i < grid.rows.length; i++) {
      const band = grid.rows[i],
        texts = [],
        conf = [],
        disputed = [];
      for (let j = 0; j < band.length; j++) {
        if (signal.aborted) throw new Error('cancel');
        progress(
          `Клітинка ${i * band.length + j + 1} / ${grid.rows.length * band.length}`,
          0.15 + 0.8 * ((i * band.length + j) / (grid.rows.length * band.length)),
        );
        // Header cells are read with letters; data cells are read with a restricted numeric alphabet.
        const header = j > 0 && isTableHeader([texts[0]]);
        await w.setParameters({
          tessedit_char_whitelist:
            j && !header
              ? '0123456789.,-+'
              : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-. ',
        });
        const rect = band[j],
          cell = canvas(rect.width + 24, rect.height + 24),
          ctx = cell.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, cell.width, cell.height);
        ctx.drawImage(
          c,
          rect.left,
          rect.top,
          rect.width,
          rect.height,
          12,
          12,
          rect.width,
          rect.height,
        );
        const { data } = await w.recognize(cell.toDataURL('image/png'), {}, { text: true });
        let reading = {
          text: data.text.trim().replace(/\s+/g, ' '),
          confidence: data.confidence,
          disputed: false,
        };
        if (
          j &&
          !header &&
          s.enhance &&
          texts[0] &&
          !/koordinat/i.test(texts[0]) &&
          (reading.confidence < 80 ||
            !coordinate(reading.text).ok ||
            coordinate(reading.text).short)
        ) {
          const candidates = [reading],
            rawCell = canvas(rect.width, rect.height),
            rc = rawCell.getContext('2d', { willReadFrequently: true });
          rc.drawImage(
            plainCanvas,
            rect.left,
            rect.top,
            rect.width,
            rect.height,
            0,
            0,
            rect.width,
            rect.height,
          );
          const pixels = rc.getImageData(0, 0, rect.width, rect.height);
          for (const threshold of [140, 160]) {
            if (signal.aborted) throw new Error('cancel');
            const cleaned = canvasFrom(
                thresholdCell(pixels.data, rect.width, rect.height, threshold),
              ),
              padded = canvas(cleaned.width + 24, cleaned.height + 24),
              ctx = padded.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, padded.width, padded.height);
            ctx.drawImage(cleaned, 12, 12);
            const { data: alt } = await w.recognize(
              padded.toDataURL('image/png'),
              {},
              { text: true },
            );
            candidates.push({ text: alt.text, confidence: alt.confidence });
          }
          if (
            !candidates.some(
              (v) => v.confidence >= 80 && coordinate(v.text).ok && !coordinate(v.text).short,
            )
          ) {
            const wide = canvas(Math.round(rect.width * 1.5) + 24, rect.height + 24),
              ctx = wide.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, wide.width, wide.height);
            ctx.drawImage(
              c,
              rect.left,
              rect.top,
              rect.width,
              rect.height,
              12,
              12,
              wide.width - 24,
              rect.height,
            );
            if (signal.aborted) throw new Error('cancel');
            const { data: alt } = await w.recognize(
              wide.toDataURL('image/png'),
              {},
              { text: true },
            );
            candidates.push({ text: alt.text, confidence: alt.confidence });
          }
          reading = chooseReading(candidates);
        }
        texts.push(reading.text);
        conf.push(reading.confidence);
        disputed.push(reading.disputed);
      }
      const line = texts.join(' ; ');
      raw.push(line);
      if (isTableHeader(texts)) {
        autoOrder = detectOrder(texts.join(' ')) || autoOrder;
        continue;
      }
      if (!texts.some(Boolean)) {
        skipped.push(line);
        continue;
      }
      // Never drop a partially recognized data row: missing cells are shown as errors.
      rows.push({
        name: texts[0].replace(/\s/g, ''),
        e: texts[1] || '',
        n: texts[2] || '',
        h: texts[3] || '',
        confidence: Math.min(...conf),
        cellConfidence: conf,
        disputed,
        bbox: { x0: 0, y0: band[0].top, x1: prepared.width, y1: band[0].top + band[0].height },
        raw: line,
      });
    }
    if (s.order === 'auto' && autoOrder) order = autoOrder;
    if (order === 'ne')
      for (const row of rows) {
        [row.e, row.n] = [row.n, row.e];
        [row.cellConfidence[1], row.cellConfidence[2]] = [
          row.cellConfidence[2],
          row.cellConfidence[1],
        ];
        [row.disputed[1], row.disputed[2]] = [row.disputed[2], row.disputed[1]];
      }
  } else {
    progress('Читання таблиці…', 0.25);
    await w.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: '',
    });
    const { data } = await w.recognize(c.toDataURL('image/png'), {}, { text: true, blocks: true });
    if (s.order === 'auto') autoOrder = detectOrder(data.text);
    order = s.order === 'auto' ? autoOrder || 'en' : s.order;
    const parsed = parseOCR(data, order);
    rows.push(...parsed.rows);
    raw.push(data.text);
    skipped.push(...parsed.skipped.map((s) => s.text));
  }
  if (signal.aborted) throw new Error('cancel');
  // Commit a source atomically only when recognition finished, so cancellation never erases previous points.
  snapshot();
  project.rows = project.rows.filter((r) => r.sourceId !== s.id);
  for (const row of rows) project.rows.push({ ...row, id: uid(), sourceId: s.id, verified: false });
  Object.assign(s, {
    recognized: true,
    processed: c.toDataURL('image/png'),
    pw: prepared.width,
    ph: prepared.height,
    resultQuad: s.quad.map((p) => ({ ...p })),
    raw: raw.join('\n'),
    skipped: skipped.join('\n'),
    usedOrder: order,
    autoOrder,
  });
  selected = s.id;
  view = 'processed';
  zoom = 1;
  const message = rows.length
    ? `Розпізнано ${rows.length} точок. Звір їх із фото, включно з назвами та десятковими крапками.`
    : 'Точки не знайдено. Виправ рамку, вимкни очищення або встав таблицю текстом.';
  notice(
    message +
      (!autoOrder && s.order === 'auto'
        ? ' Порядок E, N використано за замовчуванням: перевір заголовки.'
        : '') +
      (skipped.length ? ' Є пропущені рядки — відкрий «Результат розпізнавання».' : ''),
  );
  render();
  save();
}
async function recognize(all = false) {
  if (busy || !source()) return;
  const list = all ? project.sources.filter((s) => !s.recognized) : [source()];
  if (
    list.some((s) => project.rows.some((r) => r.sourceId === s.id)) &&
    !confirm(
      'Повторне розпізнавання замінить точки з цього фото, включно з ручними виправленнями. Продовжити?',
    )
  )
    return;
  setBusy(true);
  $('cancelOcrBtn').hidden = false;
  cancelled = false;
  notice();
  const controller = new AbortController();
  ocrController = controller;
  const interrupted = new Promise((_, reject) =>
    controller.signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true }),
  );
  try {
    for (const s of list) {
      if (controller.signal.aborted) break;
      selected = s.id;
      renderSources();
      renderPhoto();
      await Promise.race([recognizeOne(s, controller.signal), interrupted]);
    }
    if (!controller.signal.aborted) progress('Готово', 1);
  } catch (e) {
    if (cancelled || e.message === 'cancel')
      toast('Розпізнавання зупинено. Завершені фото збережено.');
    else notice('Не вдалося розпізнати фото. ' + e.message);
  } finally {
    setBusy(false);
    render();
    save();
  }
}
async function cancelOcr() {
  cancelled = true;
  ocrController?.abort();
  if (worker) {
    const w = worker;
    worker = null;
    await w.terminate();
  }
}

function showDialog(title, body, footer = '', kind = '') {
  dialogKind = kind;
  $('dialogContent').innerHTML =
    `<div class="dialog-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Закрити">×</button></div><div class="dialog-body">${body}</div>${footer ? `<div class="dialog-footer">${footer}</div>` : ''}`;
  if (!$('dialog').open) $('dialog').showModal();
}
function closeDialog() {
  if (dialogKind === 'review') flushReview();
  $('dialog').close();
  reviewId = null;
  dialogKind = '';
  renderRows();
}
function showReview(id) {
  const index = project.rows.findIndex((r) => r.id === id);
  if (index < 0) return;
  const r = project.rows[index],
    s = project.sources.find((s) => s.id === r.sourceId);
  reviewId = id;
  if (s) {
    selected = s.id;
    renderSources();
    renderPhoto();
  }
  const v = validate(project.rows).find((v) => v.row.id === id),
    warn = warnings(v);
  const body = `<span class="eyebrow">${s ? 'ФРАГМЕНТ ОРИГІНАЛЬНОГО ФОТО' : 'РУЧНЕ ВВЕДЕННЯ / ТЕКСТ'}</span>${s ? '<div class="review-crop-scroll"><canvas id="reviewCrop" class="review-image"></canvas></div><p class="crop-hint small">Прокручуй фрагмент фото вбік, щоб прочитати всі колонки.</p>' : '<p class="small">Звір значення зі своїм джерелом. Для цієї точки немає прикріпленого фото.</p>'}<div class="review-fields">${['name', 'e', 'n', 'h'].map((k) => `<label>${{ name: 'Назва точки', e: 'Rechtswert · E', n: 'Hochwert · N', h: 'Höhe · H (необов’язково)' }[k]}<input id="review-${k}" data-review-field="${k}" value="${esc(r[k])}" autocomplete="off" spellcheck="false" ${k !== 'name' ? 'inputmode="decimal"' : ''}></label>`).join('')}</div><div id="reviewErrors"></div>${warn.length ? `<div class="review-message">${warn.map(esc).join('<br>')}</div>` : ''}<p class="small">Порожня висота не експортується. Пробіли в назві прибираються; решта символів не змінюється.</p>${s ? `<details style="margin-top:15px"><summary class="small">Повне оригінальне фото · ${esc(s.name)}</summary><div class="review-original"><img src="${s.image}" alt="Оригінальна таблиця"></div></details>` : ''}`;
  showDialog(
    'Звіряння точки',
    body,
    `<div class="review-navigation"><button class="icon-btn" id="prevReview" aria-label="Попередня точка" ${index === 0 ? 'disabled' : ''}>‹</button><span>${index + 1} / ${project.rows.length}</span><button class="icon-btn" id="nextReview" aria-label="Наступна точка" ${index === project.rows.length - 1 ? 'disabled' : ''}>›</button></div><button class="button subtle" data-close>Закрити</button><button class="button primary" id="verifyNextBtn">Звірено${index < project.rows.length - 1 ? ' · наступна' : ''}</button>`,
    'review',
  );
  if (s) drawReview(s, r);
  updateReviewErrors();
}
async function drawReview(s, r) {
  const image = await imageFrom(s.image);
  if (reviewId !== r.id || !$('reviewCrop')) return;
  let region = { x: 0, y: 0, w: s.width, h: s.height };
  if (r.bbox && s.resultQuad)
    region = originalRegion(s.resultQuad, r.bbox, s.pw, s.ph, s.width, s.height);
  const c = $('reviewCrop');
  c.width = Math.min(2000, Math.round(region.w));
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
function flushReview() {
  if (closingReview || !reviewId) return;
  const r = project.rows.find((r) => r.id === reviewId);
  if (!r || !$('review-name')) return;
  const changes = ['name', 'e', 'n', 'h'].filter((k) => r[k] !== $('review-' + k).value);
  if (changes.length) {
    snapshot();
    for (const k of changes) r[k] = $('review-' + k).value;
    r.verified = false;
    save();
  }
}
function updateReviewErrors() {
  if (!reviewId) return;
  const r = project.rows.find((r) => r.id === reviewId);
  if (!r) return;
  const draft = {
    ...r,
    ...Object.fromEntries(['name', 'e', 'n', 'h'].map((k) => [k, $('review-' + k).value])),
  };
  const v = validate(project.rows.map((p) => (p.id === r.id ? draft : p))).find(
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
        .map((i) => `${{ name: 'Назва', e: 'E', n: 'N', h: 'H' }[i.field]}: ${errors[i.code]}`)
        .map(esc)
        .join('<br>') +
      '</p>'
    : '';
  $('verifyNextBtn').disabled = v.issues.length > 0;
}
function verifyNext() {
  flushReview();
  const i = project.rows.findIndex((r) => r.id === reviewId),
    r = project.rows[i],
    v = validate(project.rows).find((v) => v.row.id === reviewId);
  if (!r || v.issues.length) return;
  snapshot();
  Object.assign(r, { name: v.name.name, e: v.e.value, n: v.n.value, h: v.h.value, verified: true });
  save();
  if (i < project.rows.length - 1) {
    showReview(project.rows[i + 1].id);
  } else {
    closingReview = true;
    closeDialog();
    closingReview = false;
    toast('Звіряння завершено.');
  }
  renderRows();
}
function pasteDialog() {
  showDialog(
    'Вставити таблицю',
    `<p class="small">Один рядок — одна точка: <b>назва; E; N; H</b>. Висота необов’язкова. Можна вставити колонки з Excel (табуляція) або рядки з пробілами. Для чисел із розділеними тисячами використовуй крапку з комою або табуляцію.</p><label class="field-label" for="pasteOrder">Порядок координат</label><select id="pasteOrder"><option value="en">Назва; Rechtswert (E); Hochwert (N); Höhe (H)</option><option value="ne">Назва; Hochwert (N); Rechtswert (E); Höhe (H)</option></select><textarea id="pasteText" class="paste-area" placeholder="Af201;3500030.210;5600557.311\nAf202;3500029.444;5600557.784" spellcheck="false"></textarea><p id="pasteInfo" class="small"></p>`,
    `<button class="button subtle" data-close>Скасувати</button><button class="button primary" id="pasteApply">Додати точки</button>`,
    'paste',
  );
}
function applyPaste() {
  const parsed = parseText($('pasteText').value, $('pasteOrder').value);
  if (!parsed.rows.length) {
    $('pasteInfo').textContent =
      'Не знайдено рядків із назвою та координатами. Перевір роздільники.';
    return;
  }
  snapshot();
  for (const r of parsed.rows)
    project.rows.push({ ...r, id: uid(), sourceId: null, verified: false });
  closeDialog();
  render();
  save();
  if (parsed.skipped.length)
    notice(
      'Не вдалося прочитати рядки: ' +
        parsed.skipped.map((s) => `${s.line}: ${s.text}`).join(' · ') +
        '. Внеси їх вручну або виправ текст.',
    );
  toast('Додано точок: ' + parsed.rows.length);
}
function download(content, type, name) {
  const blob = content instanceof Blob ? content : new Blob([content], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function exportDialog(format) {
  if (!ready()) return;
  const vals = validate(project.rows),
    withH = vals.filter((v) => !v.h.empty).length;
  const text = format === 'GSI' ? gsi(project.rows) : csv(project.rows);
  showDialog(
    'Експорт ' + format,
    `<div class="export-summary"><div><strong>${project.rows.length}</strong><span>звірених точок</span></div><div><strong>${withH}</strong><span>із висотою</span></div><div><strong>${project.rows.length - withH}</strong><span>без висоти</span></div></div><label class="field-label" for="exportName">Назва файлу (без розширення)</label><input id="exportName" class="file-name" value="${esc(project.name === 'Новий об’єкт' ? 'Absteckpunkte' : project.name)}" maxlength="100"><p class="small">${format === 'GSI' ? 'Leica GSI-16 · ASCII · CRLF · метри з кроком 0,001 м. Слова 11 (точка), 81 (E), 82 (N), 83 (H лише за наявності).' : 'CSV · UTF-8 BOM · крапка з комою між колонками · десяткова кома. Для відкриття в Excel.'}</p><div class="export-preview">${esc(text.split('\r\n').slice(0, 3).join('\n'))}${project.rows.length > 3 ? '\n…' : ''}</div><p class="small">Координати не перетворюються. Для GSI назви доповнюються нулями зліва до 16 символів — це структура формату.</p>`,
    `<button class="button subtle" data-close>Скасувати</button><button class="button primary" id="confirmExport" data-format="${format}">Зберегти .${format}</button>`,
    'export',
  );
}
function saveProject() {
  download(
    JSON.stringify({ ...project, savedAt: new Date().toISOString() }, null, 2),
    'application/json',
    safeFilename(project.name === 'Новий об’єкт' ? 'PunktScan-Projekt' : project.name, 'json'),
  );
  toast('Проєкт підготовлено до збереження разом із фото.');
}
async function openProject(file) {
  if (!file) return;
  try {
    if (file.size > 120 * 1024 * 1024) throw new Error('Файл завеликий (понад 120 МБ).');
    const imported = checkProject(JSON.parse(await file.text()));
    if (
      (project.rows.length || project.sources.length) &&
      !confirm('Замінити поточну чернетку? Спочатку збережи її файлом, якщо вона потрібна.')
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
    project = imported;
    selected = project.sources[0]?.id || null;
    view = 'original';
    zoom = 1;
    $('projectName').value = project.name;
    render();
    save();
    notice(
      'Проєкт відкрито. Статус звіряння імпортованих точок скинуто — перевір дані перед експортом.',
    );
  } catch (e) {
    notice(
      'Не вдалося відкрити проєкт PunktScan. ' +
        (e.message === 'project' ? 'Формат або вміст файлу не підтримується.' : e.message),
    );
  } finally {
    $('projectInput').value = '';
  }
}
function mapDialog() {
  const pts = validate(project.rows)
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
  const html = `<p class="small">Локальна схема без карти. E праворуч, N угору. Однаковий масштаб по обох осях; висоти не показано.</p><div class="map-wrap" style="margin-top:15px"><svg viewBox="0 0 800 480" role="img" aria-label="Розміщення точок"><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#dce7d3"/></pattern></defs><rect width="800" height="480" fill="url(#grid)"/><text x="400" y="25" text-anchor="middle" fill="#638050" font-size="14">N</text><text x="770" y="240" fill="#638050" font-size="14">E</text>${pts.map((p) => `<g><circle cx="${400 + (p.x - cx) * f}" cy="${240 - (p.y - cy) * f}" r="5" fill="${p.ok ? '#426e36' : '#c39336'}" stroke="#fff" stroke-width="2"><title>${esc(p.name)}: E ${p.x.toFixed(3)}, N ${p.y.toFixed(3)}</title></circle><text x="${409 + (p.x - cx) * f}" y="${236 - (p.y - cy) * f}" fill="#3b5e2e" font-size="11">${esc(p.name)}</text></g>`).join('')}</svg></div><p class="batch-note">Охоплення: ΔE ${(maxX - minX).toFixed(3)} м · ΔN ${(maxY - minY).toFixed(3)} м. Незвично віддалена точка може означати помилку розпізнавання.</p>`;
  showDialog(
    'Схема точок',
    html,
    `<button class="button subtle" data-close>Закрити</button>`,
    'map',
  );
}
function helpDialog() {
  showDialog(
    'Як працювати з PunktScan',
    `<div class="help-content"><h3>Фото → звіряння → GSI</h3><p>Додай фото або скриншоти таблиць. Застосунок шукає межі таблиці; перевір рамку на вкладці «Межі». Усі потрібні рядки мають залишитися всередині. За потреби перетягни кути, поверни фото або вибери «Усе фото». Далі натисни «Розпізнати фото».</p><h3>Розпізнавання</h3><p>Для таблиць із чіткою сіткою клітинки читаються окремо. Без сітки застосунок читає рядки. Порядок E/N визначається за заголовками Rechtswert/Hochwert або Easting/Northing; якщо заголовки не прочитано, використовується E, N і показується повідомлення. Можна явно задати порядок перед розпізнаванням.</p><p>Очищення допомагає на фото екрана, але може погіршити дрібний або блідий текст. У такому разі вимкни його та розпізнай повторно. Розпізнавання замінює тільки точки вибраного фото. Помилково прочитані цифри не виправляються за здогадкою.</p><h3>Звір кожну точку</h3><p>Натисни кружечок у колонці «Звірка». Побачиш фрагмент <b>оригінального</b> фото, а не очищену копію. Звір назву, знак, усі цифри та десятковий роздільник. Натисни «Звірено · наступна». Зміна будь-якого поля скидає статус звіряння. На фото може бути більше рядків, ніж знайшов розпізнавач: завжди порівнюй кількість точок та переглядай результат розпізнавання.</p><h3>Правила координат</h3><ul><li>Усі значення — у метрах. Підтримуються від’ємні значення, десяткова крапка та кома.</li><li><code>3.415.030,210</code>, <code>3,415,030.210</code> та <code>3 415 030,210</code> можна ввести вручну або вставити з Excel.</li><li>Понад 3 десяткові знаки блокують експорт: виріши вручну, як округлити значення. Автоматичного округлення немає.</li><li>Порожня висота не записується у GSI; явне <code>0</code> записується як нульова висота.</li><li>Назви: до 16 символів, латинські літери, цифри, крапка, дефіс і підкреслення. Пробіли прибираються. Збіги після прибирання початкових нулів і без урахування регістру позначаються як дублікати.</li><li>Координати не перетворюються між системами: DB_REF, GK чи UTM мають лишитися такими, як у джерелі.</li></ul><h3>Формат і CAPLAN</h3><p>Експорт: стандартний Leica GSI-16, ASCII, завершення рядків CRLF. Ідентифікатори 11/81/82/83. Завантаж файл як координатні дані Leica GSI у своїй програмі. Сумісність конкретної версії CAPLAN і налаштувань імпорту перевір на першому файлі: E, N, висота та назви мають збігтися. Експорт не містить вимірювань станції чи польових кодів.</p><h3>Збереження та приватність</h3><p>Фото й точки обробляються у браузері та автоматично зберігаються в локальній чернетці. Вони не синхронізуються між пристроями. «Зберегти проєкт» завантажує JSON із фото, точками та результатами OCR. Імпорт такого файлу скидає статуси звіряння. Очищення даних браузера видалить чернетку — зберігай важливі проєкти файлом.</p><h3>iPhone та офлайн</h3><p>Відкрий застосунок у Safari. Через меню «Поширити» додай його на головний екран. Потім натисни «Офлайн» та завантаж необхідні файли. Перший запуск і завантаження модуля потребують інтернету; готовність офлайн підтверджується лише після завершення завантаження. iOS може видаляти кеш за нестачі місця.</p><h3>Підтримувані матеріали</h3><p>JPG, PNG і WebP; інші формати — якщо їх читає твій браузер. Якщо HEIC не відкривається, використай JPG або скриншот. PDF безпосередньо не підтримується: додай скриншот потрібної таблиці. До 20 фото по 20 МБ; довга сторона понад 2400 пікселів зменшується. Призначено для друкованих таблиць, не для рукописних записів чи розпізнавання всього креслення.</p><hr><p>Рушій розпізнавання: Tesseract.js 6.0.1 (Apache-2.0). <a href="./licenses.txt" target="_blank" rel="noopener">Ліцензії компонентів</a>.</p></div>`,
    `<button class="button primary" data-close>Зрозуміло</button>`,
    'help',
  );
}
async function prepareOffline() {
  showDialog(
    'Робота без інтернету',
    `<p class="small">Збережи застосунок і модуль розпізнавання на цьому пристрої. Це приблизно 29 МБ. Фото не завантажуються на сервер. Після успішного збереження відкрий застосунок один раз без мережі, щоб перевірити доступність на своєму пристрої.</p><p id="offlineStatus" class="offline-progress">Перевірка…</p>`,
    `<button class="button subtle" data-close>Закрити</button><button class="button primary" id="cacheOfflineBtn">Завантажити для офлайн</button>`,
    'offline',
  );
  try {
    if (!('serviceWorker' in navigator) || !window.isSecureContext)
      throw new Error('Потрібен захищений HTTPS-доступ і підтримка Service Worker.');
    await navigator.serviceWorker.ready;
    const cache = await caches.open('punktscan-offline-v1');
    const marker = await cache.match(new URL('./offline-ready', location.href));
    const complete = marker && (await marker.text()) === '4';
    if ($('offlineStatus'))
      $('offlineStatus').textContent = complete
        ? 'Файли для офлайн вже збережено.'
        : 'Файли ще не збережено для повної роботи офлайн.';
  } catch (e) {
    if ($('offlineStatus')) $('offlineStatus').textContent = e.message;
  }
}
async function cacheOffline() {
  const button = $('cacheOfflineBtn');
  button.disabled = true;
  try {
    const files = await (await fetch('./offline-assets.json')).json();
    await caches.delete('punktscan-offline-loading');
    const target = await caches.open('punktscan-offline-v1');
    await target.delete(new URL('./offline-ready', location.href));
    for (let i = 0; i < files.length; i++) {
      if ($('offlineStatus'))
        $('offlineStatus').textContent = `Завантаження ${i + 1} / ${files.length}…`;
      const response = await fetch(files[i], { cache: 'reload' });
      if (!response.ok) throw new Error('Не вдалося завантажити ' + files[i]);
      await target.put(new Request(new URL(files[i], location.href)), response);
    }
    await target.put(new URL('./offline-ready', location.href), new Response('4'));
    if ($('offlineStatus'))
      $('offlineStatus').textContent =
        'Готово. Застосунок і модуль розпізнавання збережено на пристрої.';
    navigator.storage?.persist?.().catch(() => {});
    $('offlineBtn').textContent = 'Офлайн ✓';
  } catch (e) {
    if ($('offlineStatus'))
      $('offlineStatus').textContent =
        'Завантаження не завершено. Перевір інтернет і вільне місце. ' + e.message;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

$('uploadBtn').onclick = $('startBtn').onclick = () => $('photoInput').click();
$('photoInput').onchange = (e) => addPhotos([...e.target.files]);
for (const event of ['dragenter', 'dragover'])
  $('uploadBtn').addEventListener(event, (e) => {
    e.preventDefault();
    $('uploadBtn').classList.add('dragging');
  });
for (const event of ['dragleave', 'drop'])
  $('uploadBtn').addEventListener(event, (e) => {
    e.preventDefault();
    $('uploadBtn').classList.remove('dragging');
    if (event === 'drop') addPhotos([...e.dataTransfer.files]);
  });
$('sourceList').addEventListener('click', (e) => {
  if (busy) return;
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    const id = remove.dataset.remove;
    if (
      project.rows.some((r) => r.sourceId === id) &&
      !confirm('Видалити фото та всі пов’язані точки?')
    )
      return;
    snapshot();
    project.sources = project.sources.filter((s) => s.id !== id);
    project.rows = project.rows.filter((r) => r.sourceId !== id);
    if (selected === id) selected = project.sources[0]?.id || null;
    render();
    save();
    return;
  }
  const el = e.target.closest('[data-source]');
  if (el) {
    selected = el.dataset.source;
    view = 'original';
    zoom = 1;
    render();
  }
});
$('sourceList').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.hasAttribute('data-source')) {
    e.preventDefault();
    e.target.click();
  }
});
$('viewTabs').onclick = (e) => {
  if (e.target.dataset.view) {
    view = e.target.dataset.view;
    zoom = 1;
    renderPhoto();
  }
};
$('zoomInBtn').onclick = () => {
  zoom = Math.min(4, zoom + 0.5);
  renderPhoto();
};
$('zoomOutBtn').onclick = () => {
  zoom = Math.max(0.5, zoom - 0.5);
  renderPhoto();
};
let dragCorner = null;
$('frameOverlay').addEventListener('pointerdown', (e) => {
  if (busy) return;
  const c = e.target.closest('[data-corner]');
  if (!c) return;
  snapshot();
  dragCorner = Number(c.dataset.corner);
  $('frameOverlay').setPointerCapture(e.pointerId);
  e.preventDefault();
});
$('frameOverlay').addEventListener('pointermove', (e) => {
  if (dragCorner === null || !source()) return;
  const b = $('frameOverlay').getBoundingClientRect();
  source().quad[dragCorner] = {
    x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
    y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)),
  };
  renderPhoto();
});
for (const ev of ['pointerup', 'pointercancel'])
  $('frameOverlay').addEventListener(ev, () => {
    if (dragCorner !== null) {
      dragCorner = null;
      save();
    }
  });
$('frameOverlay').addEventListener('keydown', (e) => {
  const c = e.target.closest('[data-corner]');
  if (!c || busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  snapshot();
  const p = source().quad[Number(c.dataset.corner)],
    step = e.shiftKey ? 0.02 : 0.002;
  if (e.key === 'ArrowLeft') p.x -= step;
  if (e.key === 'ArrowRight') p.x += step;
  if (e.key === 'ArrowUp') p.y -= step;
  if (e.key === 'ArrowDown') p.y += step;
  p.x = Math.min(1, Math.max(0, p.x));
  p.y = Math.min(1, Math.max(0, p.y));
  const index = c.dataset.corner;
  renderPhoto();
  $('frameOverlay').querySelector(`[data-corner="${index}"]`).focus();
  save();
});
$('resetFrameBtn').onclick = () => {
  snapshot();
  source().quad = fullQuad();
  renderPhoto();
  save();
};
$('autoFrameBtn').onclick = async () => {
  if (busy || !source()) return;
  const s = source();
  setBusy(true);
  try {
    const px = await pixelsFor(s);
    const q = findTable(px.data, s.width, s.height);
    if (q) {
      snapshot();
      s.quad = q;
      view = 'frame';
      renderPhoto();
      save();
    } else toast('Чітку сітку не знайдено. Вистав межі вручну.');
  } finally {
    setBusy(false);
  }
};
$('rotateBtn').onclick = async () => {
  const s = source();
  if (!s || busy) return;
  if (
    project.rows.some((r) => r.sourceId === s.id) &&
    !confirm(
      'Поворот фото видалить його розпізнані точки. Після повороту розпізнай фото знову. Продовжити?',
    )
  )
    return;
  snapshot();
  const im = await imageFrom(s.image),
    c = canvas(s.height, s.width),
    ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(im, 0, 0);
  Object.assign(s, {
    width: c.width,
    height: c.height,
    image: c.toDataURL('image/png'),
    quad: fullQuad(),
    processed: null,
    recognized: false,
    raw: '',
  });
  project.rows = project.rows.filter((r) => r.sourceId !== s.id);
  view = 'frame';
  render();
  save();
};
$('columnOrder').onchange = (e) => {
  if (source()) {
    source().order = e.target.value;
    save();
  }
};
$('enhanceInput').onchange = (e) => {
  if (source()) {
    source().enhance = e.target.checked;
    save();
  }
};
$('recognizeBtn').onclick = () => recognize();
$('recognizeAllBtn').onclick = () => recognize(true);
$('cancelOcrBtn').onclick = cancelOcr;
$('demoBtn').onclick = async () => {
  try {
    $('demoBtn').disabled = true;
    const files = [];
    for (const [i, name] of ['Demo_Af201-LS202.jpg', 'Demo_Af205-208.jpg'].entries()) {
      const r = await fetch('./demo-' + (i + 1) + '.jpg');
      if (!r.ok) throw new Error('Зразок недоступний.');
      files.push(new File([await r.blob()], name, { type: 'image/jpeg' }));
    }
    await addPhotos(files);
    project.name = 'Навчальний приклад';
    $('projectName').value = project.name;
    save();
    notice(
      'Додано дві навчальні таблиці з вигаданими координатами. Натисни «Розпізнати всі нові фото» — дані будуть прочитані з фото, а не підставлені.',
    );
  } catch (e) {
    notice(e.message);
  } finally {
    $('demoBtn').disabled = false;
  }
};
let activeEdit = null;
$('pointsBody').addEventListener('focusin', () => (activeEdit = null));
$('pointsBody').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset.field) return;
  const r = project.rows.find((r) => r.id === el.dataset.id);
  if (!r) return;
  const key = r.id + ':' + el.dataset.field;
  if (activeEdit !== key) {
    snapshot();
    activeEdit = key;
  }
  r[el.dataset.field] = el.value;
  r.verified = false;
  renderRows(false);
  save();
});
$('pointsBody').addEventListener('click', (e) => {
  const r = e.target.closest('[data-review]');
  if (r) {
    showReview(r.dataset.review);
    return;
  }
  const d = e.target.closest('[data-delete-row]');
  if (d) {
    snapshot();
    project.rows = project.rows.filter((r) => r.id !== d.dataset.deleteRow);
    renderRows();
    save();
  }
});
$('addPointBtn').onclick = () => {
  snapshot();
  const r = { id: uid(), name: '', e: '', n: '', h: '', sourceId: null, verified: false };
  project.rows.push(r);
  render();
  save();
  showReview(r.id);
};
$('filters').onclick = (e) => {
  const b = e.target.closest('[data-filter]');
  if (b) {
    filter = b.dataset.filter;
    renderRows();
  }
};
$('searchInput').oninput = () => renderRows();
let nameEditing = false;
$('projectName').onfocus = () => (nameEditing = false);
$('projectName').oninput = (e) => {
  if (!nameEditing) {
    snapshot();
    nameEditing = true;
  }
  project.name = e.target.value;
  save();
};
$('projectName').onchange = (e) => {
  snapshot();
  project.name = e.target.value.trim() || 'Новий об’єкт';
  e.target.value = project.name;
  save();
};
$('undoBtn').onclick = undo;
$('pasteBtn').onclick = pasteDialog;
$('saveProjectBtn').onclick = saveProject;
$('openProjectBtn').onclick = () => $('projectInput').click();
$('projectInput').onchange = (e) => openProject(e.target.files[0]);
$('newProjectBtn').onclick = () => {
  if (
    (project.rows.length || project.sources.length) &&
    !confirm(
      'Почати новий проєкт? Поточна чернетка буде замінена. За потреби спочатку збережи її файлом.',
    )
  )
    return;
  snapshot();
  project = blank();
  selected = null;
  filter = 'all';
  $('projectName').value = project.name;
  notice();
  render();
  save();
};
$('exportBtn').onclick = () => exportDialog('GSI');
$('csvBtn').onclick = () => exportDialog('CSV');
$('mapBtn').onclick = mapDialog;
$('helpBtn').onclick = helpDialog;
$('offlineBtn').onclick = prepareOffline;
$('rawTextBtn').onclick = () => {
  const s = source();
  if (!s) return;
  showDialog(
    'Результат розпізнавання',
    `<p class="small">Порівняй кількість рядків із фото. Крапка з комою відділяє клітинки. Це необроблений текст розпізнавання.</p><pre class="raw-text">${esc(s.raw)}</pre>${s.skipped ? '<h3>Пропущені рядки</h3><pre class="raw-text">' + esc(s.skipped) + '</pre>' : ''}`,
    `<button class="button subtle" data-close>Закрити</button>`,
    'raw',
  );
};
$('dialog').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) {
    closeDialog();
    return;
  }
  if (e.target.id === 'verifyNextBtn') verifyNext();
  if (e.target.id === 'prevReview' || e.target.id === 'nextReview') {
    flushReview();
    const i = project.rows.findIndex((r) => r.id === reviewId),
      next = i + (e.target.id === 'nextReview' ? 1 : -1);
    if (project.rows[next]) showReview(project.rows[next].id);
  }
  if (e.target.id === 'pasteApply') applyPaste();
  if (e.target.id === 'cacheOfflineBtn') cacheOffline();
  if (e.target.id === 'confirmExport') {
    const format = e.target.dataset.format;
    if (!ready()) return;
    download(
      format === 'GSI' ? gsi(project.rows) : csv(project.rows),
      format === 'GSI' ? 'text/plain;charset=us-ascii' : 'text/csv;charset=utf-8',
      safeFilename($('exportName').value, format),
    );
    closeDialog();
    toast('Файл .' + format + ' підготовлено до збереження.');
  }
});
$('dialog').addEventListener('input', (e) => {
  if (e.target.dataset.reviewField) updateReviewErrors();
});
$('dialog').addEventListener('cancel', (e) => {
  e.preventDefault();
  closeDialog();
});
window.addEventListener('pagehide', () => {
  clearTimeout(saveTimer);
  persist();
});
document.addEventListener('keydown', (e) => {
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === 'z' &&
    !/INPUT|TEXTAREA/.test(e.target.tagName) &&
    !$('dialog').open
  ) {
    e.preventDefault();
    undo();
  }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
restore();
