// Bounded, dependency-free table detection and perspective correction.
export function findTable(pixels, width, height) {
  const scale = Math.min(1, 640 / Math.max(width, height)),
    w = Math.round(width * scale),
    h = Math.round(height * scale);
  const points = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ox = Math.min(width - 2, Math.round(x / scale)),
        oy = Math.min(height - 2, Math.round(y / scale));
      let v = 0;
      for (const d of [0, 4, width * 4, width * 4 + 4]) {
        const i = (oy * width + ox) * 4 + d;
        v += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
      }
      if (v / 4 < 165) points.push([x, y]);
    }
  function lines(vertical) {
    const length = vertical ? h : w,
      span = vertical ? w : h,
      center = length / 2;
    const bins = span + 2 * Math.ceil(length * 0.35) + 4,
      offset = Math.ceil(length * 0.35) + 2;
    const count = 101,
      votes = new Uint16Array(count * bins);
    for (let a = 0; a < count; a++) {
      const slope = (a - 50) * 0.006,
        base = a * bins;
      for (const [x, y] of points) {
        const b = Math.round((vertical ? x : y) - slope * ((vertical ? y : x) - center)) + offset;
        if (b >= 0 && b < bins) votes[base + b]++;
      }
    }
    const found = [];
    for (let k = 0; k < 24; k++) {
      let max = 0,
        index = 0;
      for (let i = 0; i < votes.length; i++)
        if (votes[i] > max) {
          max = votes[i];
          index = i;
        }
      if (max < length * (vertical ? 0.38 : 0.48)) break;
      const a = Math.floor(index / bins),
        bin = index % bins,
        b = bin - offset;
      found.push({ slope: (a - 50) * 0.006, b, score: max });
      for (let j = 0; j < count; j++)
        for (let d = -7; d <= 7; d++)
          if (bin + d >= 0 && bin + d < bins) votes[j * bins + bin + d] = 0;
    }
    return found.sort((a, b) => a.b - b.b);
  }
  const hs = lines(false),
    vs = lines(true);
  if (hs.length < 2 || vs.length < 2) return null;
  function intersect(hline, vline) {
    const a = hline.slope,
      b = hline.b - (a * w) / 2,
      c = vline.slope,
      d = vline.b - (c * h) / 2;
    const x = (c * b + d) / (1 - a * c),
      y = a * x + b;
    return { x: x / w, y: y / h };
  }
  let best = null,
    area = 0.18;
  for (let a = 0; a < hs.length - 1; a++)
    for (let b = a + 1; b < hs.length; b++)
      for (let c = 0; c < vs.length - 1; c++)
        for (let d = c + 1; d < vs.length; d++) {
          const quad = [
            intersect(hs[a], vs[c]),
            intersect(hs[a], vs[d]),
            intersect(hs[b], vs[d]),
            intersect(hs[b], vs[c]),
          ];
          if (
            !validQuad(quad) ||
            quad.some((p) => p.x < -0.005 || p.x > 1.005 || p.y < -0.005 || p.y > 1.005)
          )
            continue;
          const candidate = polygonArea(quad);
          if (candidate > area) {
            area = candidate;
            best = quad;
          }
        }
  return (
    best?.map((p) => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) })) ||
    null
  );
}

export const fullQuad = () => [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
function polygonArea(q) {
  return (
    Math.abs(q.reduce((s, p, i) => s + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2
  );
}
export function validQuad(q) {
  if (
    !Array.isArray(q) ||
    q.length !== 4 ||
    q.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    return false;
  const cross = q.map((p, i) => {
    const a = q[(i + 1) % 4],
      b = q[(i + 2) % 4];
    return (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x);
  });
  return cross.every((n) => n > 0.0001) && polygonArea(q) > 0.015;
}

function homography(q) {
  // Map a unit square into a source quadrilateral.
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y,
    dy3 = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(den) > 1e-10 ? (dx3 * dy2 - dx2 * dy3) / den : 0;
  const h = Math.abs(den) > 1e-10 ? (dx1 * dy3 - dx3 * dy1) / den : 0;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
  ];
}

export function rectify(pixels, sw, sh, quad = fullQuad(), enhance = true) {
  if (!validQuad(quad)) throw new Error('quad');
  const q = quad.map((p) => ({ x: p.x * (sw - 1), y: p.y * (sh - 1) }));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const naturalW = (distance(q[0], q[1]) + distance(q[2], q[3])) / 2;
  const naturalH = (distance(q[0], q[3]) + distance(q[1], q[2])) / 2;
  const scale = Math.min(
    2,
    2000 / naturalW,
    2400 / naturalH,
    Math.sqrt(4000000 / (naturalW * naturalH)),
  );
  const width = Math.max(64, Math.round(naturalW * scale)),
    height = Math.max(64, Math.round(naturalH * scale));
  const out = new Uint8ClampedArray(width * height * 4),
    m = homography(q);
  // Mild box filtering suppresses screen moire before contrast enhancement.
  const gray = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let sum = 0,
        count = 0;
      const radius = enhance ? 2 : 0;
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || xx >= sw || yy < 0 || yy >= sh) continue;
          const i = (yy * sw + xx) * 4;
          sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
          count++;
        }
      gray[y * sw + x] = sum / count;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1),
        v = y / (height - 1),
        d = m[6] * u + m[7] * v + 1;
      const sx = Math.max(0, Math.min(sw - 1.001, (m[0] * u + m[1] * v + m[2]) / d)),
        sy = Math.max(0, Math.min(sh - 1.001, (m[3] * u + m[4] * v + m[5]) / d));
      const ix = Math.floor(sx),
        iy = Math.floor(sy),
        fx = sx - ix,
        fy = sy - iy;
      let g =
        (gray[iy * sw + ix] * (1 - fx) + gray[iy * sw + ix + 1] * fx) * (1 - fy) +
        (gray[(iy + 1) * sw + ix] * (1 - fx) + gray[(iy + 1) * sw + ix + 1] * fx) * fy;
      if (enhance) g = Math.max(0, Math.min(255, ((g - 100) * 255) / 75));
      const i = (y * width + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = g;
      out[i + 3] = 255;
    }
  if (enhance) removeGrid(out, width, height);
  return { data: out, width, height };
}

