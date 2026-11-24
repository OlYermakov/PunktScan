import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinateToken,
  tableFromWords,
  harmonize,
  shape,
  borrowSeparators,
  uncertainIndices,
  disagreement,
  pointFromColumn,
  combineReadings,
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

test('uncertain characters: low confidence and where other passes disagree', () => {
  // Tesseract unsure about the "3" (index 8).
  const chars = [99, 99, 99, 99, 99, 99, 99, 98, 40, 98, 98];
  assert.deepEqual(uncertainIndices('5544860.327', chars), [8]);
  // Another pass read "5544860.321": only the last digit differs.
  assert.deepEqual(uncertainIndices('5544860.327', null, [{ text: '5544860.321' }]), [10]);
  // A pass with one digit more ("…31" vs "…311"): the last two characters are marked.
  assert.deepEqual(uncertainIndices('5545557.31', null, [{ text: '5545557.311' }]), [8, 9]);
  // Names are stored without spaces; indices follow the stored form.
  assert.deepEqual(uncertainIndices('Af 205', [99, 99, 100, 50, 99, 99], [], true), [2]);
  assert.deepEqual(uncertainIndices('3414960.105', null, [{ text: '3414960.105' }]), []);
});

test('only close alternative readings count as disagreement; dots need much lower confidence', () => {
  assert.deepEqual(disagreement('3415029.264', [{ text: '3615025264' }, { text: '34150' }]), []);
  assert.deepEqual(disagreement('3415029.264', [{ text: '3415029.284' }]), [9]);
  const dot = [99, 99, 99, 99, 99, 99, 99, 60, 99, 99, 99];
  assert.deepEqual(uncertainIndices('5545557.784', dot), [], 'a dot at 60 is normal');
  dot[7] = 20;
  assert.deepEqual(uncertainIndices('5545557.784', dot), [7]);
});

test('differences are marked exactly, and a pass without the decimal point is ignored', () => {
  // Two separate differences: 4→6 and a lost point — only the 4 is marked.
  assert.deepEqual(disagreement('3415029.264', [{ text: '3615029264' }]), [1]);
  assert.deepEqual(disagreement('5545557.784', [{ text: '5545557784' }]), []);
  assert.deepEqual(disagreement('5545557.31', [{ text: '5545557.311' }]), [8, 9]);
  assert.deepEqual(disagreement('R-09-06', [{ text: 'R-0906' }], true), [4]);
});

test('a decimal point too small to read is put back where the column has it', () => {
  const rows = [
    ['ES101', '3415168520', '5545468.320'],
    ['ES102', '3415153.890', '5545481940'],
    ['ES103', '3415123.250', '5545507.660'],
    ['ES104', '3415084.959', '5545536.486'],
    // Different leading digits or digit count: not the column's number, left alone.
    ['ES105', '9915087708', '55455364910'],
  ].map(([name, e, n]) => ({
    name,
    e,
    n,
    h: '',
    disputed: [false, false, false, false],
    uncertainChars: [[], [], [], []],
  }));
  assert.equal(pointFromColumn(rows), 2);
  assert.equal(rows[0].e, '3415168.520');
  assert.equal(rows[1].n, '5545481.940');
  assert.deepEqual([rows[4].e, rows[4].n], ['9915087708', '55455364910']);
  // The value is marked: the point is the character to check.
  assert.equal(rows[0].disputed[1], true);
  assert.deepEqual(rows[0].uncertainChars[1], [7]);
  // Too few values with a point to know the format: nothing changes.
  const few = [{ e: '3415168520' }, { e: '3415153.890' }, { e: '3415123.250' }];
  assert.equal(pointFromColumn(few), 0);
});

// Rows as the grid reader makes them, for the second-reading tests.
const readRows = (list) =>
  list.map(([name, e, n, conf = [90, 90, 90, 90]]) => ({
    name,
    e,
    n,
    h: '',
    cellConfidence: [...conf],
    disputed: [false, true, true, false],
    uncertainChars: [[], [3], [3], []],
  }));
