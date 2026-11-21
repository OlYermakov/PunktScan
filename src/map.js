// Point map: a local sketch of the points (E to the right, N up, one scale for both axes) that
// can be zoomed and moved. Points and labels keep their size, so close points come apart when
// zoomed in; the grid and the scale bar follow the zoom in round metre steps.
import { esc } from './dom.js?v=__BUILD__';
import { lang } from './i18n.js?v=__BUILD__';

const W = 800,
  H = 480;

// A round step of 1, 2 or 5 × 10ⁿ metres close to the given length.
export function niceStep(length) {
  const power = 10 ** Math.floor(Math.log10(length)),
    unit = length / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

// The view that shows every point with a margin.
export function fitView(pts) {
  const xs = pts.map((p) => p.x),
    ys = pts.map((p) => p.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const f = Math.min(
    (W - 120) / Math.max(maxX - minX, 1e-3),
    (H - 100) / Math.max(maxY - minY, 1e-3),
  );
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, f: Math.min(f, 2000) };
}

// Zooms by factor around the drawing position (X, Y): the place under it stays where it is.
export function zoomAt(view, X, Y, factor, fit) {
  const f = Math.min(Math.max(view.f * factor, fit.f / 4), 4000),
    wx = view.cx + (X - W / 2) / view.f,
    wy = view.cy - (Y - H / 2) / view.f;
  return { cx: wx - (X - W / 2) / f, cy: wy + (Y - H / 2) / f, f };
}

function draw(svg, pts, view) {
  const X = (x) => W / 2 + (x - view.cx) * view.f,
    Y = (y) => H / 2 - (y - view.cy) * view.f;
  const step = niceStep(80 / view.f),
    left = view.cx - W / 2 / view.f,
    right = view.cx + W / 2 / view.f,
    bottom = view.cy - H / 2 / view.f,
    top = view.cy + H / 2 / view.f;
  const lines = [];
  for (let x = Math.ceil(left / step) * step; x <= right; x += step)
    lines.push(`M${X(x).toFixed(1)} 0V${H}`);
  for (let y = Math.ceil(bottom / step) * step; y <= top; y += step)
    lines.push(`M0 ${Y(y).toFixed(1)}H${W}`);
  const metres = new Intl.NumberFormat(lang, { maximumFractionDigits: 3 }).format(step),
    bar = step * view.f;
  svg.innerHTML =
    `<path d="${lines.join('')}" class="map-grid"/>` +
    `<text x="${W / 2}" y="25" text-anchor="middle" class="map-axis">N</text><text x="${W - 30}" y="${H / 2}" class="map-axis">E</text>` +
    pts
      .map(
        (p) =>
          `<g class="map-mark" data-row="${esc(p.id)}"><circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="5" class="map-point ${p.ok ? 'ok' : 'check'}"><title>${esc(p.name)}: E ${p.x.toFixed(3)}, N ${p.y.toFixed(3)}</title></circle><text x="${(X(p.x) + 9).toFixed(1)}" y="${(Y(p.y) - 4).toFixed(1)}" class="map-label">${esc(p.name)}</text></g>`,
      )
      .join('') +
    `<g class="map-scale"><path d="M20 ${H - 20}h${bar.toFixed(1)}M20 ${H - 26}v12M${(20 + bar).toFixed(1)} ${H - 26}v12"/><text x="20" y="${H - 32}">${metres} m</text></g>`;
}

// Draws the map into svg and wires zooming and moving. onSelect(id) opens a tapped point.
export function attachMap(svg, pts, onSelect) {
  const fit = fitView(pts);
  let view = { ...fit };
  const render = () => draw(svg, pts, view);
  // Screen position → drawing position (the svg keeps its 800 × 480 aspect).
  const local = (clientX, clientY) => {
    const r = svg.getBoundingClientRect(),
      s = Math.min(r.width / W, r.height / H),
      ox = (r.width - W * s) / 2,
      oy = (r.height - H * s) / 2;
    return { X: (clientX - r.left - ox) / s, Y: (clientY - r.top - oy) / s, s };
  };
  const zoom = (factor, X = W / 2, Y = H / 2) => {
    view = zoomAt(view, X, Y, factor, fit);
    render();
  };
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { X, Y } = local(e.clientX, e.clientY);
      zoom(Math.exp(-e.deltaY * 0.0015), X, Y);
    },
    { passive: false },
  );
  // One pointer moves the map, two pinch it; a short tap on a point opens that point.
  const pointers = new Map();
  let moved = 0,
    pinch = null;
  svg.addEventListener('pointerdown', (e) => {
    // Capture keeps the drag going outside the map; a pointer the browser cannot capture still counts.
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = pointers.size > 1 ? 99 : 0;
    pinch = null;
  });
  svg.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, now);
    if (pointers.size === 1) {
      const { s } = local(0, 0);
      moved += Math.abs(now.x - last.x) + Math.abs(now.y - last.y);
      view = {
        ...view,
        cx: view.cx - (now.x - last.x) / s / view.f,
        cy: view.cy + (now.y - last.y) / s / view.f,
      };
      render();
      return;
    }
    const [a, b] = [...pointers.values()],
      distance = Math.hypot(a.x - b.x, a.y - b.y),
      mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (pinch) {
      view = zoomAt(view, mid.X, mid.Y, distance / pinch.distance, fit);
      view = {
        ...view,
        cx: view.cx - (mid.X - pinch.X) / view.f,
        cy: view.cy + (mid.Y - pinch.Y) / view.f,
      };
      render();
    }
    pinch = { distance, X: mid.X, Y: mid.Y };
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
    if (pointers.size === 0 && moved < 6 && e.type === 'pointerup') {
      const mark = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.map-mark');
      if (mark && svg.contains(mark)) onSelect?.(mark.dataset.row);
    }
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('dblclick', (e) => {
    const { X, Y } = local(e.clientX, e.clientY);
    zoom(2, X, Y);
  });
  svg.addEventListener('keydown', (e) => {
    const shift = 60 / view.f;
    const keys = {
      '+': () => zoom(1.5),
      '=': () => zoom(1.5),
      '-': () => zoom(1 / 1.5),
      0: () => ((view = { ...fit }), render()),
      ArrowLeft: () => ((view = { ...view, cx: view.cx - shift }), render()),
      ArrowRight: () => ((view = { ...view, cx: view.cx + shift }), render()),
      ArrowUp: () => ((view = { ...view, cy: view.cy + shift }), render()),
      ArrowDown: () => ((view = { ...view, cy: view.cy - shift }), render()),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  });
  render();
  return {
    zoomIn: () => zoom(1.5),
    zoomOut: () => zoom(1 / 1.5),
    fit: () => {
      view = { ...fit };
      render();
    },
    view: () => ({ ...view }),
  };
}
