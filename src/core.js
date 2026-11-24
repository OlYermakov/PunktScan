// Exact decimal handling: coordinates never pass through binary floating point for export.
export function coordinate(raw, optional = false) {
  let s = String(raw ?? '')
    .trim()
    .replace(/\u2212/g, '-')
    // "+ 100.772": a sign set apart from the number.
    .replace(/^([+-])\s+(?=\d)/, '$1');
  if (!s)
    return optional
      ? { ok: true, empty: true, value: '', mm: null }
      : { ok: false, error: 'required' };
  if (/\s/.test(s)) {
    if (!/^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,4})?$/.test(s))
      return { ok: false, error: 'number' };
    s = s.replace(/\s/g, '');
  }
  if (s.includes('.') && s.includes(',')) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    const [whole, fraction, ...rest] = s.split(decimal);
    const re = new RegExp('^[+-]?\\d{1,3}(?:\\' + group + '\\d{3})+$');
    if (rest.length || !re.test(whole)) return { ok: false, error: 'number' };
    s = whole.split(group).join('') + '.' + fraction;
  } else s = s.replace(',', '.');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(s)) return { ok: false, error: 'number' };
  const [whole, frac = ''] = s.split('.');
  // Up to 4 decimals (0.1 mm). Values with 4 decimals are exported in GSI's 0.1 mm unit.
  if (frac.length > 4) return { ok: false, error: 'precision' };
  const fine = frac.length === 4;
  const negative = whole.startsWith('-');
  // Exact integers: tenths of a millimetre always, millimetres for values with up to 3 decimals.
  let tenths = BigInt(whole.replace(/^[+-]/, '')) * 10000n + BigInt(frac.padEnd(4, '0'));
  // GSI-16 holds 16 digits in the unit the file uses.
  if ((fine ? tenths : tenths / 10n) > 9999999999999999n) return { ok: false, error: 'range' };
  if (negative) tenths = -tenths;
  const abs = tenths < 0n ? -tenths : tenths,
    places = fine ? 4 : 3;
  return {
    ok: true,
    tenths,
    mm: fine ? null : tenths / 10n,
    fine,
    value:
      (tenths < 0n ? '-' : '') +
      abs / 10000n +
      '.' +
      String(abs % 10000n)
        .padStart(4, '0')
        .slice(0, places),
    short: frac.length < 3,
  };
}

export function pointName(raw) {
  const name = String(raw ?? '').replace(/\s/g, '');
  if (!name) return { ok: false, error: 'nameRequired', name };
  if (name.length > 16) return { ok: false, error: 'nameLength', name };
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, error: 'nameChars', name };
  return { ok: true, name, key: name.replace(/^0+(?=.)/, '').toLowerCase() };
}

export function validate(rows) {
  const names = new Map();
  const values = rows.map((row) => {
    const name = pointName(row.name),
      e = coordinate(row.e),
      n = coordinate(row.n),
      h = coordinate(row.h, true);
    const issues = [];
    if (!name.ok) issues.push({ field: 'name', code: name.error });
    if (!e.ok) issues.push({ field: 'e', code: e.error });
    if (!n.ok) issues.push({ field: 'n', code: n.error });
    if (!h.ok) issues.push({ field: 'h', code: h.error });
    if (name.ok) names.set(name.key, (names.get(name.key) || 0) + 1);
    return { row, name, e, n, h, issues };
  });
  for (const v of values)
    if (v.name.ok && names.get(v.name.key) > 1) v.issues.push({ field: 'name', code: 'duplicate' });
  return values;
}

export function gsi(rows) {
  if (!rows.length) throw new Error('empty');
  const values = validate(rows);
  if (values.some((v) => v.issues.length)) throw new Error('invalid');
  if (rows.some((r) => !r.verified)) throw new Error('unverified');
  // One unit for the whole file: 0.1 mm (GSI unit code 6) as soon as any value has 4 decimals,
  // otherwise millimetres (code 0). Nothing is rounded either way.
  const fine = values.some((v) => [v.e, v.n, v.h].some((c) => c.fine));
  return values
    .map((v, i) => {
      const words = [
        `11${String((i + 1) % 10000).padStart(4, '0')}+${v.name.name.padStart(16, '0')}`,
      ];
      for (const [wi, c] of [
        ['81', v.e],
        ['82', v.n],
        ['83', v.h],
      ])
        if (!c.empty) {
          const n = fine ? c.tenths : c.tenths / 10n,
            abs = n < 0n ? -n : n;
          words.push(
            `${wi}..0${fine ? '6' : '0'}${n < 0n ? '-' : '+'}${String(abs).padStart(16, '0')}`,
          );
        }
      return '*' + words.join(' ') + ' \r\n';
    })
    .join('');
}

