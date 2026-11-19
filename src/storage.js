import { PROJECT_VERSION } from './core.js?v=__BUILD__';
import { state } from './state.js?v=__BUILD__';
import { $, notice } from './dom.js?v=__BUILD__';

let saveTimer,
  db = null,
  saveChain = Promise.resolve();
export function save() {
  clearTimeout(saveTimer);
  $('saveState').textContent = 'Збереження…';
  saveTimer = setTimeout(persist, 550);
}
export function persist() {
  if (!db) {
    $('saveState').textContent = 'Збережи проєкт файлом';
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
    .then(() => ($('saveState').textContent = 'Чернетку збережено'))
    .catch(() => {
      $('saveState').textContent = 'Не вдалося зберегти';
      notice(
        'Браузер не зміг зберегти чернетку. Завантаж проєкт файлом, щоб не втратити фото та точки.',
      );
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
      state.project = stored;
      state.selected = state.project.sources[0]?.id || null;
      $('projectName').value = state.project.name;
      $('saveState').textContent = 'Чернетку відновлено';
    }
  } catch {
    $('saveState').textContent = 'Збереження файлом';
    notice('Локальне збереження недоступне. Користуйся кнопкою «Зберегти проєкт».');
  }
}
// Writes the draft immediately; the returned promise settles when IndexedDB is done.
export function flushSave() {
  clearTimeout(saveTimer);
  persist();
  return saveChain;
}
