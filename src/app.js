import { gsi, csv, safeFilename } from './core.js?v=__BUILD__';
import { findTable, fullQuad } from './imaging.js?v=__BUILD__';
import { uid, blank, state, source, ready, projectName } from './state.js?v=__BUILD__';
import {
  LANGUAGES,
  lang,
  loadLanguage,
  saveLanguage,
  t,
  translatePage,
} from './i18n.js?v=__BUILD__';
import {
  $,
  toast,
  notice,
  imageFrom,
  canvas,
  pixelsFor,
  download,
  esc,
  shareFile,
} from './dom.js?v=__BUILD__';
import {
  save,
  restore,
  flushSave,
  startProject,
  switchProject,
  deleteProject,
} from './storage.js?v=__BUILD__';
import { snapshot, undo, render, renderPhoto, renderRows, setBusy } from './render.js?v=__BUILD__';
import { addPhotos } from './photos.js?v=__BUILD__';
import { initFrameDrag } from './frame.js?v=__BUILD__';
import { showScreen, renderFlow } from './flow.js?v=__BUILD__';
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
  openNextReview,
  editReview,
  verifyAllConfident,
  toggleSign,
  projectsDialog,
} from './dialogs.js?v=__BUILD__';

// The interface language must be loaded before anything renders text.
await loadLanguage();
translatePage();
for (const [code, name] of Object.entries(LANGUAGES))
  $('langSelect').append(new Option(name, code, code === lang, code === lang));
// "UK" would read as United Kingdom: show the country code for Ukrainian.
$('langCode').textContent = lang === 'uk' ? 'UA' : lang.toUpperCase();
$('langSelect').onchange = async (e) => {
  saveLanguage(e.target.value);
  // Reload so every message, including ones already on screen, uses the new language.
  await flushSave();
  location.reload();
};

// Display: automatic (follows the system), light, dark, or high contrast for bright sunlight.
const THEMES = ['auto', 'light', 'dark', 'sun'];
function storedTheme() {
  try {
    return localStorage.getItem('punktscan-theme');
  } catch {
    return null;
  }
}
// The header keeps its colour in every theme, so the phone's status bar colour stays the same.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}
const theme = THEMES.includes(storedTheme()) ? storedTheme() : 'auto';
for (const code of THEMES)
  $('themeSelect').append(new Option(t('theme.' + code), code, code === theme, code === theme));
applyTheme(theme);
$('themeSelect').onchange = (e) => {
  applyTheme(e.target.value);
  try {
    localStorage.setItem('punktscan-theme', e.target.value);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
};

$('uploadBtn').onclick = () => $('photoInput').click();
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
    if (state.project.rows.some((r) => r.sourceId === id) && !confirm(t('photo.removeConfirm')))
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
initFrameDrag();
$('frameOverlay').addEventListener('keydown', (e) => {
  const c = e.target.closest('[data-corner]');
  if (!c || state.busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key))
    return;
  e.preventDefault();
  snapshot();
  source().frameEdited = true;
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
  source().frameEdited = true;
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
      s.frameEdited = false;
      state.view = 'frame';
      renderPhoto();
      save();
    } else toast(t('photo.frameNotFound'));
  } finally {
    setBusy(false);
  }
};
$('rotateBtn').onclick = async () => {
  const s = source();
  if (!s || state.busy) return;
  if (state.project.rows.some((r) => r.sourceId === s.id) && !confirm(t('photo.rotateConfirm')))
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
  // A typed value is the user's own: its recognition highlights no longer apply.
  if (r.uncertainChars) r.uncertainChars[['name', 'e', 'n', 'h'].indexOf(el.dataset.field)] = [];
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
  state.project.name = projectName(e.target.value);
  e.target.value = state.project.name;
  save();
};
$('undoBtn').onclick = undo;
$('pasteBtn').onclick = pasteDialog;
$('saveProjectBtn').onclick = saveProject;
$('openProjectBtn').onclick = () => $('projectInput').click();
$('projectInput').onchange = (e) => openProject(e.target.files[0]);
// A new project leaves the open one in the project list (an empty one is simply dropped).
async function newProject() {
  if (state.busy) return;
  const kept = state.project.rows.length || state.project.sources.length;
  closeDialog();
  await startProject(blank());
  notice();
  render();
  if (kept) toast(t('projects.kept'));
}
$('newProjectBtn').onclick = newProject;
$('projectsBtn').onclick = projectsDialog;
document.addEventListener('click', async (e) => {
  if (e.target.closest('#dialogNewProject')) return newProject();
  const open = e.target.closest('[data-project-open]'),
    remove = e.target.closest('[data-project-delete]');
  if (state.busy || !(open || remove)) return;
  if (open) {
    if (!(await switchProject(open.dataset.projectOpen))) return notice(t('projects.openFailed'));
    closeDialog();
    notice();
    render();
    toast(t('projects.opened', { name: state.project.name || t('project.untitled') }));
    return;
  }
  const item = remove.closest('.project-item'),
    name = item.querySelector('strong').textContent;
  if (!confirm(t('projects.deleteConfirm', { name }))) return;
  await deleteProject(remove.dataset.projectDelete);
  if ($('dialog').open && document.querySelector('#dialog .project-list')) projectsDialog();
  render();
});
$('exportBtn').onclick = () => exportDialog('GSI');
$('csvBtn').onclick = () => exportDialog('CSV');
$('mapBtn').onclick = mapDialog;
$('helpBtn').onclick = helpDialog;
$('offlineBtn').onclick = prepareOffline;
$('rawTextBtn').onclick = () => {
  const s = source();
  if (!s) return;
  showDialog(
    t('table.raw'),
    `<p class="small">${t('raw.text')}</p><pre class="raw-text">${esc(s.raw)}</pre>${s.skipped ? `<h3>${t('raw.skipped')}</h3><pre class="raw-text">${esc(s.skipped)}</pre>` : ''}`,
    `<button class="button subtle" data-close>${t('common.close')}</button>`,
    'raw',
  );
};
$('dialog').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) {
    closeDialog();
    return;
  }
  if (e.target.id === 'verifyNextBtn') verifyNext();
  if (e.target.id === 'reviewEditBtn') editReview(true);
  if (e.target.id === 'reviewViewBtn') editReview(false);
  if (e.target.id === 'verifyAllBtn') verifyAllConfident();
  const open = e.target.closest('[data-open-review]');
  if (open) showReview(open.dataset.openReview);
  if (e.target.id === 'prevReview' || e.target.id === 'nextReview')
    stepReview(e.target.id === 'nextReview' ? 1 : -1);
  if (e.target.dataset.sign) toggleSign(e.target.dataset.sign);
  if (e.target.id === 'pasteApply') applyPaste();
  if (e.target.id === 'cacheOfflineBtn') cacheOffline();
  if (e.target.id === 'confirmExport' || e.target.id === 'shareExport') {
    const format = e.target.dataset.format;
    if (!ready()) return;
    const content = format === 'GSI' ? gsi(state.project.rows) : csv(state.project.rows),
      type = format === 'GSI' ? 'text/plain' : 'text/csv',
      name = safeFilename($('exportName').value, format);
    if (e.target.id === 'confirmExport') {
      download(content, type + (format === 'GSI' ? ';charset=us-ascii' : ';charset=utf-8'), name);
      closeDialog();
      toast(t('export.savedToast', { format }));
      return;
    }
    // The share sheet must open within this tap, so nothing is awaited before it.
    shareFile(content, type, name).then((result) => {
      if (result === 'cancelled') return;
      if (result === 'failed') {
        download(content, type, name);
        toast(t('export.shareFailed'));
      } else toast(t('export.sharedToast', { format }));
      closeDialog();
    });
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
  if (state.busy && !confirm(t('update.busyConfirm'))) return;
  await flushSave();
  location.reload();
};
restore().then(render);

