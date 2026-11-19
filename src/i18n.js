// Interface languages. German is the default and the fallback for any missing key.
export const LANGUAGES = {
  de: 'Deutsch',
  en: 'English',
  fr: 'Français',
  it: 'Italiano',
  es: 'Español',
  pl: 'Polski',
  uk: 'Українська',
};
export const DEFAULT_LANG = 'de';
const STORAGE_KEY = 'punktscan-lang';

let dict = {},
  fallback = {},
  plural = new Intl.PluralRules(DEFAULT_LANG);
export let lang = DEFAULT_LANG;

function storedLanguage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// Loads the saved language (or German). Only the active dictionary and German are fetched.
export async function loadLanguage(code = storedLanguage()) {
  lang = Object.hasOwn(LANGUAGES, code ?? '') ? code : DEFAULT_LANG;
  fallback = (await import('./lang-de.js?v=__BUILD__')).default;
  dict = lang === DEFAULT_LANG ? fallback : (await import(`./lang-${lang}.js?v=__BUILD__`)).default;
  plural = new Intl.PluralRules(lang);
  document.documentElement.lang = lang;
  return lang;
}

export function saveLanguage(code) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

// t('key', { n: 3 }) → text with {n} replaced. Unknown keys show the key itself.
export function t(key, params = {}) {
  const text = dict[key] ?? fallback[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

// Plural-aware text: picks key_one / key_few / key_many / key_other for the language.
export function tp(key, n, params = {}) {
  const form = `${key}_${plural.select(n)}`;
  const chosen = form in dict || form in fallback ? form : `${key}_other`;
  return t(chosen, { n, ...params });
}

// Static markup: data-i18n (text), data-i18n-html (trusted markup from our dictionaries),
// data-i18n-attr="aria-label:key;title:key".
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-attr]'))
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr.trim(), t(key.trim()));
    }
  document.title = t('meta.title');
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute('content', t('meta.description'));
}
