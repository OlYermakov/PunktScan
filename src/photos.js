import { MAX_SOURCES, MAX_IMAGE_SIDE } from './core.js?v=__BUILD__';
import { findTable, fullQuad } from './imaging.js?v=__BUILD__';
import { uid, state } from './state.js?v=__BUILD__';
import { $, toast, notice, imageFrom, canvas } from './dom.js?v=__BUILD__';
import { save } from './storage.js?v=__BUILD__';
import { t } from './i18n.js?v=__BUILD__';
import { snapshot, render, setBusy } from './render.js?v=__BUILD__';

export async function addPhotos(files) {
  if (state.busy) return;
  if (state.project.sources.length + files.length > MAX_SOURCES) {
    toast(t('photos.limit', { max: MAX_SOURCES }));
    return;
  }
  snapshot();
  setBusy(true);
  $('progressText').textContent = t('photos.opening');
  notice();
  const failures = [];
  for (const file of files) {
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error(t('photos.tooBig', { name: file.name }));
      if (file.type === 'image/svg+xml') throw new Error(t('photos.svg'));
      const url = URL.createObjectURL(file);
      let im;
      try {
        im = await imageFrom(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (im.width * im.height > 60000000)
        throw new Error(t('photos.tooManyPixels', { name: file.name }));
      const ratio = Math.min(1, MAX_IMAGE_SIDE / Math.max(im.width, im.height)),
        w = Math.round(im.width * ratio),
        h = Math.round(im.height * ratio);
      if (w < 80 || h < 60) throw new Error(t('photos.tooSmall', { name: file.name }));
      const c = canvas(w, h),
        ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(im, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h);
      await new Promise((r) => setTimeout(r, 0));
      const quad = findTable(px.data, w, h) || fullQuad();
      const s = {
        id: uid(),
        name: file.name,
        width: w,
        height: h,
        image: c.toDataURL('image/png'),
        quad,
        order: 'auto',
        enhance: true,
        recognized: false,
      };
      state.project.sources.push(s);
      state.selected = s.id;
    } catch (e) {
      failures.push(e.message);
    }
  }
  setBusy(false);
  state.view = 'frame';
  state.zoom = 1;
  render();
  save();
  if (failures.length) notice(failures.join('\n'));
  $('photoInput').value = '';
}