// Guided flow: the phone's bottom button runs the next step; the step bar scrolls to its section.
$('nextStepBtn').onclick = (e) => {
  const action = e.currentTarget.dataset.action;
  if (action === 'photo') $('photoInput').click();
  if (action === 'recognize') recognize();
  if (action === 'recognizeAll') recognize(true);
  if (action === 'export') exportDialog('GSI');
  if (action === 'review') {
    openNextReview();
  }
};
$('nextCsvBtn').onclick = () => exportDialog('CSV');
$('flowSteps').onclick = (e) => {
  const button = e.target.closest('[data-step-target]');
  // Phones: the step bar switches between the photo, review and file screens.
  if (button && matchMedia('(max-width: 760px)').matches) {
    const screen = {
      uploadBtn: 'photo',
      imageWorkspace: 'photo',
      pointsSection: 'review',
      exportBar: 'file',
    }[button.dataset.stepTarget];
    showScreen(screen);
    renderFlow();
    return;
  }
  const target = $(button?.dataset.stepTarget);
  // The export bar is hidden on phones; its actions are in the bottom bar there.
  if (target?.checkVisibility()) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
function toggleMoreMenu(open = $('moreMenu').hidden) {
  $('moreMenu').hidden = !open;
  $('moreBtn').setAttribute('aria-expanded', String(open));
  if (open) $('moreMenu').querySelector('button').focus();
}
$('moreBtn').onclick = () => toggleMoreMenu();
$('moreMenu').onclick = (e) => {
  const proxy = e.target.closest('[data-proxy]');
  if (!proxy) return;
  toggleMoreMenu(false);
  $(proxy.dataset.proxy).click();
};
document.addEventListener('click', (e) => {
  if (!$('moreMenu').hidden && !e.target.closest('#moreMenu, #moreBtn')) toggleMoreMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('moreMenu').hidden) {
    toggleMoreMenu(false);
    $('moreBtn').focus();
  }
});

// Recognised cells on the photo: tap one to review its point; hovering links photo and table.
$('resultOverlay').addEventListener('click', (e) => {
  const cell = e.target.closest('[data-row]');
  if (cell && !state.busy) showReview(cell.dataset.row);
});
const highlight = (id) => {
  for (const el of document.querySelectorAll('#resultOverlay .hover, #pointsBody tr.hover'))
    el.classList.remove('hover');
  if (!id) return;
  for (const el of document.querySelectorAll(
    `#resultOverlay [data-row="${CSS.escape(id)}"], #pointsBody tr[data-row="${CSS.escape(id)}"]`,
  ))
    el.classList.add('hover');
};
for (const el of [$('resultOverlay'), $('pointsBody')]) {
  el.addEventListener('pointerover', (e) => highlight(e.target.closest('[data-row]')?.dataset.row));
  el.addEventListener('pointerleave', () => highlight(null));
}
$('fileSummary').addEventListener('click', (e) => {
  if (e.target.closest('[data-open-map]')) mapDialog();
});
