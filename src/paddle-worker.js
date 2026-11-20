// Second recogniser: PaddleOCR PP-OCRv6 tiny on ONNX Runtime Web, off the main thread.
// Receives grey cell images, answers with the text of each (null where no image was given).
import * as ort from './vendor/ort/ort.wasm.min.mjs';

// GitHub Pages cannot send the headers WebAssembly threads need: one thread.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./vendor/ort/', self.location.href).href;
ort.env.logLevel = 'error';

let ready = null;
async function load() {
  const [session, dict] = await Promise.all([
    ort.InferenceSession.create(new URL('./vendor/paddle/rec.onnx', self.location.href).href, {
      executionProviders: ['wasm'],
      logSeverityLevel: 3,
    }),
    fetch(new URL('./vendor/paddle/dict.json', self.location.href)).then((r) => r.json()),
  ]);
  return { session, dict };
}

// One text line, as the model was trained: height 48, width at least 320 (padded with mid grey),
// grey copied to three channels, scaled to −1…1.
function tensor({ w, h, gray }) {
  const H = 48,
    rw = Math.max(1, Math.ceil((H * w) / h)),
    W = Math.max(320, rw),
    data = new Float32Array(3 * H * W);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < rw; x++) {
      const sx = Math.min(w - 1, ((x + 0.5) * w) / rw - 0.5),
        sy = Math.min(h - 1, ((y + 0.5) * h) / H - 0.5),
        x0 = Math.max(0, Math.floor(sx)),
        y0 = Math.max(0, Math.floor(sy)),
        x1 = Math.min(w - 1, x0 + 1),
        y1 = Math.min(h - 1, y0 + 1),
        fx = Math.max(0, sx - x0),
        fy = Math.max(0, sy - y0);
      const g =
        (gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx) * (1 - fy) +
        (gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx) * fy;
      const v = (g / 255 - 0.5) / 0.5;
      for (let c = 0; c < 3; c++) data[c * H * W + y * W + x] = v;
    }
  return new ort.Tensor('float32', data, [1, 3, H, W]);
}

// Greedy CTC decoding: the best class per step, repeats merged, blanks (class 0) dropped.
function decode(out, dict) {
  const [, T, C] = out.dims,
    d = out.data;
  let text = '',
    last = -1;
  for (let t = 0; t < T; t++) {
    let best = 0,
      score = -Infinity;
    for (let c = 0; c < C; c++)
      if (d[t * C + c] > score) {
        score = d[t * C + c];
        best = c;
      }
    if (best && best !== last) text += best <= dict.length ? dict[best - 1] : ' ';
    last = best;
  }
  return text;
}

self.onmessage = async ({ data }) => {
  try {
    ready ??= load();
    const { session, dict } = await ready;
    const texts = [];
    for (const [i, crop] of data.crops.entries()) {
      if (!crop) {
        texts.push(null);
        continue;
      }
      const result = await session.run({ [session.inputNames[0]]: tensor(crop) });
      texts.push(decode(result[session.outputNames[0]], dict));
      if (i % 8 === 7) self.postMessage({ id: data.id, done: i + 1, total: data.crops.length });
    }
    self.postMessage({ id: data.id, texts });
  } catch (e) {
    ready = null;
    self.postMessage({ id: data.id, error: String(e?.message ?? e) });
  }
};