// Maps a rectangle of the rectified (pw×ph) image back to a bounding box in the original photo.
function mapBack(quad, x0, y0, x1, y1, pw, ph, sw, sh) {
  const m = homography(quad.map((p) => ({ x: p.x * (sw - 1), y: p.y * (sh - 1) })));
  const map = (x, y) => {
    const u = x / pw,
      v = y / ph,
      d = m[6] * u + m[7] * v + 1;
    return { x: (m[0] * u + m[1] * v + m[2]) / d, y: (m[3] * u + m[4] * v + m[5]) / d };
  };
  const pts = [map(x0, y0), map(x1, y0), map(x1, y1), map(x0, y1)];
  const x = Math.max(0, Math.min(...pts.map((p) => p.x)) - 8),
    y = Math.max(0, Math.min(...pts.map((p) => p.y)) - 8);
  return {
    x,
    y,
    w: Math.min(sw, Math.max(...pts.map((p) => p.x)) + 8) - x,
    h: Math.min(sh, Math.max(...pts.map((p) => p.y)) + 8) - y,
  };
}

// The whole table row: full width of the frame, a little taller than the row.
export function originalRegion(quad, bbox, pw, ph, sw, sh) {
  return mapBack(quad, 0, bbox.y0 - 12, pw, bbox.y1 + 12, pw, ph, sw, sh);
}

// A single table cell, so it can be shown right above the field it is compared with.
export function cellRegion(quad, cell, pw, ph, sw, sh) {
  return mapBack(quad, cell.x0, cell.y0, cell.x1, cell.y1, pw, ph, sw, sh);
}

export function removeGrid(p, w, h) {
  const rows = [],
    cols = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (p[(y * w + x) * 4] < 100) n++;
    if (n > w * 0.55) rows.push(y);
  }
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) if (p[(y * w + x) * 4] < 100) n++;
    if (n > h * 0.55) cols.push(x);
  }
  const radius = 3;
  for (const row of rows)
    for (let y = Math.max(0, row - radius); y <= Math.min(h - 1, row + radius); y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        p[i] = p[i + 1] = p[i + 2] = 255;
      }
  for (const col of cols)
    for (let x = Math.max(0, col - radius); x <= Math.min(w - 1, col + radius); x++)
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        p[i] = p[i + 1] = p[i + 2] = 255;
      }
}

export function gridCells(p, w, h) {
  function peaks(vertical) {
    const span = vertical ? w : h,
      length = vertical ? h : w,
      positions = [];
    for (let a = 0; a < span; a++) {
      let count = 0;
      for (let b = 0; b < length; b++) {
        const i = (vertical ? b * w + a : a * w + b) * 4;
        if (p[i] < 135) count++;
      }
      if (count > length * (vertical ? 0.4 : 0.4)) positions.push(a);
    }
    const groups = [];
    for (const pos of positions) {
      if (!groups.length || pos - groups.at(-1).at(-1) > 10) groups.push([]);
      groups.at(-1).push(pos);
    }
    const centers = groups
      .map((g) => Math.round((g[0] + g.at(-1)) / 2))
      .filter((x) => x > 12 && x < span - 12);
    return [0, ...centers, span - 1];
  }
  const xs = peaks(true),
    ys = peaks(false);
  if (xs.length < 4 || xs.length > 5 || ys.length < 4) return null;
  if (xs.some((x, i) => i > 0 && x - xs[i - 1] < w * 0.1)) return null;
  const rows = [];
  for (let i = 1; i < ys.length; i++)
    if (ys[i] - ys[i - 1] > 20) {
      rows.push(
        xs.slice(1).map((x, c) => ({
          left: xs[c] + 10,
          top: ys[i - 1] + 10,
          width: Math.max(10, x - xs[c] - 20),
          height: Math.max(10, ys[i] - ys[i - 1] - 20),
        })),
      );
    }
  return { rows, xs, ys };
}

export function thresholdCell(p, w, h, threshold = 140) {
  const out = new Uint8ClampedArray(p.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0,
        count = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(w - 1, x + dx)),
            yy = Math.max(0, Math.min(h - 1, y + dy));
          sum += p[(yy * w + xx) * 4];
          count++;
        }
      const value = sum / count > threshold ? 255 : 0,
        i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = value;
      out[i + 3] = 255;
    }
  return { data: out, width: w, height: h };
}
