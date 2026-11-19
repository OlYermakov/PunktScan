import { gsi, csv, safeFilename } from './core.js?v=__BUILD__';
import { findTable, fullQuad } from './imaging.js?v=__BUILD__';
import { uid, blank, state, source, ready } from './state.js?v=__BUILD__';
import {
  $,
  toast,
  notice,
  imageFrom,
  canvas,
  pixelsFor,
  download,
  esc,
} from './dom.js?v=__BUILD__';
import { save, restore, flushSave } from './storage.js?v=__BUILD__';
import { snapshot, undo, render, renderPhoto, renderRows, setBusy } from './render.js?v=__BUILD__';
import { addPhotos } from './photos.js?v=__BUILD__';
import { recognize, cancelOcr } from './ocr.js?v=__BUILD__';
import {
  showDialog,
  closeDialog,
  showReview,
  updateReviewErrors,
  verifyNext,
  pasteDialog,
  applyPaste,
  exportDialog,
  saveProject,
  openProject,
  mapDialog,
  helpDialog,
  prepareOffline,
  cacheOffline,
  stepReview,
  toggleSign,
} from './dialogs.js?v=__BUILD__';

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
  if (state.busy) return;
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    const id = remove.dataset.remove;
    if (
      state.project.rows.some((r) => r.sourceId === id) &&
      !confirm('Видалити фото та всі пов’язані точки?')
    )
      return;
    snapshot();
    state.project.sources = state.project.sources.filter((s) => s.id !== id);
    state.project.rows = state.project.rows.filter((r) => r.sourceId !== id);
    if (state.selected === id) state.selected = state.project.sources[0]?.id || null;
    render();
    save();
    return;
  }
  const el = e.target.closest('[data-source]');
  if (el) {
    state.selected = el.dataset.source;
    state.view = 'original';
    state.zoom = 1;
    render();
  }
});
$('viewTabs').onclick = (e) => {
  if (e.target.dataset.view) {
    state.view = e.target.dataset.view;
    state.zoom = 1;
    renderPhoto();
  }
};
$('zoomInBtn').onclick = () => {
  state.zoom = Math.min(4, state.zoom + 0.5);
  renderPhoto();
};
$('zoomOutBtn').onclick = () => {
  state.zoom = Math.max(0.5, state.zoom - 0.5);
  renderPhoto();
};
let dragCorner = null;
$('frameOverlay').addEventListener('pointerdown', (e) => {
  if (state.busy) return;
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
  if (!c || state.busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key))
    return;
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
  if (state.busy || !source()) return;
  const s = source();
  setBusy(true);
  try {
    const px = await pixelsFor(s);
    const q = findTable(px.data, s.width, s.height);
    if (q) {
      snapshot();
      s.quad = q;
      state.view = 'frame';
      renderPhoto();
      save();
    } else toast('Чітку сітку не знайдено. Вистав межі вручну.');
  } finally {
    setBusy(false);
  }
};
$('rotateBtn').onclick = async () => {
  const s = source();
  if (!s || state.busy) return;
  if (
    state.project.rows.some((r) => r.sourceId === s.id) &&
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
  state.project.rows = state.project.rows.filter((r) => r.sourceId !== s.id);
  state.view = 'frame';
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
    state.project.name = 'Навчальний приклад';
    $('projectName').value = state.project.name;
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
  const r = state.project.rows.find((r) => r.id === el.dataset.id);
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
    state.project.rows = state.project.rows.filter((r) => r.id !== d.dataset.deleteRow);
    renderRows();
    save();
  }
});
$('addPointBtn').onclick = () => {
  snapshot();
  const r = { id: uid(), name: '', e: '', n: '', h: '', sourceId: null, verified: false };
  state.project.rows.push(r);
  render();
  save();
  showReview(r.id);
};
$('filters').onclick = (e) => {
  const b = e.target.closest('[data-filter]');
  if (b) {
    state.filter = b.dataset.filter;
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
  state.project.name = e.target.value;
  save();
};
$('projectName').onchange = (e) => {
  snapshot();
  state.project.name = e.target.value.trim() || 'Новий об’єкт';
  e.target.value = state.project.name;
  save();
};
$('undoBtn').onclick = undo;
$('pasteBtn').onclick = pasteDialog;
$('saveProjectBtn').onclick = saveProject;
$('openProjectBtn').onclick = () => $('projectInput').click();
$('projectInput').onchange = (e) => openProject(e.target.files[0]);
$('newProjectBtn').onclick = () => {
  if (
    (state.project.rows.length || state.project.sources.length) &&
    !confirm(
      'Почати новий проєкт? Поточна чернетка буде замінена. За потреби спочатку збережи її файлом.',
    )
  )
    return;
  snapshot();
  state.project = blank();
  state.selected = null;
  state.filter = 'all';
  $('projectName').value = state.project.name;
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
  if (e.target.id === 'prevReview' || e.target.id === 'nextReview')
    stepReview(e.target.id === 'nextReview' ? 1 : -1);
  if (e.target.dataset.sign) toggleSign(e.target.dataset.sign);
  if (e.target.id === 'pasteApply') applyPaste();
  if (e.target.id === 'cacheOfflineBtn') cacheOffline();
  if (e.target.id === 'confirmExport') {
    const format = e.target.dataset.format;
    if (!ready()) return;
    download(
      format === 'GSI' ? gsi(state.project.rows) : csv(state.project.rows),
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
window.addEventListener('pagehide', flushSave);
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
if ('serviceWorker' in navigator) {
  // A new service worker takes over after a deploy. Pages that were already running keep the old
  // code in memory, so offer a reload instead of switching versions under the user's feet.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) $('updateBar').hidden = false;
  });
  navigator.serviceWorker
    .register('./sw.js')
    .then((registration) => {
      // Installed home-screen apps can stay open for days: check for updates hourly.
      setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
    })
    .catch(() => {});
}
$('updateBtn').onclick = async () => {
  if (state.busy && !confirm('Розпізнавання ще триває. Перервати його та оновити застосунок?'))
    return;
  await flushSave();
  location.reload();
};
restore().then(render);
