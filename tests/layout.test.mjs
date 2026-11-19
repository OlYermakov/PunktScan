import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinateToken,
  tableFromWords,
  harmonize,
  shape,
  borrowSeparators,
} from '../src/layout.js';

const word = (text, x, y, w = 120, h = 30, confidence = 90) => ({
  text,
  confidence,
  box: { x0: x, y0: y, x1: x + w, y1: y + h },
});

test('coordinate tokens keep the numeric core and reject names', () => {
  assert.equal(coordinateToken('3423197.8558]'), '3423197.8558');
  assert.equal(coordinateToken('|5538496.9145'), '5538496.9145');
  assert.equal(coordinateToken('34231978558'), '34231978558');
  for (const name of ['205', 'Af', 'F-4.1', 'R-09-01', 'Bstg.', '2', '1.2.3456']) {
    assert.equal(coordinateToken(name), null, name);
  }
});

test('rows and columns come from word positions, without any grid lines', () => {
  const words = [
    word('Absteckpunkt', 0, 0, 200),
    word('Rechtswert', 300, 0),
    word('Hochwert', 600, 0),
    word('Af', 20, 60, 40),
    word('205', 70, 60, 60),
    word('3414960.105', 300, 60),
    word('5545598.047', 600, 60),
    word('Af', 20, 110, 40),
    word('206', 70, 110, 60),
    word('3414959.324]', 300, 110),
    word('5545598.495', 600, 110),
  ];
  const t = tableFromWords(words, 800);
  assert.equal(t.columns, 2);
  assert.equal(t.order, 'en');
  assert.deepEqual(
    t.rows.map((r) => [r.name, ...r.values]),
    [
      ['Af 205', '3414960.105', '5545598.047'],
      ['Af 206', '3414959.324', '5545598.495'],
    ],
  );
  assert.deepEqual(t.rows[0].nameBox, { x0: 20, y0: 60, x1: 130, y1: 90 });
});

test('a tilted page still pairs each name with its own coordinates', () => {
  // 4° tilt: every column is ~35 px lower than the one to its left, rows are 50 px apart.
  const tilt = Math.tan((4 * Math.PI) / 180);
  const at = (x, y) => y + tilt * x;
  const words = [];
  for (let i = 0; i < 6; i++) {
    const y = 100 + i * 50;
    words.push(word(`F-4.${i + 1}`, 20, at(20, y), 80));
    words.push(word(`343714${i}.823`, 400, at(400, y)));
    words.push(word(`554384${i}.910`, 800, at(800, y)));
  }
  const t = tableFromWords(words, 1000);
  assert.equal(t.rows.length, 6);
  t.rows.forEach((r, i) => {
    assert.equal(r.name, `F-4.${i + 1}`);
    assert.deepEqual(r.values, [`343714${i}.823`, `554384${i}.910`]);
  });
  assert.ok(Math.abs(t.slope - tilt) < 0.01);
});

test('titles and stray numbers do not become rows; a missing value stays empty', () => {
  const words = [
    word('Koordinaten', 0, 0, 300),
    word('Bstg.', 320, 0, 80),
    word('2', 410, 0, 20),
    word('R-09-01', 0, 60, 100),
    word('3423197.8558', 300, 60),
    word('5538496.9145', 600, 60),
    word('R-09-02', 0, 110, 100),
    word('5538498.4823', 600, 110),
    word('R-09-03', 0, 160, 100),
    word('3423198.0259', 300, 160),
    word('5538496.3391', 600, 160),
  ];
  const t = tableFromWords(words, 800);
  assert.deepEqual(
    t.rows.map((r) => [r.name, ...r.values]),
    [
      ['R-09-01', '3423197.8558', '5538496.9145'],
      ['R-09-02', '', '5538498.4823'],
      ['R-09-03', '3423198.0259', '5538496.3391'],
    ],
  );
  assert.equal(t.order, null);
});

test('a reading that breaks its column form is replaced by another real pass of the same cell', () => {
  const cell = (text, candidates = []) => ({ text, confidence: 80, disputed: false, candidates });
  const cells = [
    [cell('R-09-05'), cell('3423203.2308')],
    [
      cell('2-0906', [
        { text: '2-0906', confidence: 70 },
        { text: 'R-09-06', confidence: 60 },
      ]),
      cell('3423201.2915'),
    ],
    [cell('R-09-07'), cell('34232039362', [{ text: '3423203.9362', confidence: 50 }])],
    [cell('R-09-08'), cell('3423202.0362')],
    // No pass with the usual form: left as read (and flagged elsewhere), never invented.
    [cell('R-0909', [{ text: 'R-0909', confidence: 40 }]), cell('3423204.1125')],
  ];
  harmonize(cells);
  assert.equal(cells[1][0].text, 'R-09-06');
  assert.equal(cells[1][0].disputed, true);
  assert.equal(cells[2][1].text, '3423203.9362');
  assert.equal(cells[4][0].text, 'R-0909');
  assert.equal(shape('F-4.5'), 'A-9.9');
});

test('a number split at its decimal point by OCR is joined back', () => {
  const words = [
    word('R-09-01', 0, 60, 100),
    word('3423197', 300, 60, 100),
    word('.856', 405, 60, 50),
    word('5538496', 600, 60, 100),
    word('915', 712, 60, 45),
    word('R-09-02', 0, 110, 100),
    word('3423203.055', 300, 110, 155),
    word('5538498.482', 600, 110, 155),
  ];
  const t = tableFromWords(words, 800);
  assert.deepEqual(
    t.rows.map((r) => r.values),
    [
      ['3423197.856', '5538496915'],
      ['3423203.055', '5538498.482'],
    ],
  );
  assert.deepEqual(t.rows[0].boxes[0], { x0: 300, y0: 60, x1: 455, y1: 90 });
});

test('a lost decimal point is taken from another reading with exactly the same digits', () => {
  const rows = [
    { e: '3439845.992', n: '5544860327', h: '', disputed: [false, false, false, false] },
    { e: '3439843032', n: '5544854.552', h: '', disputed: [false, false, false, false] },
    { e: '3439841898', n: '5544852.324', h: '', disputed: [false, false, false, false] },
  ];
  const others = [
    { e: '3439845.992', n: '5544860.327' },
    { e: '3439843.032', n: '5544854.552' },
    { e: '3439841.988', n: '5544852.324' }, // different digits: not used
  ];
  assert.equal(borrowSeparators(rows, others), 2);
  assert.equal(rows[0].n, '5544860.327');
  assert.equal(rows[0].disputed[2], true);
  assert.equal(rows[1].e, '3439843.032');
  assert.equal(rows[2].e, '3439841898', 'never changes digits');
});