export function csv(rows) {
  const values = validate(rows);
  if (!rows.length || values.some((v) => v.issues.length) || rows.some((r) => !r.verified))
    throw new Error('invalid');
  const cell = (s) => '"' + String(s).replaceAll('"', '""') + '"';
  // Reject spreadsheet formula triggers through pointName validation; neutralize leading minus IDs.
  return (
    '\ufeff' +
    [
      ['Punkt', 'Rechtswert', 'Hochwert', 'Hoehe'],
      ...values.map((v) => [
        (/^[=+\-@]/.test(v.name.name) ? "'" : '') + v.name.name,
        v.e.value.replace('.', ','),
        v.n.value.replace('.', ','),
        v.h.value.replace('.', ','),
      ]),
    ]
      .map((r) => r.map(cell).join(';'))
      .join('\r\n') +
    '\r\n'
  );
}

export function parseText(text, order = 'en') {
  const result = [],
    skipped = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i].trim();
    if (!original) continue;
    if (
      /rechtswert|hochwert|easting|northing|koordinaten|punktnummer|absteckpunkt|^punkt[;\t ]|^name[;\t ]/i.test(
        original,
      )
    )
      continue;
    let name,
      e,
      n,
      h = '';
    if (/[;\t]/.test(original)) {
      const cols = original
        .split(/[;\t]/)
        .map((v) => v.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
      if (cols.length >= 3 && cols.length <= 4) [name, e, n, h = ''] = cols;
    }
    if (name === undefined) {
      const clean = original.replace(/[|¦]/g, ' ').trim();
      const tokens = clean.split(/\s+/);
      let start = tokens.findIndex(
        (v, j) => j > 0 && /^[+-]?[0-9OolISB][0-9OolISB.,]*[.,][0-9OolISB]+$/.test(v),
      );
      if (start < 0 && tokens.length >= 3) {
        // Integer coordinates are supported; a split alphanumeric identifier consumes two tokens.
        start =
          /^[A-Za-z]+$/.test(tokens[0]) && /^\d+$/.test(tokens[1]) && tokens.length >= 4 ? 2 : 1;
        if (!tokens.slice(start).every((v) => /^[+-]?\d+$/.test(v))) start = -1;
      }
      if (start > 0) {
        name = tokens.slice(0, start).join('');
        [e = '', n = '', h = ''] = tokens.slice(start);
        if (tokens.length - start > 3) {
          skipped.push({ line: i + 1, text: original });
          continue;
        }
      }
    }
    if (name !== undefined)
      result.push({
        name,
        e: order === 'ne' ? n : e,
        n: order === 'ne' ? e : n,
        h,
        raw: original,
        line: i + 1,
      });
    else skipped.push({ line: i + 1, text: original });
  }
  return { rows: result, skipped };
}

export function flattenLines(data) {
  return (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
}

export function parseOCR(data, order = 'en') {
  const lines = flattenLines(data);
  const parsed = parseText(data.text || '', order);
  for (const r of parsed.rows) {
    const compact = (s) => s.replace(/[\s|¦]/g, '');
    const l = lines.find((l) => compact(l.text || '') === compact(r.raw));
    r.bbox = l?.bbox || null;
    const words = l?.words || [];
    r.confidence = words.length
      ? Math.min(...words.map((w) => w.confidence ?? 0))
      : (data.confidence ?? 0);
  }
  return parsed;
}

export function detectOrder(text) {
  for (const line of String(text).split('\n')) {
    const e = line.search(/rechtswert|easting|\beast\b/i),
      n = line.search(/hochwert|northing|\bnorth\b/i);
    if (e >= 0 && n >= 0) return e < n ? 'en' : 'ne';
  }
  return null;
}

export function isTableHeader(cells) {
  const values = cells.map((value) => String(value ?? '').trim());
  const label = (values[0] || '').replace(/\s/g, '');
  // Table titles ("Koordinaten Absteckpunkte - Bstg. 2") may contain numbers but no coordinates.
  if (/^koordinat/i.test(label) && !values.slice(1).some((v) => /\d{5}/.test(v))) return true;
  // A point named "Punkt" with numeric coordinates is still a data row. A stray digit read from a
  // grid line ("Position Y 1") does not make the headings a point.
  if (values.slice(1).some((value) => /\d{3}/.test(value))) return false;
  return (
    Boolean(detectOrder(values.join(' '))) ||
    /^(?:koordinat|absteckpunkt)/i.test(label) ||
    /^(?:punkt(?:nr\.?|nummer)?|name|point(?:no\.?|number)?)$/i.test(label)
  );
}

export function safeFilename(name, ext) {
  return (
    (String(name)
      .trim()
      // eslint-disable-next-line no-control-regex -- strip control characters from filenames
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 100) || 'PunktScan') +
    '.' +
    ext
  );
}

