import test from 'node:test';
import assert from 'node:assert/strict';
import { niceStep, fitView, zoomAt } from '../src/map.js';

test('grid and scale bar use round steps of 1, 2 or 5 × 10ⁿ metres', () => {
  assert.equal(niceStep(0.8), 1);
  assert.equal(niceStep(1.7), 2);
  assert.equal(niceStep(4), 5);
  assert.equal(niceStep(8), 10);
  assert.equal(niceStep(0.013), 0.01);
  assert.equal(niceStep(230), 200);
});

const pts = [
  { x: 3415030.21, y: 5545557.311 },
  { x: 3415029.444, y: 5545557.784 },
  { x: 3415026.369, y: 5545553.55 },
];

test('the first view shows every point inside the drawing', () => {
  const v = fitView(pts);
  for (const p of pts) {
    const X = 400 + (p.x - v.cx) * v.f,
      Y = 240 - (p.y - v.cy) * v.f;
    assert.ok(X > 0 && X < 800 && Y > 0 && Y < 480, `${X} ${Y}`);
  }
});

test('zooming keeps the place under the pointer where it is, within limits', () => {
  const fit = fitView(pts),
    X = 600,
    Y = 100;
  const world = (v) => [v.cx + (X - 400) / v.f, v.cy - (Y - 240) / v.f];
  const zoomed = zoomAt(fit, X, Y, 3, fit);
  assert.equal(zoomed.f, fit.f * 3);
  world(zoomed).forEach((w, i) => assert.ok(Math.abs(w - world(fit)[i]) < 1e-6));
  // Out no further than a quarter of the first view, in no further than 4000 units per metre.
  assert.equal(zoomAt(fit, X, Y, 1e-6, fit).f, fit.f / 4);
  assert.equal(zoomAt(fit, X, Y, 1e9, fit).f, 4000);
});
