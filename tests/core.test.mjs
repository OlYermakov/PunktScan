import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinate,
  pointName,
  gsi,
  csv,
  parseText,
  detectOrder,
  isTableHeader,
  checkProject,
  safeFilename,
  chooseReading,
  orderFromValues,
  PROJECT_VERSION,
  plausibility,
  validate,
  MAX_SOURCES,
} from '../src/core.js';
const row = (name = 'Af201', e = '3500030.210', n = '5600557.311', h = '') => ({
  id: name,
  name,
  e,
  n,
  h,
  verified: true,
});
test('decimal normalization preserves exact millimetres and signs', () => {
  for (const input of [
    '3500030.210',
    '3500030,210',
    '3.500.030,210',
    '3,500,030.210',
    '3 500 030,210',
    '3\u00a0500\u00a0030,210',
  ])
    assert.equal(coordinate(input).mm, 3500030210n);
  assert.equal(coordinate('-0,001').mm, -1n);
  assert.equal(coordinate('-0').value, '0.000');
  assert.equal(coordinate('0').value, '0.000');
  assert.equal(coordinate('9999999999999.999').mm, 9999999999999999n);
});
test('ambiguous and corrupt coordinates do not get silently repaired', () => {
  for (const input of [
    '3.41.5030,210',
    '3500O30.210',
    '3e6',
    'Infinity',
    '12.12345',
    '12,345,678',
    '1 2.000',
    '10000000000000',
  ])
    assert.equal(coordinate(input).ok, false, input);
  assert.equal(coordinate('').ok, false);
  assert.equal(coordinate('', true).empty, true);
});
test('GSI-16 layout, E/N mapping and omitted vs explicit zero height', () => {
  const text = gsi([row(), row('B', '-12.345', '0', '0')]),
    lines = text.split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    '*110001+00000000000Af201 81..00+0000003500030210 82..00+0000005600557311 ',
  );
  assert.equal(lines[0].includes('83'), false);
  assert.ok(lines[1].includes('81..00-0000000000012345'));
  assert.ok(lines[1].includes('83..00+0000000000000000'));
  for (const line of lines.filter(Boolean)) {
    assert.equal(line[0], '*');
    for (let i = 1; i < line.length; i += 24) {
      assert.equal(line.slice(i, i + 24).length, 24);
      assert.equal(line[i + 23], ' ');
    }
  }
});
test('export blocks unreviewed, invalid, empty and duplicate points', () => {
  assert.throws(() => gsi([]));
  assert.throws(() => gsi([{ ...row(), verified: false }]));
  assert.throws(() => gsi([row('A', '', '3')]));
  assert.throws(() => gsi([row('Af 201'), row('af201')]));
  assert.throws(() => gsi([row('0012'), row('12')]));
  assert.throws(() => csv([{ ...row(), verified: false }]));
});
test('names preserve alphanumerics and block unsafe or overlong values', () => {
  assert.equal(pointName(' Aufs 201 ').name, 'Aufs201');
  for (const n of ['', 'КП1', 'a'.repeat(17), '<img>', '=1+2'])
    assert.equal(pointName(n).ok, false);
});
test('text import preserves missing fields and chooses the configured column order', () => {
  assert.deepEqual(
    parseText('Af 201 3500030.210 5600557.311').rows.map((r) => [r.name, r.e, r.n]),
    [['Af201', '3500030.210', '5600557.311']],
  );
  assert.equal(parseText('A;12,123;44,456;', 'ne').rows[0].e, '44,456');
  assert.equal(parseText('A\t3 500 030,210\t5 600 557,311').rows[0].e, '3 500 030,210');
  assert.equal(parseText('A;12.123;').rows[0].n, '');
  assert.equal(parseText('unreadable text').skipped.length, 1);
  assert.equal(detectOrder('Absteckpunkt Hochwert Rechtswert'), 'ne');
  assert.equal(detectOrder('foo'), null);
});
test('CSV quotes names and uses semicolon/decimal comma', () => {
  const s = csv([row()]);
  assert.ok(s.startsWith('\ufeff'));
  assert.ok(s.includes('"3500030,210";"5600557,311";""'));
  assert.ok(csv([row('-A')]).includes('"\'-A"'));
});
test('project import clears review and rejects invalid source payloads', () => {
  const p = { format: 'PunktScan', version: 1, rows: [row()], sources: [] };
  assert.equal(checkProject(p).rows[0].verified, false);
  assert.throws(() => checkProject({ ...p, version: 2 }));
  assert.throws(() =>
    checkProject({
      ...p,
      sources: [
        {
          id: 'x',
          name: 'x',
          image: 'data:image/png;base64,aaa" onerror="foo',
          width: 100,
          height: 100,
        },
      ],
    }),
  );
  assert.throws(() => checkProject({ ...p, rows: [{ ...row(), sourceId: 'missing' }] }));
});
test('filenames are filesystem-safe', () => {
  assert.equal(safeFilename('A/B:C', 'GSI'), 'A_B_C.GSI');
});
test('Punkt Nr. headers are excluded without dropping numeric or incomplete point rows', () => {
  for (const name of ['Punkt Nr.', 'PunktNr.', 'Absteckpunkt Nr.', 'Point No.'])
    assert.equal(isTableHeader([name, 'Rechtswert', 'Hochwert']), true);
  assert.equal(isTableHeader(['Punkt', '12.000', '44.000']), false);
  assert.equal(isTableHeader(['Punkt001', '', '44.000']), false);
  assert.equal(isTableHeader(['Af201', '', '']), false);
  assert.equal(detectOrder('Punkt Nr. Hochwert Rechtswert'), 'ne');
});
test('multi-pass OCR selects a literal reading and flags disagreement without inventing digits', () => {
  const r = chooseReading([
    { text: '3500028971', confidence: 40 },
    { text: '3500028.971', confidence: 80 },
    { text: '34615028.971', confidence: 15 },
  ]);
  assert.equal(r.text, '3500028.971');
  assert.equal(r.disputed, true);
  const broken = chooseReading([
    { text: '5600599.27761', confidence: 56 },
    { text: '5600599276', confidence: 0 },
  ]);
  assert.equal(broken.text, '5600599.27761');
  assert.equal(coordinate(broken.text).ok, false);
});
test('all fourteen synthetic reference coordinates survive export and decode', () => {
  const input = [
    ['Af201', '3500030.210', '5600557.311'],
    ['Af202', '3500029.444', '5600557.784'],
    ['Af203', '3500029.736', '5600556.545'],
    ['Af204', '3500028.971', '5600557.018'],
    ['Af205', '3499960.105', '5600598.047'],
    ['Af206', '3499959.324', '5600598.495'],
    ['Af207', '3499959.772', '5600599.276'],
    ['Af208', '3499960.553', '5600598.828'],
    ['Aufs201', '3500029.264', '5600555.018'],
    ['Aufs202', '3500027.816', '5600555.906'],
    ['Aufs203', '3500027.817', '5600552.661'],
    ['Aufs204', '3500026.369', '5600553.550'],
    ['LS201', '3500028.982', '5600555.897'],
    ['LS202', '3500028.727', '5600556.055'],
  ];
  const result = gsi(input.map((p) => row(...p)))
    .trimEnd()
    .split('\r\n');
  assert.equal(result.length, 14);
  for (const [i, line] of result.entries()) {
    const [id, e, n] = line.slice(1).trim().split(' ');
    assert.equal(id.slice(7).replace(/^0+/, ''), input[i][0]);
    assert.equal(BigInt(e.slice(6)), coordinate(input[i][1]).mm);
    assert.equal(BigInt(n.slice(6)), coordinate(input[i][2]).mm);
  }
});
test('OCR letter/digit confusions are kept literally and blocked by validation', () => {
  const r = parseText('Af201 35OOO30.210 56005S7.3l1').rows[0];
  assert.equal(r.name, 'Af201');
  assert.equal(r.e, '35OOO30.210');
  assert.equal(r.n, '56005S7.3l1');
  assert.equal(coordinate(r.e).ok, false);
  assert.equal(coordinate(r.n).ok, false);
  assert.throws(() => gsi([{ ...row(), e: r.e }]), /invalid/);
});
test('GSI edge cases: 16-character names, negative height, block number wrap', () => {
  const name = 'A'.repeat(16),
    line = gsi([row(name, '1', '2', '-3.5')]);
  assert.ok(line.startsWith('*110001+' + name + ' '));
  assert.ok(line.includes('83..00-0000000000003500 '));
  assert.equal(pointName('A'.repeat(17)).ok, false);
  const many = Array.from({ length: 10001 }, (_, i) => row('P' + i, '1', '2'));
  const lines = gsi(many).trimEnd().split('\r\n');
  assert.equal(lines.length, 10001);
  assert.ok(lines[9998].startsWith('*119999+'));
  assert.ok(lines[9999].startsWith('*110000+'));
  assert.ok(lines[10000].startsWith('*110001+'));
});
test('integer and short-precision coordinates are padded exactly, never rounded', () => {
  assert.equal(coordinate('3500030').value, '3500030.000');
  assert.equal(coordinate('3500030').short, true);
  assert.equal(coordinate('3500030,2').mm, 3500030200n);
  assert.equal(coordinate('3500030.210').short, false);
  assert.equal(coordinate('−5.5').mm, -5500n);
});
test('project import enforces the same limits as the app', () => {
  const image = 'data:image/png;base64,AAAA';
  const src = (id) => ({ id, name: id, image, width: 10, height: 10 });
  const p = { format: 'PunktScan', version: PROJECT_VERSION, rows: [], sources: [] };
  const many = Array.from({ length: MAX_SOURCES }, (_, i) => src('s' + i));
  assert.equal(checkProject({ ...p, sources: many }).sources.length, MAX_SOURCES);
  assert.throws(() => checkProject({ ...p, sources: [...many, src('extra')] }));
  assert.throws(() => checkProject({ ...p, rows: [{ ...row(), e: '1'.repeat(201) }] }));
  assert.throws(() => checkProject({ ...p, sources: [{ ...src('a'), processed: 42 }] }));
  assert.throws(() => checkProject({ ...p, sources: [{ ...src('a'), width: 2401 }] }));
});
test('a table title with a building section number is not a point', () => {
  assert.equal(isTableHeader(['Koordinaten A', '1steckpunkt', '- Bstg. 2']), true);
  assert.equal(isTableHeader(['Koordinaten Dachfundament', 'Type F-4', 'Achse 4']), true);
  assert.equal(isTableHeader(['Koordinate1', '3500030.210', '5600557.311']), false);
});

