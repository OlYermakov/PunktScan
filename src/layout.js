// Table layout from OCR words, for tables whose grid lines cannot be found: no outer borders,
// a box around every value, a slightly tilted or cut-off page. Pure functions, no DOM.
//
// Input: words [{ text, box: { x0, y0, x1, y1 }, confidence }].
// Output: rows with a name and coordinate cells (each with its box), the coordinate columns
// and the E/N order if the headings were read.

const DIGITS = /\d/g;

// "3423197.8558", "3423197.8558]", "|5538496.9145", "34231978558" → the numeric core, or null.
export function coordinateToken(text) {
  const core = String(text)
    .trim()
    .replace(/^[^\d+-]+/, '')
    .replace(/[^\d]+$/, '');
  if (!/^[+-]?[\d.,' ]+$/.test(core)) return null;
  const digits = (core.match(DIGITS) || []).length;
  const separators = (core.match(/[.,]/g) || []).length;
  // Coordinates have at least 5 digits; names like "205", "F-4.1" or "R-09-01" do not qualify.
  if (digits < 5 || separators > 1) return null;
  if (!separators && digits < 6) return null;
  return core.replace(/\s/g, '');
}

const center = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const median = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const union = (boxes) => ({
  x0: Math.min(...boxes.map((b) => b.x0)),
  y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)),
  y1: Math.max(...boxes.map((b) => b.y1)),
});

// Groups x positions into columns: a new column starts after a gap wider than `gap`.
function clusterColumns(tokens, gap) {
  const sorted = [...tokens].sort((a, b) => a.cx - b.cx);
  const columns = [];
  for (const t of sorted) {
    const last = columns.at(-1);
    if (last && t.box.x0 - last.x1 < gap && t.cx - last.cx() < gap * 3) {
      last.tokens.push(t);
      last.x1 = Math.max(last.x1, t.box.x1);
    } else
      columns.push({
        tokens: [t],
        x1: t.box.x1,
        cx() {
          return median(this.tokens.map((k) => k.cx));
        },
      });
  }
  return columns;
}

// OCR sometimes splits one number at its separator ("3423197" + ".856"): glue numeric pieces
// that sit next to each other on the same line back together.
export function mergeNumberParts(words) {
  const numericPart = (t) => /^[\d.,]+$/.test(String(t).replace(/^[^\d.,]+|[^\d.,]+$/g, ''));
  const sorted = [...words].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  const used = new Set(),
    out = [];
  for (const w of sorted) {
    if (used.has(w)) continue;
    let cur = { ...w, box: { ...w.box } };
    for (;;) {
      const h = cur.box.y1 - cur.box.y0;
      // Next numeric piece on the same line, closer than about two characters. The joined box is
      // read again as a whole later, so a separator between the pieces is read, not assumed.
      const next = sorted.find(
        (o) =>
          !used.has(o) &&
          o !== w &&
          numericPart(cur.text) &&
          numericPart(o.text) &&
          o.box.x0 >= cur.box.x1 - h * 0.2 &&
          o.box.x0 - cur.box.x1 < h * 1.6 &&
          Math.abs((o.box.y0 + o.box.y1) / 2 - (cur.box.y0 + cur.box.y1) / 2) < h * 0.5,
      );
      if (!next) break;
      used.add(next);
      cur = {
        text: cur.text.trim() + next.text.trim(),
        confidence: Math.min(cur.confidence ?? 0, next.confidence ?? 0),
        box: {
          x0: cur.box.x0,
          y0: Math.min(cur.box.y0, next.box.y0),
          x1: next.box.x1,
          y1: Math.max(cur.box.y1, next.box.y1),
        },
      };
    }
    out.push(cur);
  }
  return out;
}

