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
import { uid, state, errors, ready } from './state.js?v=__BUILD__';
import { $, toast, notice, imageFrom, download, esc } from './dom.js?v=__BUILD__';
import { save } from './storage.js?v=__BUILD__';
import { snapshot, render, renderSources, renderPhoto, renderRows } from './render.js?v=__BUILD__';

export function warnings(v) {
  const out = [];
  if (v.e.ok && v.n.ok) {
    if (v.e.short || v.n.short)
      out.push(
        'Координата має менше трьох десяткових знаків. Перевір, чи не пропущено крапку або цифру.',
      );
    if (Math.abs(Number(v.e.value)) > 100000000 || Math.abs(Number(v.n.value)) > 100000000)
      out.push('Нетипово велика координата. Розпізнавання могло пропустити десяткову крапку.');
    const same = state.project.rows.filter(
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
let reviewId = null,
  dialogKind = '',
  closingReview = false;
export function showDialog(title, body, footer = '', kind = '') {
  dialogKind = kind;
  $('dialogContent').innerHTML =
    `<div class="dialog-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Закрити">×</button></div><div class="dialog-body">${body}</div>${footer ? `<div class="dialog-footer">${footer}</div>` : ''}`;
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
    name: 'Назва точки',
    e: 'Rechtswert · E',
    n: 'Hochwert · N',
    h: 'Höhe · H (необов’язково)',
  };
  const field = (k, i) =>
    `<div class="review-field review-field-${k}"><label for="review-${k}">${labels[k]}</label>${hasCells && r.cells[i] ? `<canvas class="cell-crop" data-crop-field="${k}" aria-hidden="true"></canvas>` : ''}<div class="review-input"><input id="review-${k}" data-review-field="${k}" value="${esc(r[k])}" autocomplete="off" spellcheck="false" ${k !== 'name' ? 'inputmode="decimal"' : ''}>${k !== 'name' ? `<button type="button" class="sign-btn" data-sign="${k}" aria-label="Змінити знак: ${labels[k]}">±</button>` : ''}</div></div>`;
  const photo = s
    ? `<div class="row-crop ${hasCells ? 'has-cells' : ''}"><div class="review-crop-scroll"><canvas id="reviewCrop" class="review-image"></canvas></div>${hasCells ? '' : '<p class="crop-hint small">Прокручуй фрагмент фото вбік, щоб прочитати всі колонки.</p>'}</div>`
    : '<p class="small">Звір значення зі своїм джерелом. Для цієї точки немає прикріпленого фото.</p>';
  const body = `<span class="eyebrow">${s ? 'ФРАГМЕНТ ОРИГІНАЛЬНОГО ФОТО' : 'РУЧНЕ ВВЕДЕННЯ / ТЕКСТ'}</span>${photo}<div class="review-fields">${['name', 'e', 'n', 'h'].map(field).join('')}</div><div id="reviewErrors"></div>${warn.length ? `<div class="review-message">${warn.map(esc).join('<br>')}</div>` : ''}<p class="small">Порожня висота не експортується. Пробіли в назві прибираються; решта символів не змінюється.</p>${s ? `<details style="margin-top:15px"><summary class="small">Повне оригінальне фото · ${esc(s.name)}</summary><div class="review-original"><img src="${s.image}" alt="Оригінальна таблиця"></div></details>` : ''}`;
  showDialog(
    'Звіряння точки',
    body,
    `<div class="review-navigation"><button class="icon-btn" id="prevReview" aria-label="Попередня точка" ${index === 0 ? 'disabled' : ''}>‹</button><span>${index + 1} / ${state.project.rows.length}</span><button class="icon-btn" id="nextReview" aria-label="Наступна точка" ${index === state.project.rows.length - 1 ? 'disabled' : ''}>›</button></div><button class="button subtle" data-close>Закрити</button><button class="button primary" id="verifyNextBtn">Звірено${morePending ? ' · наступна' : ''}</button>`,
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
        .map((i) => `${{ name: 'Назва', e: 'E', n: 'N', h: 'H' }[i.field]}: ${errors[i.code]}`)
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
    toast('Звіряння завершено.');
  }
  renderRows();
}
export function pasteDialog() {
  showDialog(
    'Вставити таблицю',
    `<p class="small">Один рядок — одна точка: <b>назва; E; N; H</b>. Висота необов’язкова. Можна вставити колонки з Excel (табуляція) або рядки з пробілами. Для чисел із розділеними тисячами використовуй крапку з комою або табуляцію.</p><label class="field-label" for="pasteOrder">Порядок координат</label><select id="pasteOrder"><option value="en">Назва; Rechtswert (E); Hochwert (N); Höhe (H)</option><option value="ne">Назва; Hochwert (N); Rechtswert (E); Höhe (H)</option></select><textarea id="pasteText" class="paste-area" placeholder="Af201;3500030.210;5600557.311\nAf202;3500029.444;5600557.784" spellcheck="false"></textarea><p id="pasteInfo" class="small"></p>`,
    `<button class="button subtle" data-close>Скасувати</button><button class="button primary" id="pasteApply">Додати точки</button>`,
    'paste',
  );
}
export function applyPaste() {
  const parsed = parseText($('pasteText').value, $('pasteOrder').value);
  if (!parsed.rows.length) {
    $('pasteInfo').textContent =
      'Не знайдено рядків із назвою та координатами. Перевір роздільники.';
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
      'Не вдалося прочитати рядки: ' +
        parsed.skipped.map((s) => `${s.line}: ${s.text}`).join(' · ') +
        '. Внеси їх вручну або виправ текст.',
    );
  toast('Додано точок: ' + parsed.rows.length);
}
export function exportDialog(format) {
  if (!ready()) return;
  const vals = validate(state.project.rows),
    withH = vals.filter((v) => !v.h.empty).length;
  const text = format === 'GSI' ? gsi(state.project.rows) : csv(state.project.rows);
  showDialog(
    'Експорт ' + format,
    `<div class="export-summary"><div><strong>${state.project.rows.length}</strong><span>звірених точок</span></div><div><strong>${withH}</strong><span>із висотою</span></div><div><strong>${state.project.rows.length - withH}</strong><span>без висоти</span></div></div><label class="field-label" for="exportName">Назва файлу (без розширення)</label><input id="exportName" class="file-name" value="${esc(state.project.name === 'Новий об’єкт' ? 'Absteckpunkte' : state.project.name)}" maxlength="100"><p class="small">${format === 'GSI' ? 'Leica GSI-16 · ASCII · CRLF · метри з кроком 0,001 м. Слова 11 (точка), 81 (E), 82 (N), 83 (H лише за наявності).' : 'CSV · UTF-8 BOM · крапка з комою між колонками · десяткова кома. Для відкриття в Excel.'}</p><div class="export-preview">${esc(text.split('\r\n').slice(0, 3).join('\n'))}${state.project.rows.length > 3 ? '\n…' : ''}</div><p class="small">Координати не перетворюються. Для GSI назви доповнюються нулями зліва до 16 символів — це структура формату.</p>`,
    `<button class="button subtle" data-close>Скасувати</button><button class="button primary" id="confirmExport" data-format="${format}">Зберегти .${format}</button>`,
    'export',
  );
}
export function saveProject() {
  download(
    JSON.stringify({ ...state.project, savedAt: new Date().toISOString() }, null, 2),
    'application/json',
    safeFilename(
      state.project.name === 'Новий об’єкт' ? 'PunktScan-Projekt' : state.project.name,
      'json',
    ),
  );
  toast('Проєкт підготовлено до збереження разом із фото.');
}
export async function openProject(file) {
  if (!file) return;
  try {
    if (file.size > 120 * 1024 * 1024) throw new Error('Файл завеликий (понад 120 МБ).');
    const imported = checkProject(JSON.parse(await file.text()));
    if (
      (state.project.rows.length || state.project.sources.length) &&
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
    state.project = imported;
    state.selected = state.project.sources[0]?.id || null;
    state.view = 'original';
    state.zoom = 1;
    $('projectName').value = state.project.name;
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
  const html = `<p class="small">Локальна схема без карти. E праворуч, N угору. Однаковий масштаб по обох осях; висоти не показано.</p><div class="map-wrap" style="margin-top:15px"><svg viewBox="0 0 800 480" role="img" aria-label="Розміщення точок"><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#dce7d3"/></pattern></defs><rect width="800" height="480" fill="url(#grid)"/><text x="400" y="25" text-anchor="middle" fill="#638050" font-size="14">N</text><text x="770" y="240" fill="#638050" font-size="14">E</text>${pts.map((p) => `<g><circle cx="${400 + (p.x - cx) * f}" cy="${240 - (p.y - cy) * f}" r="5" fill="${p.ok ? '#426e36' : '#c39336'}" stroke="#fff" stroke-width="2"><title>${esc(p.name)}: E ${p.x.toFixed(3)}, N ${p.y.toFixed(3)}</title></circle><text x="${409 + (p.x - cx) * f}" y="${236 - (p.y - cy) * f}" fill="#3b5e2e" font-size="11">${esc(p.name)}</text></g>`).join('')}</svg></div><p class="batch-note">Охоплення: ΔE ${(maxX - minX).toFixed(3)} м · ΔN ${(maxY - minY).toFixed(3)} м. Незвично віддалена точка може означати помилку розпізнавання.</p>`;
  showDialog(
    'Схема точок',
    html,
    `<button class="button subtle" data-close>Закрити</button>`,
    'map',
  );
}
export function helpDialog() {
  showDialog(
    'Як працювати з PunktScan',
    `<div class="help-content"><h3>Фото → звіряння → GSI</h3><p>Додай фото або скриншоти таблиць. Застосунок шукає межі таблиці; перевір рамку на вкладці «Межі». Усі потрібні рядки мають залишитися всередині. За потреби перетягни кути, поверни фото або вибери «Усе фото». Далі натисни «Розпізнати фото».</p><h3>Розпізнавання</h3><p>Для таблиць із чіткою сіткою клітинки читаються окремо. Без сітки застосунок читає рядки. Порядок E/N визначається за заголовками Rechtswert/Hochwert або Easting/Northing; якщо заголовки не прочитано, використовується E, N і показується повідомлення. Можна явно задати порядок перед розпізнаванням.</p><p>Очищення допомагає на фото екрана, але може погіршити дрібний або блідий текст. У такому разі вимкни його та розпізнай повторно. Розпізнавання замінює тільки точки вибраного фото. Помилково прочитані цифри не виправляються за здогадкою.</p><h3>Звір кожну точку</h3><p>Натисни кружечок у колонці «Звірка». Побачиш фрагмент <b>оригінального</b> фото, а не очищену копію. Звір назву, знак, усі цифри та десятковий роздільник. Натисни «Звірено · наступна». Зміна будь-якого поля скидає статус звіряння. На фото може бути більше рядків, ніж знайшов розпізнавач: завжди порівнюй кількість точок та переглядай результат розпізнавання.</p><h3>Правила координат</h3><ul><li>Усі значення — у метрах. Підтримуються від’ємні значення, десяткова крапка та кома.</li><li><code>3.415.030,210</code>, <code>3,415,030.210</code> та <code>3 415 030,210</code> можна ввести вручну або вставити з Excel.</li><li>Понад 3 десяткові знаки блокують експорт: виріши вручну, як округлити значення. Автоматичного округлення немає.</li><li>Порожня висота не записується у GSI; явне <code>0</code> записується як нульова висота.</li><li>Назви: до 16 символів, латинські літери, цифри, крапка, дефіс і підкреслення. Пробіли прибираються. Збіги після прибирання початкових нулів і без урахування регістру позначаються як дублікати.</li><li>Координати не перетворюються між системами: DB_REF, GK чи UTM мають лишитися такими, як у джерелі.</li></ul><h3>Формат і CAPLAN</h3><p>Експорт: стандартний Leica GSI-16, ASCII, завершення рядків CRLF. Ідентифікатори 11/81/82/83. Завантаж файл як координатні дані Leica GSI у своїй програмі. Сумісність конкретної версії CAPLAN і налаштувань імпорту перевір на першому файлі: E, N, висота та назви мають збігтися. Експорт не містить вимірювань станції чи польових кодів.</p><h3>Збереження та приватність</h3><p>Фото й точки обробляються у браузері та автоматично зберігаються в локальній чернетці. Вони не синхронізуються між пристроями. «Зберегти проєкт» завантажує JSON із фото, точками та результатами OCR. Імпорт такого файлу скидає статуси звіряння. Очищення даних браузера видалить чернетку — зберігай важливі проєкти файлом.</p><h3>iPhone та офлайн</h3><p>Відкрий застосунок у Safari. Через меню «Поширити» додай його на головний екран. Потім натисни «Офлайн» та завантаж необхідні файли. Перший запуск і завантаження модуля потребують інтернету; готовність офлайн підтверджується лише після завершення завантаження. iOS може видаляти кеш за нестачі місця.</p><h3>Підтримувані матеріали</h3><p>JPG, PNG і WebP; інші формати — якщо їх читає твій браузер. Якщо HEIC не відкривається, використай JPG або скриншот. PDF безпосередньо не підтримується: додай скриншот потрібної таблиці. До 20 фото по 20 МБ; довга сторона понад 2400 пікселів зменшується. Призначено для друкованих таблиць, не для рукописних записів чи розпізнавання всього креслення.</p><hr><p>Рушій розпізнавання: Tesseract.js __TESSERACT_VERSION__ (Apache-2.0). <a href="./licenses.txt" target="_blank" rel="noopener">Ліцензії компонентів</a>.</p></div>`,
    `<button class="button primary" data-close>Зрозуміло</button>`,
    'help',
  );
}
export async function prepareOffline() {
  showDialog(
    'Робота без інтернету',
    `<p class="small">Збережи застосунок і модуль розпізнавання на цьому пристрої. Це приблизно __OFFLINE_MB__ МБ. Фото не завантажуються на сервер. Після успішного збереження відкрий застосунок один раз без мережі, щоб перевірити доступність на своєму пристрої.</p><p id="offlineStatus" class="offline-progress">Перевірка…</p>`,
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
