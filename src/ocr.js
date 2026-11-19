import {
  coordinate,
  parseOCR,
  detectOrder,
  isTableHeader,
  chooseReading,
} from './core.js?v=__BUILD__';
import { validQuad, rectify, gridCells, thresholdCell } from './imaging.js?v=__BUILD__';
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
export async function recognizeOne(s, signal) {
  if (signal.aborted) throw new Error('cancel');
  if (!validQuad(s.quad)) throw new Error(t('ocr.crossed'));
  const w = await getWorker(signal);
  progress(t('ocr.aligning'), 0.1);
  await new Promise((r) => setTimeout(r, 10));
  const input = await pixelsFor(s),
    plain = rectify(input.data, s.width, s.height, s.quad, false),
    grid = gridCells(plain.data, plain.width, plain.height);
  const prepared = s.enhance ? rectify(input.data, s.width, s.height, s.quad, true) : plain;
  const c = canvasFrom(prepared),
    plainCanvas = canvasFrom(plain);
  const rows = [],
    raw = [],
    skipped = [];
  let order = s.order === 'ne' ? 'ne' : 'en',
    autoOrder = null;
  if (grid) {
    await w.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' });
    for (let i = 0; i < grid.rows.length; i++) {
      const band = grid.rows[i],
        texts = [],
        conf = [],
        disputed = [];
      for (let j = 0; j < band.length; j++) {
        if (signal.aborted) throw new Error('cancel');
        progress(
          t('ocr.cell', { i: i * band.length + j + 1, total: grid.rows.length * band.length }),
          0.15 + 0.8 * ((i * band.length + j) / (grid.rows.length * band.length)),
        );
        // Header cells are read with letters; data cells are read with a restricted numeric alphabet.
        const header = j > 0 && isTableHeader([texts[0]]);
        await w.setParameters({
          tessedit_char_whitelist:
            j && !header
              ? '0123456789.,-+'
              : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-. ',
        });
        const rect = band[j],
          cell = canvas(rect.width + 24, rect.height + 24),
          ctx = cell.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, cell.width, cell.height);
        ctx.drawImage(
          c,
          rect.left,
          rect.top,
          rect.width,
          rect.height,
          12,
          12,
          rect.width,
          rect.height,
        );
        const { data } = await w.recognize(cell.toDataURL('image/png'), {}, { text: true });
        let reading = {
          text: data.text.trim().replace(/\s+/g, ' '),
          confidence: data.confidence,
          disputed: false,
        };
        if (
          j &&
          !header &&
          s.enhance &&
          texts[0] &&
          !/koordinat/i.test(texts[0]) &&
          (reading.confidence < 80 ||
            !coordinate(reading.text).ok ||
            coordinate(reading.text).short)
        ) {
          const candidates = [reading],
            rawCell = canvas(rect.width, rect.height),
            rc = rawCell.getContext('2d', { willReadFrequently: true });
          rc.drawImage(
            plainCanvas,
            rect.left,
            rect.top,
            rect.width,
            rect.height,
            0,
            0,
            rect.width,
            rect.height,
          );
          const pixels = rc.getImageData(0, 0, rect.width, rect.height);
          for (const threshold of [140, 160]) {
            if (signal.aborted) throw new Error('cancel');
            const cleaned = canvasFrom(
                thresholdCell(pixels.data, rect.width, rect.height, threshold),
              ),
              padded = canvas(cleaned.width + 24, cleaned.height + 24),
              ctx = padded.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, padded.width, padded.height);
            ctx.drawImage(cleaned, 12, 12);
            const { data: alt } = await w.recognize(
              padded.toDataURL('image/png'),
              {},
              { text: true },
            );
            candidates.push({ text: alt.text, confidence: alt.confidence });
          }
          if (
            !candidates.some(
              (v) => v.confidence >= 80 && coordinate(v.text).ok && !coordinate(v.text).short,
            )
          ) {
            const wide = canvas(Math.round(rect.width * 1.5) + 24, rect.height + 24),
              ctx = wide.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, wide.width, wide.height);
            ctx.drawImage(
              c,
              rect.left,
              rect.top,
              rect.width,
              rect.height,
              12,
              12,
              wide.width - 24,
              rect.height,
            );
            if (signal.aborted) throw new Error('cancel');
            const { data: alt } = await w.recognize(
              wide.toDataURL('image/png'),
              {},
              { text: true },
            );
            candidates.push({ text: alt.text, confidence: alt.confidence });
          }
          reading = chooseReading(candidates);
        }
        texts.push(reading.text);
        conf.push(reading.confidence);
        disputed.push(reading.disputed);
      }
      const line = texts.join(' ; ');
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
        confidence: Math.min(...conf),
        cellConfidence: conf,
        disputed,
        bbox: { x0: 0, y0: band[0].top, x1: prepared.width, y1: band[0].top + band[0].height },
        // Cell boxes in the rectified image, in field order name, e, n, h.
        cells: band.slice(0, 4).map((c) => ({
          x0: c.left,
          y0: c.top,
          x1: c.left + c.width,
          y1: c.top + c.height,
        })),
        raw: line,
      });
    }
    if (s.order === 'auto' && autoOrder) order = autoOrder;
    if (order === 'ne')
      for (const row of rows) {
        [row.e, row.n] = [row.n, row.e];
        [row.cellConfidence[1], row.cellConfidence[2]] = [
          row.cellConfidence[2],
          row.cellConfidence[1],
        ];
        [row.disputed[1], row.disputed[2]] = [row.disputed[2], row.disputed[1]];
        if (row.cells.length > 2) [row.cells[1], row.cells[2]] = [row.cells[2], row.cells[1]];
      }
  } else {
    progress(t('ocr.reading'), 0.25);
    await w.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: '',
    });
    const { data } = await w.recognize(c.toDataURL('image/png'), {}, { text: true, blocks: true });
    if (s.order === 'auto') autoOrder = detectOrder(data.text);
    order = s.order === 'auto' ? autoOrder || 'en' : s.order;
    const parsed = parseOCR(data, order);
    rows.push(...parsed.rows);
    raw.push(data.text);
    skipped.push(...parsed.skipped.map((s) => s.text));
  }
  if (signal.aborted) throw new Error('cancel');
  // Commit a source atomically only when recognition finished, so cancellation never erases previous points.
  snapshot();
  state.project.rows = state.project.rows.filter((r) => r.sourceId !== s.id);
  for (const row of rows)
    state.project.rows.push({ ...row, id: uid(), sourceId: s.id, verified: false });
  Object.assign(s, {
    recognized: true,
    processed: c.toDataURL('image/png'),
    pw: prepared.width,
    ph: prepared.height,
    resultQuad: s.quad.map((p) => ({ ...p })),
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
