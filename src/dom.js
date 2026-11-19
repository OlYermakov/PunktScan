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
    im.onerror = () =>
      reject(
        new Error(
          'Не вдалося прочитати зображення. Для HEIC збережи копію JPG або зроби скриншот.',
        ),
      );
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
