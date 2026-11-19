import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validQuad,
  fullQuad,
  rectify,
  findTable,
  originalRegion,
  cellRegion,
  clearBorders,
  removeLines,
  hasBox,
} from '../src/imaging.js';
test('crossed or degenerate crop frames are rejected', () => {
  assert.ok(validQuad(fullQuad()));
  assert.equal(
    validQuad([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]),
    false,
  );
  assert.equal(
    validQuad([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]),
    false,
  );
});
test('blank images do not produce fake table boundaries', () => {
  assert.equal(findTable(new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100), null);
});
test('rectification remains bounded and preserves white pixels', () => {
  const p = new Uint8ClampedArray(100 * 80 * 4).fill(255),
    r = rectify(p, 100, 80, fullQuad(), false);
  assert.ok(r.width * r.height <= 4000000);
  assert.ok(r.data.every((v) => v === 255));
});
test('review crop maps to the original image and includes the source row', () => {
  const r = originalRegion(fullQuad(), { y0: 40, y1: 60 }, 100, 100, 100, 100);
  assert.equal(r.x, 0);
  assert.equal(r.w, 100);
  assert.ok(r.y < 40);
  assert.ok(r.y + r.h > 60);
});
test('a slightly skewed convex frame is accepted', () => {
  const q = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.12 },
    { x: 0.88, y: 0.9 },
    { x: 0.12, y: 0.88 },
  ];
  assert.ok(validQuad(q));
});
test('a cell crop stays inside its row crop and is narrower', () => {
  const q = fullQuad(),
    row = originalRegion(q, { y0: 40, y1: 60 }, 200, 100, 400, 200),
    cell = cellRegion(q, { x0: 50, y0: 40, x1: 100, y1: 60 }, 200, 100, 400, 200);
  assert.ok(cell.w < row.w / 2);
  assert.ok(cell.x >= row.x && cell.x + cell.w <= row.x + row.w);
  assert.ok(cell.y >= row.y && cell.y + cell.h <= row.y + row.h);
  assert.ok(Math.abs(cell.x - 92) < 2, 'cell maps to x≈100 minus margin, got ' + cell.x);
});
test('box lines around a value are cleared, the digits inside are kept', () => {
  const w = 60,
    h = 20,
    p = new Uint8ClampedArray(w * h * 4).fill(255);
  const ink = (x, y) => p.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  for (let x = 0; x < w; x++) (ink(x, 1), ink(x, h - 2)); // box top and bottom
  for (let y = 0; y < h; y++) (ink(2, y), ink(w - 3, y)); // box left and right
  for (let y = 6; y < 14; y++) ink(30, y); // a digit stroke in the middle
  clearBorders(p, w, h, { boxed: { margin: 10 } });
  const at = (x, y) => p[(y * w + x) * 4];
  assert.equal(at(10, 1), 255);
  assert.equal(at(2, 10), 255);
  assert.equal(at(w - 3, 10), 255);
  assert.equal(at(30, 10), 0, 'digit kept');
});
test('lines and value boxes are erased for the word pass, glyphs stay', () => {
  const w = 200,
    h = 100,
    p = new Uint8ClampedArray(w * h * 4).fill(255);
  const ink = (x, y) => p.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  for (let x = 0; x < w; x++) ink(x, 50); // table line
  for (let x = 20; x < 120; x++) (ink(x, 10), ink(x, 40)); // a value box
  for (let y = 10; y <= 40; y++) (ink(20, y), ink(119, y));
  for (let y = 20; y < 30; y++) ink(60, y); // a digit inside the box
  removeLines(p, w, h);
  const at = (x, y) => p[(y * w + x) * 4];
  assert.equal(at(100, 50), 255, 'table line erased');
  assert.equal(at(20, 25), 255, 'box erased');
  assert.equal(at(60, 25), 0, 'digit kept');
});
test('values drawn inside their own box are told apart from plain values', () => {
  const w = 300,
    h = 80,
    p = new Uint8ClampedArray(w * h * 4).fill(255);
  const ink = (x, y) => p.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  for (let y = 20; y < 60; y++) for (let x = 60; x < 140; x += 8) ink(x, y); // "digits"
  const word = { x0: 58, y0: 25, x1: 142, y1: 55 };
  assert.equal(hasBox(p, w, h, word, 12), false);
  for (let y = 15; y < 65; y++) (ink(50, y), ink(150, y));
  assert.equal(hasBox(p, w, h, word, 12), true);
});
