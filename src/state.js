import { validate, PROJECT_VERSION } from './core.js?v=__BUILD__';

// Shared, mutable application state. Modules read and write `state.*`.
export const uid = () =>
  crypto.randomUUID?.() || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2);
export const blank = () => ({
  format: 'PunktScan',
  version: PROJECT_VERSION,
  name: 'Новий об’єкт',
  sources: [],
  rows: [],
});

export const state = {
  project: blank(),
  selected: null,
  view: 'original',
  zoom: 1,
  filter: 'all',
  busy: false,
  recognizing: false,
  history: [],
};
export const errors = {
  required: 'Потрібне значення',
  number: 'Перевір цифри та роздільник',
  precision: 'Понад 3 знаки: виправ вручну',
  range: 'Поза діапазоном GSI-16',
  nameRequired: 'Потрібна назва',
  nameLength: 'Не більше 16 символів',
  nameChars: 'Латиниця, цифри, _ . -',
  duplicate: 'Назва повторюється',
};
export const source = () => state.project.sources.find((s) => s.id === state.selected);
export const ready = () =>
  state.project.rows.length > 0 &&
  validate(state.project.rows).every((v) => !v.issues.length && v.row.verified);
