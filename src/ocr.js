import {
  coordinate,
  parseOCR,
  detectOrder,
  isTableHeader,
  chooseReading,
} from './core.js?v=__BUILD__';
import {
  validQuad,
  fullQuad,
  rectify,
  gridCells,
  thresholdCell,
  clearBorders,
  removeLines,
  otsu,
  hasBox,
} from './imaging.js?v=__BUILD__';
import { tableFromWords, harmonize } from './layout.js?v=__BUILD__';
import { uid, state, source } from './state.js?v=__BUILD__';
import { $, toast, notice, canvas, pixelsFor, canvasFrom } from './dom.js?v=__BUILD__';
import { save } from './storage.js?v=__BUILD__';
import { renderFlow } from './flow.js?v=__BUILD__';
import { t, tp } from './i18n.js?v=__BUILD__';
import { snapshot, render, renderSources, renderPhoto, setBusy } from './render.js?v=__BUILD__';

let ocrController = null,
  worker = null,
  cancelled = false,
  wakeLock = null,
  keepAwake = false;

// A phone that locks its screen suspends the page and stops recognition. Hold a screen wake lock
// while recognizing; the browser drops it whenever the page is hidden, so take it again on return.
async function requestWakeLock() {
  if (!keepAwake || wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible')
    return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => (wakeLock = null));
    if (!keepAwake) releaseWakeLock();
  } catch {
    // Not allowed (battery saver, unsupported): the on-screen hint still asks to keep it awake.
  }
}
function releaseWakeLock() {
  keepAwake = false;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', requestWakeLock);
export function progress(text, value) {
  $('progressText').textContent = text;
  $('ocrProgress').value = Math.max(0, Math.min(1, value));
  renderFlow();
}
export async function getWorker(signal) {
  if (worker) return worker;
  if (!window.Tesseract) throw new Error(t('ocr.notLoaded'));
  progress(t('ocr.loading'), 0.02);
  const w = await Tesseract.createWorker('eng', 1, {
    workerPath: new URL('./vendor/worker.min.js', location.href).href,
    corePath: new URL('./vendor/core/', location.href).href,
    langPath: new URL('./vendor/lang', location.href).href,
    cacheMethod: 'none',
    logger: (m) => {
      if (!signal.aborted && /loading|initializing/.test(m.status))
        progress(t('ocr.preparing'), 0.02 + 0.08 * (m.progress || 0));
    },
  });
  if (signal.aborted) {
    await w.terminate();
    throw new Error('cancel');
  }
  worker = w;
  return w;
}
const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-. ';
const NUMBER_CHARS = '0123456789.,-+';
// A plausible coordinate reading: digits, one separator, 1–4 decimals.
const numeric = (v) => /^[+-]?\d{3,}[.,]\d{1,4}$/.test(String(v ?? '').trim());
const goodRow = (r) => Boolean(r.name) && numeric(r.e) && numeric(r.n);

// Copies a region of a canvas onto white with a margin, clearing box or grid lines along its
// edges, optionally stretched horizontally (narrow condensed digits read better wider).
function cropRegion(source, rect, stretch = 1, boxed = null) {
  const w = Math.max(4, Math.round(rect.width)),
    h = Math.max(4, Math.round(rect.height)),
    raw = canvas(w, h),
    rc = raw.getContext('2d', { willReadFrequently: true });
  rc.drawImage(source, rect.left, rect.top, w, h, 0, 0, w, h);
  const pixels = rc.getImageData(0, 0, w, h);
  clearBorders(pixels.data, w, h, { boxed });
  rc.putImageData(pixels, 0, 0);
  // Small text (low-resolution photos) is enlarged: Tesseract reads best at ~30–50 px glyphs.
  const zoom = Math.min(3, Math.max(1, 64 / h)),
    out = canvas(Math.round(w * zoom * stretch) + 24, Math.round(h * zoom) + 24),
    ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(raw, 0, 0, w, h, 12, 12, out.width - 24, out.height - 24);
  return { canvas: out, pixels: rc.getImageData(0, 0, w, h) };
}

async function ocrText(w, image, signal) {
  if (signal.aborted) throw new Error('cancel');
  const { data } = await w.recognize(image.toDataURL('image/png'), {}, { text: true });
  return { text: data.text.trim().replace(/\s+/g, ' '), confidence: data.confidence };
}

const wholeCrop = (image) =>
  cropRegion(image, { left: 0, top: 0, width: image.width, height: image.height }).canvas;

// Reads one table cell as a point name or a number. Numbers that look incomplete or uncertain
// are read again with thresholds and stretching; disagreeing passes are flagged, never guessed.
// `boxed`: { margin } when the value sits inside its own drawn box (word reader): the box sides,
// found only in the margin around the text, are cleared.
async function readRegion(w, src, signal, rect, kind, boxed = null) {
  await w.setParameters({
    tessedit_pageseg_mode: '7',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: kind === 'number' ? NUMBER_CHARS : NAME_CHARS,
  });
  const first = cropRegion(src.c, rect, 1, boxed);
  let reading = { ...(await ocrText(w, first.canvas, signal)), disputed: false };
  // Test hook: a benchmark page can set globalThis.__ocrDebug = [] to collect what OCR saw.
  globalThis.__ocrDebug?.push({ kind, rect, image: first.canvas.toDataURL(), text: reading.text });
  const unsure = (r) => r.confidence < 80 || !numeric(r.text) || coordinate(r.text).short;
  if (kind !== 'number')
    return src.enhance ? readName(w, src, signal, rect, reading, boxed) : reading;
  if (!src.enhance || !unsure(reading)) return reading;
  const candidates = [reading];
  const plain = cropRegion(src.plain, rect, 1, boxed);
  candidates.push(
    await ocrText(
      w,
      wholeCrop(canvasFrom(otsu(plain.pixels.data, plain.pixels.width, plain.pixels.height))),
      signal,
    ),
  );
  for (const threshold of [140, 160]) {
    const cleaned = canvasFrom(
      thresholdCell(plain.pixels.data, plain.pixels.width, plain.pixels.height, threshold),
    );
    candidates.push(await ocrText(w, wholeCrop(cleaned), signal));
  }
  if (!candidates.some((v) => v.confidence >= 80 && numeric(v.text) && !coordinate(v.text).short))
    candidates.push(await ocrText(w, cropRegion(src.c, rect, 1.5, boxed).canvas, signal));
  return { ...chooseReading(candidates), candidates };
}

// Point names read uncertainly get a second and third pass; the most confident reading wins and
// disagreement between passes is flagged for review.
async function readName(w, src, signal, rect, first, boxed) {
  if (first.confidence >= 85 && first.text) return first;
  const plain = cropRegion(src.plain, rect, 1, boxed).pixels;
  const candidates = [
    first,
    await ocrText(w, wholeCrop(canvasFrom(otsu(plain.data, plain.width, plain.height))), signal),
    await ocrText(w, cropRegion(src.c, rect, 1.3, boxed).canvas, signal),
  ].filter((c) => c.text);
  if (!candidates.length) return first;
  const best = candidates.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const variants = new Set(candidates.map((c) => c.text.replace(/\s/g, '')));
  return { ...best, disputed: variants.size > 1, candidates };
}

// Applies the column-form check to a finished table and copies the readings into the rows.
function harmonizeRows(rows) {
  harmonize(rows.map((r) => r.readings));
  for (const r of rows) {
    const texts = r.readings.map((x) => x.text);
    Object.assign(r, {
      name: (texts[0] ?? '').replace(/\s/g, ''),
      e: texts[1] || '',
      n: texts[2] || '',
      h: texts[3] || '',
      confidence: Math.min(...r.readings.map((x) => x.confidence)),
      cellConfidence: r.readings.map((x) => x.confidence),
      disputed: r.readings.map((x) => Boolean(x.disputed)),
      raw: texts.join(' ; '),
    });
    delete r.readings;
  }
  return rows;
}

// Grid tables: every cell between the detected lines.
async function readGrid(w, grid, src, signal, width) {
  const rows = [],
    raw = [],
    skipped = [];
  let autoOrder = null;
  const total = grid.rows.length * grid.rows[0].length;
  for (let i = 0; i < grid.rows.length; i++) {
    const band = grid.rows[i],
      readings = [];
    for (let j = 0; j < band.length; j++) {
      progress(
        t('ocr.cell', { i: i * band.length + j + 1, total }),
        0.15 + 0.5 * ((i * band.length + j) / total),
      );
      // Header and title cells are read with letters; data cells with digits only.
      const header = j > 0 && isTableHeader([readings[0]?.text]);
      readings.push(await readRegion(w, src, signal, band[j], j && !header ? 'number' : 'name'));
    }
    const texts = readings.map((r) => r.text),
      line = texts.join(' ; ');
    raw.push(line);
    if (isTableHeader(texts)) {
      autoOrder = detectOrder(texts.join(' ')) || autoOrder;
      continue;
    }
    if (!texts.some(Boolean)) {
      skipped.push(line);
      continue;
    }
    // Never drop a partially recognized data row: missing cells are shown as errors.
    rows.push({
      name: texts[0].replace(/\s/g, ''),
      e: texts[1] || '',
      n: texts[2] || '',
      h: texts[3] || '',
      confidence: Math.min(...readings.map((r) => r.confidence)),
      cellConfidence: readings.map((r) => r.confidence),
      disputed: readings.map((r) => r.disputed),
      bbox: { x0: 0, y0: band[0].top, x1: width, y1: band[0].top + band[0].height },
      // Cell boxes in the rectified image, in field order name, e, n, h.
      cells: band
        .slice(0, 4)
        .map((c) => ({ x0: c.left, y0: c.top, x1: c.left + c.width, y1: c.top + c.height })),
      raw: line,
      readings,
    });
  }
  return { rows: harmonizeRows(rows), raw, skipped, autoOrder, columns: true };
}

// Tables without usable lines: read all words once, rebuild rows and columns from their
// positions, then read every name and value again on its own.
async function readByWords(w, src, signal, width) {
  progress(t('ocr.reading'), 0.68);
  await w.setParameters({
    tessedit_pageseg_mode: '11',
    // A fixed resolution avoids Tesseract's "Estimating resolution" console warnings.
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: '',
  });
  if (signal.aborted) throw new Error('cancel');
  const { data } = await w.recognize(
    src.bare.toDataURL('image/png'),
    {},
    { text: true, blocks: true },
  );
  const words = (data.blocks || [])
    .flatMap((b) => b.paragraphs || [])
    .flatMap((p) => p.lines || [])
    .flatMap((l) => l.words || [])
    .map((x) => ({ text: x.text, confidence: x.confidence, box: x.bbox }));
  globalThis.__ocrDebug?.push({ kind: 'words', words, image: src.bare.toDataURL() });
  const table = tableFromWords(words, width);
  if (!table?.rows.length) return null;
  // Boxed values (CAD exports): most numbers have a drawn box of their own around them.
  const numbers = table.rows.flatMap((r) => r.boxes.filter(Boolean));
  const p = src.plainPixels,
    boxedCount = numbers.filter((b) =>
      hasBox(p.data, p.width, p.height, b, table.height * 0.6),
    ).length,
    boxed = boxedCount > numbers.length / 2 ? { margin: table.height * 0.35 } : null;
  const pad = table.height * 0.35,
    asRect = (b) => ({
      left: b.x0 - pad,
      top: b.y0 - pad,
      width: b.x1 - b.x0 + 2 * pad,
      height: b.y1 - b.y0 + 2 * pad,
    });
  const rows = [];
  const total = table.rows.length * (table.columns + 1);
  let done = 0;
  for (const r of table.rows) {
    const readings = [];
    for (const [k, box] of [r.nameBox, ...r.boxes].entries()) {
      progress(t('ocr.cell', { i: ++done, total }), 0.7 + 0.28 * (done / total));
      if (!box) {
        readings.push({ text: k ? '' : r.name, confidence: 0, disputed: false });
        continue;
      }
      const reading = await readRegion(w, src, signal, asRect(box), k ? 'number' : 'name', boxed);
      // Keep the first full-page reading when the focused one comes back empty.
      if (!reading.text) reading.text = k ? r.values[k - 1] : r.name;
      readings.push(reading);
    }
    const texts = readings.map((x) => x.text);
    const boxes = [r.nameBox, ...r.boxes];
    const used = boxes.filter(Boolean);
    rows.push({
      name: texts[0].replace(/\s/g, ''),
      e: texts[1] || '',
      n: texts[2] || '',
      h: texts[3] || '',
      confidence: Math.min(...readings.map((x) => x.confidence)),
      cellConfidence: readings.map((x) => x.confidence),
      disputed: readings.map((x) => x.disputed),
      bbox: {
        x0: 0,
        y0: Math.min(...used.map((b) => b.y0)),
        x1: width,
        y1: Math.max(...used.map((b) => b.y1)),
      },
      cells: boxes.map((b) => b ?? { x0: 0, y0: 0, x1: 1, y1: 1 }),
      raw: texts.join(' ; '),
      readings,
    });
  }
  harmonizeRows(rows);
  return {
    rows,
    raw: rows.map((r) => r.raw),
    skipped: [],
    autoOrder: table.order ?? detectOrder(data.text),
    columns: true,
  };
}

// Last resort: plain line-by-line reading of the whole frame.
async function readLines(w, src, chosenOrder) {
  progress(t('ocr.reading'), 0.25);
  await w.setParameters({
    tessedit_pageseg_mode: '6',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: '',
  });
  const { data } = await w.recognize(
    src.c.toDataURL('image/png'),
    {},
    { text: true, blocks: true },
  );
  const autoOrder = detectOrder(data.text);
  const parsed = parseOCR(data, chosenOrder === 'auto' ? autoOrder || 'en' : chosenOrder);
  return {
    rows: parsed.rows,
    raw: [data.text],
    skipped: parsed.skipped.map((x) => x.text),
    autoOrder,
  };
}

export async function recognizeOne(s, signal) {
  if (signal.aborted) throw new Error('cancel');
  if (!validQuad(s.quad)) throw new Error(t('ocr.crossed'));
  const w = await getWorker(signal);
  progress(t('ocr.aligning'), 0.1);
  await new Promise((r) => setTimeout(r, 10));
  const input = await pixelsFor(s);
  // A "view" is the photo straightened inside one frame, ready for reading.
  const view = (quad) => {
    const plain = rectify(input.data, s.width, s.height, quad, false),
      prepared = s.enhance ? rectify(input.data, s.width, s.height, quad, true) : plain,
      // Word pass image: the plain photo without table lines and value boxes.
      bare = new Uint8ClampedArray(plain.data);
    removeLines(bare, plain.width, plain.height);
    return {
      quad: quad.map((p) => ({ ...p })),
      width: prepared.width,
      height: prepared.height,
      grid: gridCells(plain.data, plain.width, plain.height),
      c: canvasFrom(prepared),
      plain: canvasFrom(plain),
      plainPixels: plain,
      bare: canvasFrom({ data: bare, width: plain.width, height: plain.height }),
      enhance: s.enhance,
    };
  };
  const main = view(s.quad),
    whole = s.quad.some((p, i) => Math.hypot(p.x - fullQuad()[i].x, p.y - fullQuad()[i].y) > 0.01);
  // Two readers: cell by cell along the grid lines, and from word positions for tables whose
  // lines cannot be found (no outer borders, boxed values, a tilted or cut-off page). The word
  // reader also tries the whole photo when the frame may have cut part of the table off.
  // Result quality: complete rows count most, then names and number-like values.
  const digits = (v) => (String(v ?? '').match(/\d/g) || []).length;
  const complete = (r) =>
    r.rows.reduce(
      (sum, row) =>
        sum +
        (goodRow(row) ? 10 : 0) +
        (row.name ? 1 : 0) +
        (digits(row.e) >= 6) +
        (digits(row.n) >= 6),
      0,
    );
  let result = main.grid ? await readGrid(w, main.grid, main, signal, main.width) : null;
  if (result) result.view = main;
  if (!result || result.rows.filter(goodRow).length < result.rows.length * 0.8)
    for (const v of whole ? [main, view(fullQuad())] : [main]) {
      const fromWords = await readByWords(w, v, signal, v.width);
      if (fromWords && (!result || complete(fromWords) > complete(result)))
        result = { ...fromWords, view: v };
    }
  const src = result?.view ?? main;
  if (!result) result = await readLines(w, src, s.order);
  const { rows, raw, skipped } = result;
  let autoOrder = result.autoOrder ?? null;
  let order = s.order === 'auto' ? autoOrder || 'en' : s.order;
  if (order === 'ne' && result.columns)
    for (const row of rows) {
      [row.e, row.n] = [row.n, row.e];
      for (const list of [row.cellConfidence, row.disputed, row.cells])
        if (list?.length > 2) [list[1], list[2]] = [list[2], list[1]];
    }
  if (signal.aborted) throw new Error('cancel');
  // Commit a source atomically only when recognition finished, so cancellation never erases previous points.
  snapshot();
  state.project.rows = state.project.rows.filter((r) => r.sourceId !== s.id);
  for (const row of rows)
    state.project.rows.push({ ...row, id: uid(), sourceId: s.id, verified: false });
  Object.assign(s, {
    recognized: true,
    processed: src.c.toDataURL('image/png'),
    pw: src.width,
    ph: src.height,
    resultQuad: src.quad,
    raw: raw.join('\n'),
    skipped: skipped.join('\n'),
    usedOrder: order,
    autoOrder,
  });
  state.selected = s.id;
  state.view = 'processed';
  state.zoom = 1;
  const message = rows.length
    ? t('ocr.found', { points: tp('n.points', rows.length) })
    : t('ocr.none');
  notice(
    message +
      (!autoOrder && s.order === 'auto' ? t('ocr.defaultOrder') : '') +
      (skipped.length ? t('ocr.skipped') : ''),
  );
  render();
  save();
}
export async function recognize(all = false) {
  if (state.busy || !source()) return;
  const list = all ? state.project.sources.filter((s) => !s.recognized) : [source()];
  if (
    list.some((s) => state.project.rows.some((r) => r.sourceId === s.id)) &&
    !confirm(t('ocr.replaceConfirm'))
  )
    return;
  setBusy(true);
  $('cancelOcrBtn').hidden = false;
  $('awakeHint').hidden = false;
  keepAwake = true;
  requestWakeLock();
  state.recognizing = true;
  cancelled = false;
  notice();
  const controller = new AbortController();
  ocrController = controller;
  const interrupted = new Promise((_, reject) =>
    controller.signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true }),
  );
  try {
    for (const s of list) {
      if (controller.signal.aborted) break;
      state.selected = s.id;
      renderSources();
      renderPhoto();
      await Promise.race([recognizeOne(s, controller.signal), interrupted]);
    }
    if (!controller.signal.aborted) progress(t('ocr.done'), 1);
  } catch (e) {
    if (cancelled || e.message === 'cancel') toast(t('ocr.stopped'));
    else notice(t('ocr.failed') + e.message);
  } finally {
    state.recognizing = false;
    releaseWakeLock();
    $('awakeHint').hidden = true;
    setBusy(false);
    render();
    save();
  }
}
export async function cancelOcr() {
  cancelled = true;
  ocrController?.abort();
  if (worker) {
    const w = worker;
    worker = null;
    await w.terminate();
  }
}
