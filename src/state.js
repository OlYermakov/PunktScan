import { validate, plausibility, PROJECT_VERSION } from './core.js?v=__BUILD__';
import { t, lang } from './i18n.js?v=__BUILD__';

// Shared, mutable application state. Modules read and write `state.*`.
export const uid = () =>
  crypto.randomUUID?.() || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2);
export const blank = () => ({
  // Each project in the browser's list has its own id.
  id: uid(),
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
// Plausibility findings per row id (see core.js), recomputed only when a value changes.
let findingsCache = { key: null, byId: new Map() };
export function findings() {
  const rows = state.project.rows,
    key = rows.map((r) => [r.id, r.name, r.e, r.n, r.h].join('\u0001')).join('\u0002');
  if (key !== findingsCache.key) {
    const found = plausibility(validate(rows));
    findingsCache = { key, byId: new Map(rows.map((r) => [r.id, found.get(r) ?? []])) };
  }
  return findingsCache.byId;
}
export const findingsFor = (row, field) =>
  (findings().get(row.id) ?? []).filter((f) => !field || f.field === field);
// Text of one plausibility finding (core.js) for the review card and the table.
export function findingText(f) {
  const number = (x) =>
    new Intl.NumberFormat(lang, { maximumFractionDigits: x < 100 ? 1 : 0 }).format(x);
  if (f.code === 'far')
    return t('warn.far', { distance: number(f.distance), axis: f.field.toUpperCase() });
  if (f.code === 'height') return t('warn.height', { distance: number(f.difference) });
  if (f.code === 'sequence') return t('warn.sequence', { expected: f.expected });
  return t('warn.gap', { missing: f.missing.join(', ') });
}
export const source = () => state.project.sources.find((s) => s.id === state.selected);
export const ready = () =>
  state.project.rows.length > 0 &&
  validate(state.project.rows).every((v) => !v.issues.length && v.row.verified);