export function chooseReading(candidates) {
  const normalized = candidates.map((c) => ({
    ...c,
    text: c.text.trim().replace(/\s+/g, ' '),
    parsed: coordinate(c.text),
  }));
  const complete = normalized.filter((c) => c.parsed.ok && !c.parsed.short);
  const pool = complete.length ? complete : normalized;
  const best = [...pool].sort((a, b) => b.confidence - a.confidence)[0];
  return {
    ...best,
    disputed:
      new Set(normalized.filter((c) => c.text).map((c) => c.text.replace(',', '.'))).size > 1,
  };
}

// Project file limits, shared by the UI and the importer.
export const PROJECT_VERSION = 1;
export const MAX_SOURCES = 20;
export const MAX_ROWS = 10000;
export const MAX_IMAGE_SIDE = 2400;
// A 2400×2400 PNG is at most ~23 MB raw; base64 adds a third.
const MAX_IMAGE_CHARS = 32 * 1024 * 1024;
const MAX_FIELD_CHARS = 200;

// Upgrades older project files step by step: migrations[n] turns version n into n + 1.
const migrations = {};

export function checkProject(input) {
  let p = input;
  while (p && p.format === 'PunktScan' && migrations[p.version]) p = migrations[p.version](p);
  if (
    !p ||
    p.format !== 'PunktScan' ||
    p.version !== PROJECT_VERSION ||
    !Array.isArray(p.rows) ||
    !Array.isArray(p.sources) ||
    p.rows.length > MAX_ROWS ||
    p.sources.length > MAX_SOURCES
  )
    throw new Error('project');
  const sourceIds = new Set(p.sources.map((s) => s.id));
  if (sourceIds.size !== p.sources.length) throw new Error('project');
  if (
    p.sources.some(
      (s) =>
        typeof s.id !== 'string' ||
        typeof s.name !== 'string' ||
        typeof s.image !== 'string' ||
        s.image.length > MAX_IMAGE_CHARS ||
        s.name.length > 500 ||
        !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s.image) ||
        !Number.isInteger(s.width) ||
        !Number.isInteger(s.height) ||
        s.width < 1 ||
        s.height < 1 ||
        s.width > MAX_IMAGE_SIDE ||
        s.height > MAX_IMAGE_SIDE ||
        (s.processed != null &&
          (typeof s.processed !== 'string' || s.processed.length > MAX_IMAGE_CHARS)),
    )
  )
    throw new Error('project');
  if (
    p.rows.some(
      (r) =>
        !r ||
        !['name', 'e', 'n', 'h'].every(
          (k) => typeof r[k] === 'string' && r[k].length <= MAX_FIELD_CHARS,
        ) ||
        (r.sourceId && !sourceIds.has(r.sourceId)),
    )
  )
    throw new Error('project');
  // Imported review flags are deliberately reset: imported data must be checked locally.
  return {
    ...p,
    name: String(p.name || 'PunktScan').slice(0, 100),
    rows: p.rows.map((r) => ({ ...r, verified: false })),
  };
}

// E/N order from the numbers themselves, for German Gauss–Krüger and UTM coordinates: a Rechtswert
// (Easting) starts with its zone (2–4 in GK; 32/33 in UTM with zone) or has 6 digits (UTM), a
// Hochwert (Northing) has 7 digits starting with 5 or 6. `rows` hold the photo's first coordinate
// column in `e` and the second in `n`. Returns 'en', 'ne' or null when the numbers do not tell.
export function orderFromValues(rows) {
  const kind = (v) => {
    const whole = String(v ?? '')
      .replace(/[^\d.,]/g, '')
      .split(/[.,]/)[0];
    if (/^[56]\d{6}$/.test(whole)) return 'N';
    if (/^[234]\d{6}$/.test(whole) || /^3[23]\d{6}$/.test(whole) || /^\d{6}$/.test(whole))
      return 'E';
    return null;
  };
  let en = 0,
    ne = 0;
  for (const r of rows) {
    const a = kind(r.e),
      b = kind(r.n);
    if (a === 'E' && b === 'N') en++;
    if (a === 'N' && b === 'E') ne++;
  }
  const decided = en + ne;
  if (decided < 2 || decided < rows.length * 0.5) return null;
  if (en >= decided * 0.8) return 'en';
  if (ne >= decided * 0.8) return 'ne';
  return null;
}

