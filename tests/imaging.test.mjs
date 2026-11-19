import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validQuad,
  fullQuad,
  rectify,
  findTable,
  originalRegion,
  cellRegion,
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
