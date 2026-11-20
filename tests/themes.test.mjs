import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { themeCss, parseCss, hexToOklab, oklabToHex, darkColor } from '../scripts/themes.mjs';

test('OKLab conversion round-trips sRGB colours', () => {
  for (const hex of ['#ffffff', '#000000', '#2d4f3c', '#bcf34e', '#d23b2f', '#fff7e7'])
    assert.equal(oklabToHex(hexToOklab(hex)), hex);
  assert.equal(oklabToHex(hexToOklab('#fff')), '#ffffff');
  assert.equal(oklabToHex(hexToOklab('#13291a55')), '#13291a55');
});

test('the dark theme mirrors lightness: white surfaces get dark grey, dark text gets light', () => {
  const page = darkColor(hexToOklab('#ffffff'));
  // Dark, but not black.
  assert.ok(page.L > 0.25 && page.L < 0.35, String(page.L));
  assert.ok(darkColor(hexToOklab('#1c3636'), 'text').L > 0.8);
});

test('every colour rule is repeated under each theme, in the same media query', () => {
  const css = `
.a { color: #1c3636; padding: 4px; }
.b, .c:hover { background: #fff; border: 1px solid #dce5da; }
.d { background: transparent; color: inherit; }
.e { background: transparent; color: #000; box-shadow: 0 2px 10px #162c1720; }
.ring { box-shadow: 0 0 0 3px #bcf34e; }
.sidebar .x { color: #fff; }
@media (max-width: 760px) { .a { color: #6f8169; } }
@keyframes spin { to { transform: rotate(1turn); } }`;
  const out = themeCss(css);
  assert.match(out, /:root\[data-theme='dark'\] \.a \{\n {2}color: #/);
  assert.match(out, /:root\[data-theme='dark'\] \.b,\n:root\[data-theme='dark'\] \.c:hover \{/);
  assert.match(out, /:root\[data-theme='sun'\] \.a \{/);
  assert.match(
    out,
    /@media \(prefers-color-scheme: dark\) \{[\s\S]*:root\[data-theme='auto'\] \.a/,
  );
  assert.match(out, /@media \(max-width: 760px\) \{\n:root\[data-theme='dark'\] \.a/);
  // Layout is never copied; rules without a colour are left alone.
  assert.doesNotMatch(out, /padding/);
  assert.doesNotMatch(out, /\] \.d \{/);
  // A themed rule repeats "transparent" too, so the cascade between rules stays the same.
  assert.match(
    out,
    /\] \.e \{\n {2}background: transparent;\n {2}color: #[0-9a-f]{6};\n {2}box-shadow: none;/,
  );
  assert.match(out, /\] \.ring \{\n {2}box-shadow: 0 0 0 3px #/);
  // Kept parts keep their own colours, but still under the theme selector.
  assert.match(out, /:root\[data-theme='dark'\] \.sidebar \.x \{\n {2}color: #fff;\n\}/);
  assert.doesNotMatch(out, /keyframes|rotate/);
});

test('the app stylesheet parses and yields both themes', async () => {
  const css = await fs.readFile('src/style.css', 'utf8'),
    tree = parseCss(css),
    out = themeCss(css);
  assert.ok(tree.length > 200);
  assert.ok(out.includes(`:root[data-theme='dark'] body {`));
  assert.ok(out.includes(`:root[data-theme='sun'] body {`));
  assert.equal((out.match(/\{/g) || []).length, (out.match(/\}/g) || []).length);
});