test('four decimals are exported exactly in the GSI 0.1 mm unit, three decimals in mm', () => {
  assert.equal(coordinate('3423197.8558').value, '3423197.8558');
  assert.equal(coordinate('3423197.8558').tenths, 34231978558n);
  assert.equal(coordinate('3423296,6150').value, '3423296.6150', 'a trailing zero is kept');
  assert.equal(coordinate('3 423 197,8558').ok, true);
  assert.equal(coordinate('1.23456').error, 'precision');
  // Mixed file: every word switches to 0.1 mm; nothing is rounded.
  const lines = gsi([
    row('R-09-01', '3423197.8558', '5538496.9145', '101.25'),
    row('R-09-02', '3423203.055', '-5538498.482'),
  ]).split('\r\n');
  assert.equal(
    lines[0],
    '*110001+000000000R-09-01 81..06+0000034231978558 82..06+0000055384969145 83..06+0000000001012500 ',
  );
  assert.ok(lines[1].includes('81..06+0000034232030550'));
  assert.ok(lines[1].includes('82..06-0000055384984820'));
  // Files with at most 3 decimals keep the millimetre unit and are unchanged.
  assert.ok(gsi([row()]).includes('81..00+0000003500030210'));
  assert.ok(
    csv([row('A', '3423197.8558', '5538496.9145')]).includes('"3423197,8558";"5538496,9145"'),
  );
});

