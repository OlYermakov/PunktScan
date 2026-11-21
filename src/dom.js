import { t } from './i18n.js?v=__BUILD__';
export const $ = (id) => document.getElementById(id);
export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let toastTimer;
export function toast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4500);
}
export function notice(text = '') {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}
export async function imageFrom(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(t('image.unreadable')));
    im.src = url;
  });
}
export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
export async function pixelsFor(s) {
  const im = await imageFrom(s.image),
    c = canvas(s.width, s.height);
  c.getContext('2d').drawImage(im, 0, 0);
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
}
export function canvasFrom(data) {
  const c = canvas(data.width, data.height);
  c.getContext('2d').putImageData(new ImageData(data.data, data.width, data.height), 0, 0);
  return c;
}
export function download(content, type, name) {
  const blob = content instanceof Blob ? content : new Blob([content], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// System share sheet (iPhone, Android): sends a file straight to mail, AirDrop, Teams, a drive…
// Downloads on iOS end up in the Files app and are easy to lose.
// Whether the browser can send this kind of file. The probe has the real extension and type:
// Chrome and Edge on Windows send .txt and .csv but refuse other extensions such as .GSI, and a
// refused share would only end in a plain download next to the Save button.
export function canShareFiles(name = 'x.txt', type = 'text/plain') {
  try {
    const probe = new File(['x'], name, { type });
    return Boolean(navigator.canShare?.({ files: [probe] }));
  } catch {
    return false;
  }
}

// 'shared', 'cancelled' (the user closed the sheet) or 'failed'.
export async function shareFile(content, type, name) {
  try {
    await navigator.share({ files: [new File([content], name, { type })], title: name });
    return 'shared';
  } catch (e) {
    return e?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}
