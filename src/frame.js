// Dragging the table frame corners with a finger or a mouse.
// - A touch grabs the nearest corner within reach, so the finger does not have to hit a small dot.
// - The corner moves by the finger's movement instead of jumping under it, and a magnifier above
//   the finger shows the corner over the photo, because the finger itself covers that spot.
import { state, source } from './state.js?v=__BUILD__';
import { $ } from './dom.js?v=__BUILD__';
import { save } from './storage.js?v=__BUILD__';
import { snapshot, renderPhoto } from './render.js?v=__BUILD__';

const REACH = { touch: 56, pen: 40, mouse: 24 }; // grab radius in screen pixels
const LOUPE = 128; // magnifier size in CSS pixels
const ZOOM = 3; // magnification relative to the photo as shown

let drag = null;

// Index of the corner nearest to the pointer, if it is within reach.
export function nearestCorner(quad, x, y, width, height, reach) {
  let best = null,
    bestDistance = reach;
  quad.forEach((p, i) => {
    const d = Math.hypot(p.x * width - x, p.y * height - y);
    if (d <= bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

function drawLoupe(clientX, clientY) {
  const s = source(),
    img = $('previewImg'),
    loupe = $('loupe');
  if (!s || !img.naturalWidth) return;
  const dpr = window.devicePixelRatio || 1,
    size = LOUPE * dpr;
  if (loupe.width !== size) loupe.width = loupe.height = size;
  const shown = img.getBoundingClientRect(),
    // Source square (natural image pixels) that maps onto the loupe at ZOOM× the shown size.
    span = LOUPE / ZOOM / (shown.width / img.naturalWidth),
    p = s.quad[drag.corner],
    cx = p.x * img.naturalWidth,
    cy = p.y * img.naturalHeight,
    k = size / span,
    ctx = loupe.getContext('2d');
  ctx.fillStyle = '#e6ebe7';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, cx - span / 2, cy - span / 2, span, span, 0, 0, size, size);
  // Frame edges to the two neighbouring corners, then a cross-hair on the corner itself.
  const at = (q) => [
    (q.x * img.naturalWidth - cx) * k + size / 2,
    (q.y * img.naturalHeight - cy) * k + size / 2,
  ];
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = '#7fbf1f';
  ctx.beginPath();
  for (const q of [s.quad[(drag.corner + 3) % 4], s.quad[(drag.corner + 1) % 4]]) {
    ctx.moveTo(size / 2, size / 2);
    ctx.lineTo(...at(q));
  }
  ctx.stroke();
  ctx.strokeStyle = '#173c2c';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(size / 2, size / 2 - 14 * dpr);
  ctx.lineTo(size / 2, size / 2 + 14 * dpr);
  ctx.moveTo(size / 2 - 14 * dpr, size / 2);
  ctx.lineTo(size / 2 + 14 * dpr, size / 2);
  ctx.stroke();
  // Above the finger; below it when there is no room at the top of the screen.
  const gap = 36,
    top = clientY - gap - LOUPE >= 8 ? clientY - gap - LOUPE : clientY + gap;
  loupe.style.left = Math.min(innerWidth - LOUPE - 8, Math.max(8, clientX - LOUPE / 2)) + 'px';
  loupe.style.top = top + 'px';
  loupe.hidden = false;
}

export function initFrameDrag() {
  const overlay = $('frameOverlay');
  overlay.addEventListener('pointerdown', (e) => {
    const s = source();
    if (state.busy || !s || state.view !== 'frame') return;
    const b = overlay.getBoundingClientRect();
    const handle = e.target.closest('[data-corner]');
    const corner = handle
      ? Number(handle.dataset.corner)
      : nearestCorner(
          s.quad,
          e.clientX - b.left,
          e.clientY - b.top,
          b.width,
          b.height,
          REACH[e.pointerType] ?? REACH.mouse,
        );
    if (corner === null) return;
    e.preventDefault();
    snapshot();
    drag = {
      corner,
      pointer: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      from: { ...s.quad[corner] },
      loupe: e.pointerType !== 'mouse',
    };
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already released pointers cannot be captured; moves still arrive here.
    }
    renderPhoto();
    if (drag.loupe) drawLoupe(e.clientX, e.clientY);
  });
  overlay.addEventListener('pointermove', (e) => {
    const s = source();
    if (!drag || e.pointerId !== drag.pointer || !s) return;
    const b = overlay.getBoundingClientRect();
    // The user's own frame is respected by recognition (no whole-photo second guess).
    s.frameEdited = true;
    s.quad[drag.corner] = {
      x: Math.max(0, Math.min(1, drag.from.x + (e.clientX - drag.startX) / b.width)),
      y: Math.max(0, Math.min(1, drag.from.y + (e.clientY - drag.startY) / b.height)),
    };
    renderPhoto();
    if (drag.loupe) drawLoupe(e.clientX, e.clientY);
  });
  for (const type of ['pointerup', 'pointercancel'])
    overlay.addEventListener(type, (e) => {
      if (!drag || e.pointerId !== drag.pointer) return;
      drag = null;
      $('loupe').hidden = true;
      renderPhoto();
      save();
    });
}

export const activeCorner = () => drag?.corner ?? null;
