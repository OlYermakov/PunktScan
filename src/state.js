import { validate, PROJECT_VERSION } from './core.js?v=__BUILD__';
import { t } from './i18n.js?v=__BUILD__';

// Shared, mutable application state. Modules read and write `state.*`.
export const uid = () =>
  crypto.randomUUID?.() || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2);
export const blank = () => ({
  format: 'PunktScan',
  version: PROJECT_VERSION,
  // An empty name shows the translated placeholder ("Neues Objekt", "New site", …).
  name: '',
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
// Validation messages by error code from core.js, in the interface language.
export const errors = new Proxy({}, { get: (_, code) => t('error.' + String(code)) });
// Drafts saved before translation used this Ukrainian default name: treat it as unnamed.
export const projectName = (name) => {
  const value = String(name ?? '').trim();
  return value === '\u041d\u043e\u0432\u0438\u0439 \u043e\u0431\u2019\u0454\u043a\u0442'
    ? ''
    : value;
};
export const source = () => state.project.sources.find((s) => s.id === state.selected);
export const ready = () =>
  state.project.rows.length > 0 &&
  validate(state.project.rows).every((v) => !v.issues.length && v.row.verified);