// Plausibility: a value can have the right format and still be misread by one digit. Geometry and
// the naming pattern catch many of those. Returns, per row, advisory findings for the review:
//   far       the point lies far away from all other points (one axis probably misread),
//   magnitude E and N differ by more than a hundred times (a height in a coordinate column),
//   heightLikeCoordinate  the height is as large as a coordinate,
//   columnShape / nameShape  the value does not have the shape most of its column has,
//   height    the height differs strongly from the other heights,
//   sequence  the name breaks a numbered series (F-1.2, F-13, F-1.4),
//   gap       a numbered series skips a number here: a table row may have been missed.
// Nothing here blocks the export.
const median = (list) => {
  const s = [...list].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const SERIES = /^(.*?)(\d+)(\D*)$/;

export function plausibility(values) {
  const found = new Map(values.map((v) => [v.row, []]));
  const add = (v, item) => found.get(v.row).push(item);

  // Position: far from the centre of the points and far from its nearest neighbour, so a
  // second group of points (another part of the site) is not flagged.
  const pos = values
    .filter((v) => v.e.ok && v.n.ok && !v.e.empty && !v.n.empty)
    .map((v) => ({ v, e: Number(v.e.value), n: Number(v.n.value) }));
  if (pos.length >= 4) {
    const me = median(pos.map((p) => p.e)),
      mn = median(pos.map((p) => p.n)),
      centre = pos.map((p) => Math.hypot(p.e - me, p.n - mn)),
      spread = Math.max(median(centre), 1);
    pos.forEach((p, i) => {
      if (centre[i] <= Math.max(8, 5 * spread)) return;
      let nearest = Infinity;
      for (const q of pos)
        if (q !== p) nearest = Math.min(nearest, Math.hypot(q.e - p.e, q.n - p.n));
      if (nearest <= Math.max(8, 3 * spread)) return;
      const axis = Math.abs(p.e - me) >= Math.abs(p.n - mn) ? 'e' : 'n';
      add(p.v, { field: axis, code: 'far', distance: nearest });
    });
  }

  // Magnitude: Rechtswert and Hochwert of one point have the same order of magnitude in every
  // usual system. On Gauss-Krüger or UTM scale, a value a hundred times smaller than its partner
  // is most likely another number in the wrong column, such as a height.
  // The value to look at is the one unlike its own column (a lost decimal point makes N a
  // thousand times too large; then E is fine).
  const typical = (k) => {
    const list = values
      .filter((v) => v[k].ok && !v[k].empty)
      .map((v) => Math.abs(Number(v[k].value)));
    return list.length ? median(list) : null;
  };
  const typicalE = typical('e'),
    typicalN = typical('n'),
    offBy = (x, t) => (t ? Math.abs(Math.log10((x || 1e-9) / t)) : 0);
  // A whole column on another scale (a lost column: heights where Rechtswert belongs) is not a
  // column of coordinates; every value in it is marked.
  const lostColumn =
    typicalE !== null && typicalN !== null && Math.max(typicalE, typicalN) >= 100000
      ? Math.min(typicalE, typicalN) * 100 < Math.max(typicalE, typicalN)
        ? typicalE < typicalN
          ? 'e'
          : 'n'
        : null
      : null;
  for (const v of values) {
    const e = v.e.ok && !v.e.empty ? Math.abs(Number(v.e.value)) : null,
      n = v.n.ok && !v.n.empty ? Math.abs(Number(v.n.value)) : null,
      h = v.h.ok && !v.h.empty ? Math.abs(Number(v.h.value)) : null;
    // Only on Gauss-Krüger or UTM scale: near the origin of a local grid, E 900 / N 2 is fine.
    if (
      e !== null &&
      n !== null &&
      Math.max(e, n) >= 100000 &&
      Math.min(e, n) * 100 < Math.max(e, n)
    )
      add(v, {
        field:
          offBy(e, typicalE) === offBy(n, typicalN)
            ? e < n
              ? 'e'
              : 'n'
            : offBy(e, typicalE) > offBy(n, typicalN)
              ? 'e'
              : 'n',
        code: 'magnitude',
      });
    if (
      lostColumn &&
      v[lostColumn].ok &&
      !v[lostColumn].empty &&
      !found.get(v.row).some((f) => f.code === 'magnitude' && f.field === lostColumn)
    )
      add(v, { field: lostColumn, code: 'magnitude' });
    // A "height" as large as a Gauss-Krüger or UTM coordinate is a coordinate in the wrong column.
    if (h !== null && h >= 100000 && e !== null && n !== null && Math.min(e, n) >= 100000)
      add(v, { field: 'h', code: 'heightLikeCoordinate' });
  }

  // Column shape: when three quarters of a column share one shape, a value of another shape stands
  // out. Coordinates: the same number of digits and the same leading digits (to 10 km). Names:
  // the same pattern of letters, digits and separators (F-1.1, F-1.2 … but "3332").
  const dominant = (shapes) => {
    const counts = new Map();
    for (const sh of shapes) if (sh) counts.set(sh, (counts.get(sh) ?? 0) + 1);
    const [best] = [...counts].sort((a, b) => b[1] - a[1]);
    const total = shapes.filter(Boolean).length;
    return best && best[1] >= 4 && best[1] >= total * 0.75 ? best[0] : null;
  };
  const coordShape = (c) => {
    if (!c.ok || c.empty) return null;
    const digits = String(c.value).replace(/^-/, '').split('.')[0];
    return digits.length >= 6 ? digits.length + ':' + digits.slice(0, digits.length - 4) : null;
  };
  const nameShape = (v) =>
    v.name.ok ? v.name.name.replace(/[A-Za-z]+/g, 'A').replace(/\d+/g, '9') : null;
  for (const k of ['e', 'n']) {
    const shapes = values.map((v) => coordShape(v[k])),
      main = dominant(shapes);
    if (main)
      values.forEach((v, i) => {
        if (shapes[i] && shapes[i] !== main) add(v, { field: k, code: 'columnShape' });
      });
  }
  {
    const shapes = values.map(nameShape),
      main = dominant(shapes);
    if (main)
      values.forEach((v, i) => {
        if (shapes[i] && shapes[i] !== main) add(v, { field: 'name', code: 'nameShape' });
      });
  }

  // Height: far from the median height, measured against the usual spread of the heights.
  const hs = values.filter((v) => v.h.ok && !v.h.empty).map((v) => ({ v, h: Number(v.h.value) }));
  if (hs.length >= 4) {
    const mh = median(hs.map((x) => x.h)),
      mad = median(hs.map((x) => Math.abs(x.h - mh)));
    for (const x of hs) {
      const off = Math.abs(x.h - mh);
      if (off > Math.max(5, 8 * mad)) add(x.v, { field: 'h', code: 'height', difference: off });
    }
  }

  // Names: only when neighbours mostly count up by one within the same pattern.
  const parts = values.map((v) => {
    const m = v.name.ok && v.name.name.match(SERIES);
    return m
      ? {
          key: m[1] + '\u0000' + m[3],
          prefix: m[1],
          suffix: m[3],
          num: Number(m[2]),
          width: m[2].length,
        }
      : null;
  });
  const pairs = [];
  for (let i = 1; i < parts.length; i++)
    if (parts[i - 1] && parts[i] && parts[i - 1].key === parts[i].key)
      pairs.push(parts[i].num - parts[i - 1].num);
  // A misread name breaks two neighbouring steps, so half of the steps counting by one is enough.
  const ones = pairs.filter((d) => d === 1).length;
  if (ones < 2 || ones < pairs.length * 0.5) return found;
  const label = (p, num) => p.prefix + String(num).padStart(p.width, '0') + p.suffix;
  const same = (a, b) => a && b && a.key === b.key;
  const broken = new Set();
  parts.forEach((p, i) => {
    const a = parts[i - 1],
      b = parts[i + 1];
    let expected = null;
    // Between two points of a series that are two apart: this one should be the number between.
    if (same(a, b) && b.num - a.num === 2 && !(same(p, a) && p.num === a.num + 1))
      expected = label(a, a.num + 1);
    // At the start or the end of a series only a wrong number in the same pattern is flagged.
    const b2 = parts[i + 2],
      a2 = parts[i - 2];
    if (!a && same(b, b2) && same(p, b) && b2.num - b.num === 1 && p.num !== b.num - 1 && b.num > 0)
      expected = label(b, b.num - 1);
    if (!b && same(a, a2) && same(p, a) && a.num - a2.num === 1 && p.num !== a.num + 1)
      expected = label(a, a.num + 1);
    if (expected && expected.toLowerCase() !== values[i].name.name.toLowerCase()) {
      broken.add(i);
      add(values[i], { field: 'name', code: 'sequence', expected });
    }
  });
  parts.forEach((p, i) => {
    const a = parts[i - 1];
    if (!same(a, p) || broken.has(i) || broken.has(i - 1)) return;
    const step = p.num - a.num;
    if (step < 2 || step > 4) return;
    const missing = [];
    for (let k = a.num + 1; k < p.num; k++) missing.push(label(a, k));
    add(values[i], { field: 'name', code: 'gap', missing });
  });
  return found;
}