test('the E/N order is recognised from Gauss–Krüger and UTM numbers', () => {
  const rows = (pairs) => pairs.map(([e, n]) => ({ e, n }));
  // Headings said "Hoch, Rechts" but the first column holds Rechtswerte (zone 3).
  assert.equal(
    orderFromValues(
      rows([
        ['3445936.4909', '5545947.9795'],
        ['3445921.4632', '5545956.0815'],
      ]),
    ),
    'en',
  );
  assert.equal(
    orderFromValues(
      rows([
        ['5545947.979', '3445936.490'],
        ['5545956.081', '3445921.463'],
      ]),
    ),
    'ne',
  );
  assert.equal(
    orderFromValues(
      rows([
        ['32456789.12', '5545947.979'],
        ['32456790.10', '5545956.081'],
      ]),
    ),
    'en',
  );
  assert.equal(
    orderFromValues(
      rows([
        ['456789.120', '5545947.979'],
        ['456790.100', '5545956.081'],
      ]),
    ),
    'en',
  );
  // Local or unclear numbers: no decision.
  assert.equal(
    orderFromValues(
      rows([
        ['1000.000', '2000.000'],
        ['1010.000', '2010.000'],
      ]),
    ),
    null,
  );
  assert.equal(orderFromValues(rows([['3445936.490', '5545947.979']])), null);
});
test('a height written with a separated sign is read', () => {
  assert.equal(coordinate('+ 100.772').value, '100.772');
  assert.equal(coordinate('- 99.994').value, '-99.994');
});