export function tableFromWords(words, width) {
  const tokens = mergeNumberParts(words.filter((w) => w.text && w.box)).map((w) => ({
    ...w,
    ...center(w.box),
    cx: center(w.box).x,
    value: coordinateToken(w.text),
  }));
  const numbers = tokens.filter((t) => t.value);
  if (numbers.length < 2) return null;
  const height = median(numbers.map((t) => t.box.y1 - t.box.y0)) || 20;

  // Coordinate columns: clusters of numbers; small clusters are stray numbers (titles, notes).
  let columns = clusterColumns(numbers, Math.max(width * 0.04, height * 1.5));
  const biggest = Math.max(...columns.map((c) => c.tokens.length));
  columns = columns
    .filter((c) => c.tokens.length >= Math.max(2, biggest * 0.4))
    .sort((a, b) => a.cx() - b.cx())
    .slice(0, 3);
  if (!columns.length) return null;

  // Page tilt: try slopes up to ±8° and keep the one that lines up the most numbers of
  // neighbouring columns on common rows; among equals, the one that lines them up most exactly.
  let slope = 0,
    bestScore = -Infinity;
  for (let step = -70; step <= 70; step++) {
    const s = step * 0.002;
    let matched = 0,
      residual = 0;
    for (let c = 1; c < columns.length; c++)
      for (const t of columns[c].tokens) {
        const off = Math.min(
          ...columns[c - 1].tokens.map((k) => Math.abs(t.y - k.y - s * (t.cx - k.cx))),
        );
        if (off < height * 0.35) {
          matched++;
          residual += off;
        }
      }
    const score = matched - residual / (height * (matched + 1));
    if (
      score > bestScore + 1e-9 ||
      (Math.abs(score - bestScore) <= 1e-9 && Math.abs(s) < Math.abs(slope))
    ) {
      bestScore = score;
      slope = s;
    }
  }
  const level = (t) => t.y - slope * t.cx;

  // Rows: numbers at the same (tilt-corrected) height, one per column at most.
  const anchors = columns.flatMap((c, ci) => c.tokens.map((t) => ({ t, ci, y: level(t) })));
  anchors.sort((a, b) => a.y - b.y);
  const bands = [];
  for (const a of anchors) {
    const band = bands.at(-1);
    if (band && a.y - band.y < height * 0.75 && !band.cells[a.ci]) {
      band.cells[a.ci] = a.t;
      band.y = (band.y * band.n + a.y) / (band.n + 1);
      band.n++;
    } else bands.push({ y: a.y, n: 1, cells: { [a.ci]: a.t } });
  }

  // Names: other words left of the first coordinate column on the row's line.
  const firstLeft = Math.min(...columns[0].tokens.map((t) => t.box.x0));
  const others = tokens.filter((t) => !t.value || t.box.x1 < firstLeft - height * 0.3);
  const rows = bands.map((band) => {
    const words = others
      .filter(
        (t) => t.box.x1 < firstLeft - height * 0.3 && Math.abs(level(t) - band.y) < height * 0.8,
      )
      .sort((a, b) => a.cx - b.cx);
    const cells = columns.map((_, ci) => band.cells[ci] ?? null);
    // Where a value or name was not found on the first pass, point at where it should be (the
    // column's usual extent on this row's line) so it can be read on its own.
    const at = (x0, x1) => {
      const y = band.y + slope * ((x0 + x1) / 2);
      return { x0, y0: y - height * 0.6, x1, y1: y + height * 0.6 };
    };
    const expected = (ci) =>
      at(
        median(columns[ci].tokens.map((t) => t.box.x0)),
        median(columns[ci].tokens.map((t) => t.box.x1)),
      );
    return {
      name: words.map((w) => w.text).join(' '),
      nameConfidence: words.length ? Math.min(...words.map((w) => w.confidence ?? 0)) : 0,
      nameBox: words.length
        ? union(words.map((w) => w.box))
        : at(Math.max(0, firstLeft - height * 6), firstLeft - height * 0.4),
      values: cells.map((t) => t?.value ?? ''),
      boxes: cells.map((t, ci) => t?.box ?? expected(ci)),
      confidence: cells.map((t) => t?.confidence ?? 0),
    };
  });

  // E/N order from the headings, when they were read above the columns.
  let order = null;
  const heading = (re) => tokens.find((t) => re.test(t.text));
  const east = heading(/rechts|easting|^ost|^east/i),
    north = heading(/hoch|northing|^nord|^north/i);
  if (east && north && Math.abs(east.cx - north.cx) > height)
    order = east.cx < north.cx ? 'en' : 'ne';

  return { rows, columns: columns.length, slope, order, height };
}

