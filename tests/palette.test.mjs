// The palette in src/style.css: every colour is a role, and every text role is readable on the
// surfaces it is used on, in each theme.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const css = (await fs.readFile('src/style.css', 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
const block = (selector) => {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, selector);
  const body = css.slice(start + selector.length + 2, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
};
const light = block(':root');
const themes = {
  light,
  dark: { ...light, ...block(":root[data-theme='dark']") },
  sun: { ...light, ...block(":root[data-theme='sun']") },
};

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('no colour is named outside the palette', () => {
  const outside = css
    .replace(/:root(\[data-theme='[a-z]+'\])? \{[^}]*\}/g, '')
    .match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g);
  assert.equal(outside, null, String(outside));
});

test('every role used is defined, and the automatic dark theme equals the dark one', () => {
  const used = new Set([...css.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]));
  assert.deepEqual(
    [...used].filter((name) => !(name in light)),
    [],
  );
  const auto = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  assert.deepEqual(
    Object.fromEntries(
      [...auto.slice(0, auto.indexOf('}')).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [
        m[1],
        m[2].trim(),
      ]),
    ),
    block(":root[data-theme='dark']"),
  );
  for (const [name, values] of Object.entries(themes))
    for (const [role, value] of Object.entries(values))
      assert.match(value, /^#[0-9a-f]{6}$/, `${name} ${role}`);
});

// Text roles and the surfaces they are used on (WCAG AA: 4.5 for normal text).
const PAIRS = [
  ...['ink', 'ink-soft', 'muted', 'faint', 'brand-text'].flatMap((text) =>
    ['canvas', 'surface', 'surface-soft'].map((bg) => [text, bg]),
  ),
  ['brand-text', 'brand-soft'],
  ...['ok', 'warn', 'err'].flatMap((s) => [
    [s, 'surface'],
    [s, s + '-soft'],
  ]),
  ['ink', 'warn-soft'],
  ['ink', 'err-soft'],
  ['ink', 'info-soft'],
  ...['on-brand', 'on-brand-muted', 'on-brand-faint'].flatMap((text) =>
    ['brand-900', 'brand-800'].map((bg) => [text, bg]),
  ),
  ['on-brand', 'primary'],
  ['on-brand', 'primary-hover'],
  ['on-brand', 'danger'],
  ['on-accent', 'accent'],
  ['on-accent', 'mark'],
];

for (const [name, palette] of Object.entries(themes))
  test(`${name} theme: every text role is readable on its surfaces`, () => {
    const low = PAIRS.map(([text, bg]) => [text, bg, contrast(palette[text], palette[bg])])
      .filter(([, , ratio]) => ratio < 4.5)
      .map(([text, bg, ratio]) => `${text} on ${bg}: ${ratio.toFixed(2)}`);
    assert.deepEqual(low, []);
  });

test('layers: cards sit above the page and fields above the cards in the dark theme', () => {
  const { canvas, surface } = themes.dark;
  assert.ok(luminance(surface) > luminance(canvas));
  assert.ok(luminance(themes.dark['surface-soft']) > luminance(surface));
});
