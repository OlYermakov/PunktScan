import { PROJECT_VERSION } from './core.js?v=__BUILD__';
import { state, projectName, uid } from './state.js?v=__BUILD__';
import { $, notice } from './dom.js?v=__BUILD__';
import { t } from './i18n.js?v=__BUILD__';

// IndexedDB keeps every project of this browser in the "projects" store:
//   'p:<id>'  the whole project with its photos,
//   'index'   a short entry per project for the list (name, date, counts, thumbnail),
//   'active'  the id of the project that was open last.
// Versions before the project list kept a single draft under 'current'; it is moved on start.
let saveTimer,
  db = null,
  saveChain = Promise.resolve(),
  index = [];
const thumbs = new Map();

export const storageReady = () => !!db;
const empty = (p) => !p.rows.length && !p.sources.length;

export function save() {
  clearTimeout(saveTimer);
  $('saveState').textContent = t('save.saving');
  saveTimer = setTimeout(persist, 550);
}

function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function write(fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
    fn(tx.objectStore('projects'));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// A small picture of the first photo for the project list (made once per photo).
async function thumbnail(source) {
  if (!source) return null;
  if (thumbs.has(source.id)) return thumbs.get(source.id);
  const img = new Image();
  img.src = source.image;
  await img.decode();
  const scale = Math.min(1, 96 / Math.max(img.naturalWidth, img.naturalHeight)),
    canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.7);
  thumbs.set(source.id, url);
  return url;
}

function entry(p, thumb) {
  return {
    id: p.id,
    name: p.name,
    updated: p.updated,
    points: p.rows.length,
    verified: p.rows.filter((r) => r.verified).length,
    photos: p.sources.length,
    thumb,
  };
}

export function persist() {
  if (!db) {
    $('saveState').textContent = t('save.useFile');
    return;
  }
  const data = structuredClone(state.project);
  data.updated = state.project.updated = Date.now();
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      const thumb = await thumbnail(data.sources[0]).catch(() => null);
      // An empty project is not kept: it would only clutter the list.
      index = index.filter((e) => e.id !== data.id);
      if (!empty(data)) index.unshift(entry(data, thumb));
      await write((store) => {
        if (empty(data)) store.delete('p:' + data.id);
        else store.put(data, 'p:' + data.id);
        store.put(index, 'index');
        store.put(data.id, 'active');
      });
    })
    .then(() => ($('saveState').textContent = t('save.saved')))
    .catch(() => {
      $('saveState').textContent = t('save.failed');
      notice(t('save.failedNotice'));
    });
}

export async function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('punktscan-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('projects');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const usable = (p) => p?.format === 'PunktScan' && p.version === PROJECT_VERSION;

function use(project) {
  state.project = { ...project, id: project.id || uid(), name: projectName(project.name) };
  state.selected = state.project.sources[0]?.id || null;
  state.history = [];
  state.view = 'original';
  state.zoom = 1;
  state.filter = 'all';
  $('undoBtn').disabled = true;
  $('projectName').value = state.project.name;
}

export async function restore() {
  try {
    db = await openDB();
    const store = db.transaction('projects').objectStore('projects');
    const [legacy, stored, active] = await Promise.all(
      ['current', 'index', 'active'].map((k) => request(store.get(k))),
    );
    index = Array.isArray(stored) ? stored : [];
    if (usable(legacy)) {
      const p = { ...legacy, id: legacy.id || uid(), updated: legacy.updated || Date.now() };
      index = [entry(p, null), ...index.filter((e) => e.id !== p.id)];
      await write((s) => {
        s.put(p, 'p:' + p.id);
        s.put(index, 'index');
        s.put(p.id, 'active');
        s.delete('current');
      });
      use(p);
      $('saveState').textContent = t('save.restored');
      return;
    }
    const project = active ? await load(active) : null;
    if (project) {
      use(project);
      $('saveState').textContent = t('save.restored');
    }
  } catch {
    $('saveState').textContent = t('save.fileOnly');
    notice(t('save.unavailable'));
  }
}

async function load(id) {
  const p = await request(
    db
      .transaction('projects')
      .objectStore('projects')
      .get('p:' + id),
  );
  return usable(p) ? p : null;
}

// Other saved projects, newest first.
export function listProjects() {
  return index
    .filter((e) => e.id !== state.project.id)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

// Saves the open project and switches to a stored one. Returns false if it cannot be read.
export async function switchProject(id) {
  await flushSave();
  const project = await load(id).catch(() => null);
  if (!project) return false;
  use(project);
  persist();
  return true;
}

// Saves the open project and starts another one (empty, or read from a file).
export async function startProject(project) {
  await flushSave();
  use(project);
  persist();
}

export async function deleteProject(id) {
  index = index.filter((e) => e.id !== id);
  await write((store) => {
    store.delete('p:' + id);
    store.put(index, 'index');
  });
}

// Writes the draft immediately; the returned promise settles when IndexedDB is done.
export function flushSave() {
  clearTimeout(saveTimer);
  persist();
  return saveChain;
}