// Builds validated rows from [name, e, n, h] tuples for the plausibility checks.
const plausible = (list) => {
  const values = validate(list.map(([name, e, n, h = ''], i) => ({ id: 'r' + i, name, e, n, h })));
  const found = plausibility(values);
  return values.map((v) => found.get(v.row));
};

test('plausibility: a point far from all others is flagged on the axis that moved', () => {
  const found = plausible([
    ['P1', '3423197.856', '5538496.915'],
    ['P2', '3423203.055', '5538498.482'],
    ['P3', '3423198.026', '5538496.339'],
    // One digit misread in N: 5538496 → 5539496, a kilometre away.
    ['P4', '3423198.600', '5539496.512'],
    ['P5', '3423203.231', '5538497.909'],
  ]);
  assert.deepEqual(
    found.map((f) => f.map((x) => x.code)),
    [[], [], [], ['far'], []],
  );
  assert.equal(found[3][0].field, 'n');
  assert.ok(found[3][0].distance > 990 && found[3][0].distance < 1010);
});

test('plausibility: a second group of points (another part of the site) is not flagged', () => {
  const found = plausible([
    ['A1', '1000.000', '2000.000'],
    ['A2', '1005.000', '2003.000'],
    ['A3', '1002.000', '2006.000'],
    ['B1', '1800.000', '2900.000'],
    ['B2', '1804.000', '2903.000'],
  ]);
  assert.ok(
    found.every((f) => !f.length),
    JSON.stringify(found),
  );
});

test('plausibility: few points or a spread-out line are left alone', () => {
  assert.ok(
    plausible([
      ['A', '1.000', '2.000'],
      ['B', '900.000', '2.000'],
      ['C', '3.000', '2.000'],
    ]).every((f) => !f.length),
  );
  const line = Array.from({ length: 12 }, (_, i) => [
    'L' + (i + 1),
    `${1000 + i * 50}.000`,
    '5000.000',
  ]);
  assert.ok(plausible(line).every((f) => !f.length));
});

test('plausibility: a height far from the others is flagged', () => {
  const found = plausible([
    ['1', '10.000', '10.000', '101.20'],
    ['2', '12.000', '10.000', '101.35'],
    ['3', '14.000', '10.000', '191.42'],
    ['4', '16.000', '10.000', '100.98'],
    ['5', '18.000', '10.000', '102.10'],
  ]);
  assert.deepEqual(found[2], [{ field: 'h', code: 'height', difference: found[2][0].difference }]);
  assert.ok(found[2][0].difference > 89);
  assert.ok([0, 1, 3, 4].every((i) => !found[i].length));
});

