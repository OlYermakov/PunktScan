import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { LANGUAGES, DEFAULT_LANG } from '../src/i18n.js';

const PLURAL = /_(zero|one|two|few|many|other)$/;
const dictionaries = Object.fromEntries(
  await Promise.all(
    Object.keys(LANGUAGES).map(async (code) => [
      code,
      (await import(`../src/lang-${code}.js`)).default,
    ]),
  ),
);
const base = dictionaries[DEFAULT_LANG];
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...s.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[0]).join(' ');

test('German is the default language', () => assert.equal(DEFAULT_LANG, 'de'));

for (const [code, dict] of Object.entries(dictionaries)) {
  test(`${code}: same keys, placeholders and markup as German`, () => {
    const keys = (d) =>
      Object.keys(d)
        .filter((k) => !PLURAL.test(k))
        .sort();
    assert.deepEqual(keys(dict), keys(base));
    for (const key of keys(base)) {
      assert.equal(typeof dict[key], 'string', key);
      assert.ok(dict[key].trim(), `${code} ${key} is empty`);
      assert.deepEqual(placeholders(dict[key]), placeholders(base[key]), `${code} ${key}`);
      assert.equal(tags(dict[key]), tags(base[key]), `${code} ${key} markup`);
    }
  });

  test(`${code}: every plural form the language needs is present`, () => {
    const bases = new Set(
      Object.keys(base)
        .filter((k) => PLURAL.test(k))
        .map((k) => k.replace(PLURAL, '')),
    );
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const key of bases)
      for (const category of categories) {
        // "many" for fr/it/es only applies to exact millions; "other" covers it.
        if (category === 'many' && ['fr', 'it', 'es'].includes(code)) continue;
        const form = dict[`${key}_${category}`];
        assert.ok(form, `${code} ${key}_${category}`);
        assert.deepEqual(placeholders(form), ['n'], `${code} ${key}_${category}`);
      }
  });
}

test('no hard-coded Ukrainian text is left outside the Ukrainian dictionary', async () => {
  const dir = new URL('../src/', import.meta.url);
  for (const file of await fs.readdir(dir)) {
    if (!/\.(js|html|webmanifest|css)$/.test(file) || file === 'lang-uk.js') continue;
    const lines = (await fs.readFile(new URL(file, dir), 'utf8'))
      .split('\n')
      .filter((line) => /[Ѐ-ӿ]/.test(line))
      // Allowed: the language's own name in the picker and the multilingual <noscript>.
      .filter((line) => !/uk: 'Українська'|PunktScan потребує JavaScript/.test(line));
    assert.deepEqual(lines, [], file);
  }
});