const table = [
  ['P1', '3423197.856', '5538496.915'],
  ['P2', '3423203.055', '5538498.482'],
  ['P3', '3423198.026', '5538496.339'],
  ['P4', '3423198.600', '5538496.512'],
];

test('second reading: the same valid value of its column shape confirms it', () => {
  const rows = readRows(table);
  const counts = combineReadings(
    rows,
    rows.map((r) => [r.name, r.e, r.n, null]),
  );
  assert.deepEqual(counts, { compared: 12, agreed: 12, replaced: 0 });
  for (const r of rows) {
    assert.deepEqual(r.disputed.slice(0, 3), [false, false, false]);
    assert.deepEqual(r.uncertainChars.slice(0, 3), [[], [], []]);
  }
});

test('second reading: agreement does not confirm an unsure reading or a value off its column', () => {
  const rows = readRows([
    ...table,
    // Tesseract unsure (35 %): agreement alone is not enough.
    ['P5', '3423199.111', '5538497.222', [90, 35, 90, 90]],
    // A height in the Rechtswert column: same reading, but not the column's shape.
    ['P6', '100.772', '5538497.333'],
  ]);
  combineReadings(
    rows,
    rows.map((r) => [r.name, r.e, r.n, null]),
  );
  assert.equal(rows[4].disputed[1], true);
  assert.equal(rows[5].disputed[1], true);
  assert.equal(rows[0].disputed[1], false);
});

test('second reading: a difference keeps the field marked, the valid reading wins', () => {
  const rows = readRows(table);
  rows[1].e = '3423203055'; // Tesseract lost the point
  rows[2].n = '5538496.339';
  const second = rows.map((r) => [r.name, r.e, r.n, null]);
  second[1][1] = '3423203.055';
  second[2][2] = '5538496.389'; // one digit differs
  second[3][0] = '－P4'; // a full-width dash from the cell border: cleaned to P4
  second[0][1] = null; // a cell that was not read
  second[0][2] = ''; // read as nothing
  const counts = combineReadings(rows, second);
  assert.equal(rows[1].e, '3423203.055');
  assert.equal(rows[1].disputed[1], true);
  assert.equal(rows[2].n, '5538496.389');
  assert.equal(rows[2].disputed[2], true);
  assert.deepEqual(rows[2].uncertainChars[2], [9]);
  assert.equal(rows[3].name, 'P4');
  assert.equal(rows[3].disputed[0], false);
  // Unread cells leave Tesseract's value and doubt as they were.
  assert.equal(rows[0].disputed[1], true);
  assert.equal(rows[0].disputed[2], true);
  assert.equal(counts.replaced, 2);
});

test('second reading: column shape keeps a good name, edge brackets are dropped', () => {
  const rows = ['DT201', 'DT202', 'DT203', 'DT204'].map((name, i) => ({
    name,
    e: `34127${96 + i}.346`,
    n: '5547121.629',
    h: '',
    cellConfidence: [80, 80, 80, 80],
  }));
  rows[0].e = '3412596.346';
  const r = combineReadings(rows, [
    ['6166', '[3412796.346', '5547121.629', null],
    ['DT202]', '3412797.346', '5547121.629', null],
    ['DT203', '3412798.346', '5547121.629', null],
    ['DT204', '3412799.346', '5547121.629', null],
  ]);
  // A moiré cell read as 6166 does not replace DT201, which fits DT2xx.
  assert.equal(rows[0].name, 'DT201');
  assert.equal(rows[0].disputed[0], true);
  // "[3412796.346" is a grid line plus a valid value: it replaces Tesseract's misread digit.
  assert.equal(rows[0].e, '3412796.346');
  assert.equal(rows[1].name, 'DT202');
  assert.equal(rows[1].second[0], 'DT202');
  assert.equal(r.replaced, 1);
});