test('plausibility: a name that breaks a numbered series gets the expected name', () => {
  const rows = (names) => names.map((name, i) => [name, `${10 + i}.000`, '10.000']);
  let found = plausible(rows(['F-1.1', 'F-1.2', 'F-13', 'F-1.4', 'F-1.5']));
  // F-13 also has another shape than F-1.x; the series check names the expected name.
  assert.deepEqual(
    found[2].find((f) => f.code === 'sequence'),
    { field: 'name', code: 'sequence', expected: 'F-1.3' },
  );
  found = plausible(rows(['R-09-01', 'R-09-02', 'R-09-08', 'R-09-04', 'R-09-05']));
  assert.deepEqual(found[2], [{ field: 'name', code: 'sequence', expected: 'R-09-03' }]);
  assert.ok(
    [0, 1, 3, 4].every((i) => !found[i].length),
    JSON.stringify(found),
  );
  // At the ends of the series.
  found = plausible(rows(['Af207', 'Af202', 'Af203', 'Af204', 'Af205']));
  assert.deepEqual(found[0], [{ field: 'name', code: 'sequence', expected: 'Af201' }]);
  found = plausible(rows(['Af201', 'Af202', 'Af203', 'Af204', 'Af265']));
  assert.deepEqual(found[4], [{ field: 'name', code: 'sequence', expected: 'Af205' }]);
});

test('plausibility: a skipped number in a series points at a missed row', () => {
  const rows = (names) => names.map((name, i) => [name, `${10 + i}.000`, '10.000']);
  const found = plausible(rows(['P1', 'P2', 'P3', 'P5', 'P6', 'P7']));
  assert.deepEqual(found[3], [{ field: 'name', code: 'gap', missing: ['P4'] }]);
  assert.ok([0, 1, 2, 4, 5].every((i) => !found[i].length));
  // Series that do not count up by one (10, 20, 30 …) and mixed names are not checked.
  assert.ok(plausible(rows(['10', '20', '30', '40', '60'])).every((f) => !f.length));
  assert.ok(plausible(rows(['BP', 'A7', 'X', 'K12', 'M'])).every((f) => !f.length));
  // A large jump is a deliberate new range, not a missed row.
  assert.ok(plausible(rows(['P1', 'P2', 'P3', 'P4', 'P100', 'P101'])).every((f) => !f.length));
});

test('plausibility: a height in a coordinate column and a coordinate in the height column are flagged', () => {
  const found = plausible([
    ['SAP.152', '100.772', '5545947.980', ''],
    ['SAP.154', '3445921.463', '5545956.082', '101.175'],
    ['SAP.156', '3445920.975', '5545955.154', '5545955.154'],
    // A local site grid: small, but E and N of the same order.
    ['L1', '1012.350', '2034.100', '45.20'],
  ]);
  assert.deepEqual(found[0], [{ field: 'e', code: 'magnitude' }]);
  assert.deepEqual(found[1], []);
  assert.deepEqual(found[2], [{ field: 'h', code: 'heightLikeCoordinate' }]);
  assert.deepEqual(found[3], []);
});

test('plausibility: a value of another shape than its column stands out', () => {
  const rows = [
    ['F-1.1', '3439901.100', '5544901.100'],
    ['F-1.2', '3439902.200', '5544902.200'],
    ['F-1.3', '3439903.300', '5544903.300'],
    ['3332', '3439904.400', '5544904.400'],
    ['F-1.5', '3439905.500', '3439905.500'],
    ['F-1.6', '3439906.600', '5544906.600'],
  ];
  const found = plausible(rows);
  assert.ok(found[3].some((f) => f.field === 'name' && f.code === 'nameShape'));
  assert.ok(found[4].some((f) => f.field === 'n' && f.code === 'columnShape'));
  assert.ok([0, 1, 2, 5].every((i) => !found[i].some((f) => /Shape/.test(f.code))));
  // Mixed names (Af201 … Aufs201 …) have no clear majority: nothing is flagged.
  const mixed = plausible(
    ['Af201', 'Af202', 'Af203', 'Aufs201', 'Aufs202', 'Aufs203'].map((n, i) => [
      n,
      `3415030.${i}10`,
      `5545557.${i}11`,
    ]),
  );
  assert.ok(mixed.every((f) => !f.some((x) => /Shape/.test(x.code))));
});

test('plausibility: the magnitude check marks the value unlike its column, not just the smaller one', () => {
  const found = plausible([
    ['F-4.1', '3439841.100', '5544861422'.replace(/^/, '') + '.000'],
    ['F-4.2', '3439842.200', '5544862.200'],
    ['F-4.3', '3439843.300', '5544863.300'],
    ['F-4.4', '3439844.400', '5544864.400'],
  ]);
  assert.equal(found[0].find((f) => f.code === 'magnitude')?.field, 'n');
});
