import { PROJECT_VERSION } from './core.js?v=__BUILD__';
import { state, projectName } from './state.js?v=__BUILD__';
import { $, notice } from './dom.js?v=__BUILD__';
import { t } from './i18n.js?v=__BUILD__';

let saveTimer,
  db = null,
  saveChain = Promise.resolve();
export function save() {
  clearTimeout(saveTimer);
  $('saveState').textContent = t('save.saving');
  saveTimer = setTimeout(persist, 550);
}
export function persist() {
  if (!db) {
    $('saveState').textContent = t('save.useFile');
    return;
  }
  const data = structuredClone(state.project);
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
export async function restore() {
  try {
    db = await openDB();
    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction('projects');
      const r = tx.objectStore('projects').get('current');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (stored?.format === 'PunktScan' && stored.version === PROJECT_VERSION) {
      state.project = { ...stored, name: projectName(stored.name) };
      state.selected = state.project.sources[0]?.id || null;
      $('projectName').value = state.project.name;
      $('saveState').textContent = t('save.restored');
    }
  } catch {
    $('saveState').textContent = t('save.fileOnly');
    notice(t('save.unavailable'));
  }
}
// Writes the draft immediately; the returned promise settles when IndexedDB is done.
export function flushSave() {
  clearTimeout(saveTimer);
  persist();
  return saveChain;
}