// "R-09-06" → "A-99-99", "3437145.574" → "9999999.999": the form of a value, without its content.
export const shape = (text) =>
  String(text ?? '')
    .replace(/\s/g, '')
    .replace(/[A-Za-z]/g, 'A')
    .replace(/\d/g, '9')
    .replace(/,/g, '.');

// Values in one table column share a form. When a cell's chosen reading has a different form than
// most of its column, and another of its own OCR passes has the usual form, that pass is used
// instead. Only readings actually produced from the photo are considered, nothing is invented,
// and the cell stays flagged (disputed) for review.
// cells[row][col] = { text, confidence, disputed, candidates: [{ text, confidence }] }
export function harmonize(cells) {
  const columns = Math.max(0, ...cells.map((r) => r.length));
  for (let c = 0; c < columns; c++) {
    const counts = new Map();
    for (const row of cells) {
      const k = shape(row[c]?.text);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const [usual, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    // A clear majority only: at least three cells and more than half of the column.
    if (!usual || n < 3 || n <= cells.length / 2) continue;
    for (const row of cells) {
      const cell = row[c];
      if (!cell || shape(cell.text) === usual) continue;
      const fit = (cell.candidates ?? [])
        .filter((x) => shape(x.text) === usual)
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (fit)
        Object.assign(cell, {
          text: fit.text.trim(),
          confidence: fit.confidence,
          chars: fit.chars,
          disputed: true,
          harmonized: true,
        });
    }
  }
  return cells;
}

// When one reading of a table lost a decimal point ("5544860327") and another reading of the same
// photo has exactly the same digits with the point ("5544860.327"), the point is taken from the
// other reading. Digits are never changed. Returns how many values were completed; those rows get
// their field marked disputed so they are still reviewed.
// rows: [{ e, n, h, disputed: [name, e, n, h] }], others: rows of the other reading.
export function borrowSeparators(rows, others) {
  const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
  const withPoint = new Map();
  for (const o of others)
    for (const v of [o.e, o.n, o.h])
      if (/^[+-]?\d+[.,]\d{1,4}$/.test(String(v ?? '').trim()))
        withPoint.set(digitsOf(v), String(v).trim());
  let changed = 0;
  for (const r of rows)
    ['e', 'n', 'h'].forEach((k, i) => {
      const v = String(r[k] ?? '').trim();
      if (!/^[+-]?\d{6,}$/.test(v)) return;
      const found = withPoint.get(digitsOf(v));
      if (!found) return;
      r[k] = found;
      if (r.disputed) r.disputed[i + 1] = true;
      // The borrowed point is the part to look at.
      if (r.uncertainChars) r.uncertainChars[i + 1] = [found.search(/[.,]/)];
      changed++;
    });
  return changed;
}

// A decimal point too small to read: when most values of a column share one format (for example
// 3415xxx.xxx) and a value has exactly that many digits with the same leading digits, the point
// goes where the column has it. The digits never change, and the value stays marked for review.
export function pointFromColumn(rows) {
  let changed = 0;
  ['e', 'n', 'h'].forEach((k, i) => {
    const values = rows.map((r) => String(r[k] ?? '').trim());
    const formats = new Map();
    for (const v of values) {
      const m = v.match(/^([+-]?)(\d+)[.,](\d{1,4})$/);
      if (!m) continue;
      const key = `${m[2].length}.${m[3].length}`;
      formats.set(key, [...(formats.get(key) ?? []), m[2]]);
    }
    const [best] = [...formats].sort((a, b) => b[1].length - a[1].length);
    if (!best) return;
    const [key, integers] = best;
    const pointed = values.filter((v) => /^[+-]?\d+[.,]\d+$/.test(v)).length;
    if (integers.length < 3 || integers.length < pointed * 0.8) return;
    const [intLen, decLen] = key.split('.').map(Number);
    // Leading digits shared by the column (zone and kilometre digits of the coordinates).
    const lead = Math.max(1, intLen - 3);
    const prefixes = new Set(integers.map((d) => d.slice(0, lead)));
    rows.forEach((r, j) => {
      const m = values[j].match(/^([+-]?)(\d+)$/);
      if (!m || m[2].length !== intLen + decLen || !prefixes.has(m[2].slice(0, lead))) return;
      r[k] = `${m[1]}${m[2].slice(0, intLen)}.${m[2].slice(intLen)}`;
      if (r.disputed) r.disputed[i + 1] = true;
      if (r.uncertainChars) r.uncertainChars[i + 1] = [m[1].length + intLen];
      changed++;
    });
  });
  return changed;
}

// Combines the second recogniser's readings (PaddleOCR) with Tesseract's, field by field.
// second[j][i] is the second reading of row j, field i (name, e, n, h), or null when that cell was
// not read. Rules, chosen on the test photos and degraded copies of them:
// - Both readings the same, of a valid form, of the shape of their column, and Tesseract at least
//   moderately sure: the value counts as confirmed and loses its doubt marks. Without the column
//   shape and the confidence, two readers agree on the wrong cell when a column was lost.
// - Different readings: the one of a valid form wins, the second reader first (it is the more
//   accurate one). The value stays marked, with the characters where the two differ.
// Returns counts for the notice.
export function combineReadings(rows, second, { minConfidence = 50 } = {}) {
  const fields = ['name', 'e', 'n', 'h'];
  const clean = (k, v) => {
    const s = String(v ?? '')
      .normalize('NFKC')
      .replace(/\s/g, '')
      // A piece of a grid line at the cell edge reads as a bracket or a bar.
      .replace(/^[[\]|()]+|[[\]|()]+$/g, '');
    return k === 'name' ? s.replace(/^[-.]+|[-.]+$/g, '') : s.replace(/^\+/, '').replace(',', '.');
  };
  const stored = (k, v) =>
    k === 'name'
      ? String(v ?? '').replace(/\s/g, '')
      : String(v ?? '')
          .replace(/\s/g, '')
          .replace(/^\+/, '')
          .replace(',', '.');
  const valid = (k, v) =>
    k === 'name' ? /^[A-Za-z0-9_.-]{1,16}$/.test(v) : /^-?\d+\.\d{1,4}$/.test(v);
  const shape = (k, v) => {
    if (k === 'name') return v.replace(/\d/g, '9');
    const m = v.match(/^-?(\d+)\.(\d+)$/);
    return m
      ? `${m[1].length}.${m[2].length}:${m[1].slice(0, Math.max(1, m[1].length - 3))}`
      : null;
  };
  const columnShape = fields.map((k) => {
    const counts = new Map();
    for (const r of rows) {
      const sh = shape(k, stored(k, r[k]));
      if (sh) counts.set(sh, (counts.get(sh) ?? 0) + 1);
    }
    const [best] = [...counts].sort((a, b) => b[1] - a[1]);
    return best && best[1] >= Math.max(3, rows.length * 0.5) ? best[0] : null;
  });
  // The shape of each column as both readers see it. It settles a disagreement, and one
  // reader's repeated mistake (a 9 for every leading 5) cannot outvote the other this way.
  const bothShape = fields.map((k, i) => {
    const counts = new Map();
    let n = 0;
    rows.forEach((r, j) => {
      const p = second[j]?.[i];
      for (const v of [stored(k, r[k]), p == null ? '' : clean(k, p)]) {
        const sh = v && shape(k, v);
        if (!sh) continue;
        n++;
        counts.set(sh, (counts.get(sh) ?? 0) + 1);
      }
    });
    // Wrong readings rarely share a shape: a clear lead with a third of the readings is enough.
    const [best, next] = [...counts].sort((a, b) => b[1] - a[1]);
    return best && best[1] >= Math.max(3, n / 3) && best[1] > (next?.[1] ?? 0) * 1.5
      ? best[0]
      : null;
  });
  let compared = 0,
    agreed = 0,
    replaced = 0;
  rows.forEach((r, j) => {
    const readings = second[j];
    if (!readings) return;
    r.cellConfidence ??= [0, 0, 0, 0];
    r.disputed ??= [false, false, false, false];
    r.uncertainChars ??= [[], [], [], []];
    r.second = readings.map((v, i) => (v == null ? null : clean(fields[i], v)));
    fields.forEach((k, i) => {
      const p = r.second[i],
        t = stored(k, r[k]);
      // The second reader saw nothing: that says nothing about Tesseract's value.
      if (!p) return;
      compared++;
      if (p === t) {
        agreed++;
        if (
          valid(k, t) &&
          columnShape[i] !== null &&
          shape(k, t) === columnShape[i] &&
          (r.cellConfidence[i] ?? 0) >= minConfidence
        ) {
          r.cellConfidence[i] = Math.max(r.cellConfidence[i] ?? 0, 90);
          r.disputed[i] = false;
          r.uncertainChars[i] = [];
        }
        return;
      }
      // The second reading wins when it is valid, unless only Tesseract's has the column's shape
      // (DT202 among DT2xx names against 6166 read from a moiré cell).
      const fits = (v) => bothShape[i] !== null && shape(k, v) === bothShape[i];
      const value = valid(k, p) && !(valid(k, t) && fits(t) && !fits(p)) ? p : t,
        other = value === p ? t : p;
      if (value !== t) {
        r[k] = value;
        replaced++;
      }
      r.disputed[i] = true;
      r.uncertainChars[i] = other ? disagreement(value, [{ text: other }], k === 'name') : [];
    });
  });
  return { compared, agreed, replaced };
}

// Edit distance (insertions, deletions, substitutions) between two short strings.
export function editDistance(a, b) {
  const prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const normalized = (s, isName) =>
  isName ? String(s ?? '').replace(/\s/g, '') : String(s ?? '').trim();

// Positions of `value` that differ from `other` in a minimal alignment: substituted or missing
// characters, and the neighbour of an extra character in `other`.
function alignedDifferences(value, other, ignoreLostSeparator = false) {
  const n = value.length,
    m = other.length,
    d = Array.from({ length: n + 1 }, (_, i) => [i, ...Array(m).fill(0)]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (value[i - 1] === other[j - 1] ? 0 : 1),
      );
  const marks = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    if (i && j && d[i][j] === d[i - 1][j - 1] + (value[i - 1] === other[j - 1] ? 0 : 1)) {
      if (value[i - 1] !== other[j - 1]) marks.push(i - 1);
      i--;
      j--;
    } else if (i && d[i][j] === d[i - 1][j] + 1) {
      if (!(ignoreLostSeparator && /[.,]/.test(value[i - 1]))) marks.push(i - 1);
      i--;
    } else {
      // An extra character in `other` sits between two of ours: both neighbours are suspect.
      for (const k of [i - 1, i]) if (k >= 0 && k < n) marks.push(k);
      j--;
    }
  }
  return marks;
}

// Where another pass of the same cell read something slightly different (at most two characters
// apart). Passes that read something else entirely are noise, and a pass that only lacks the
// decimal point is no evidence against a point that was read.
export function disagreement(text, candidates = [], isName = false) {
  const value = normalized(text, isName),
    digits = (v) => v.replace(/[.,]/g, ''),
    marks = new Set();
  for (const c of candidates) {
    const other = normalized(c?.text, isName);
    if (!other || other === value || editDistance(value, other) > 2) continue;
    if (!isName && digits(other) === digits(value) && !/[.,]/.test(other)) continue;
    for (const i of alignedDifferences(value, other, !isName && !/[.,]/.test(other))) marks.add(i);
  }
  return [...marks].sort((a, b) => a - b);
}

// Which characters of a reading deserve a second look: characters Tesseract was unsure of and
// the places where a close alternative reading differs. Decimal points are small and always read
// with lower confidence, so they count as doubtful only when much lower.
// Indices refer to the value as stored (names without spaces, values trimmed).
export function uncertainIndices(text, chars, candidates = [], isName = false) {
  const raw = String(text ?? ''),
    value = normalized(raw, isName),
    marks = new Set(disagreement(raw, candidates, isName));
  if (Array.isArray(chars)) {
    const kept = [...raw]
      .map((ch, i) => [ch, chars[i]])
      .filter(([ch]) => !(isName && /\s/.test(ch)));
    const offset = isName ? 0 : raw.length - raw.trimStart().length;
    const aligned = isName ? kept : kept.slice(offset, offset + value.length);
    if (aligned.length === value.length)
      aligned.forEach(([ch, c], i) => {
        if (typeof c === 'number' && c < (/[.,]/.test(ch) ? 40 : 70)) marks.add(i);
      });
  }
  return [...marks].sort((a, b) => a - b);
}
