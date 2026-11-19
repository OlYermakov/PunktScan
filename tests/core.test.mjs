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
  PROJECT_VERSION,
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
    '12.1234',
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
    { text: '5600599.2776', confidence: 56 },
    { text: '5600599276', confidence: 0 },
  ]);
  assert.equal(broken.text, '5600599.2776');
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
