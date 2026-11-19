// The guided flow: which step the project is on, the step bar and the phone's next-step button.
import { validate } from './core.js?v=__BUILD__';
import { state, source, ready } from './state.js?v=__BUILD__';
import { $ } from './dom.js?v=__BUILD__';
import { t, tp } from './i18n.js?v=__BUILD__';

// Recognition is a single tap on a checked frame, so it belongs to the frame step.
export const STEPS = ['photo', 'frame', 'review', 'file'];

export function flowStep() {
  const { sources, rows } = state.project,
    s = source();
  if (!sources.length && !rows.length) return 'photo';
  if (state.recognizing) return 'frame';
  if (s && !s.recognized) return 'frame';
  if (!rows.length) return s ? 'frame' : 'photo';
  return ready() ? 'file' : 'review';
}

// The row the review button opens: the first one with an error, else the first unchecked one.
export function nextReviewRow() {
  const values = validate(state.project.rows);
  return (
    values.find((v) => v.issues.length)?.row ?? values.find((v) => !v.row.verified)?.row ?? null
  );
}

export function nextAction() {
  const step = flowStep(),
    s = source(),
    pending = state.project.sources.filter((x) => !x.recognized).length;
  if (step === 'photo') return { step, label: t('flow.addPhoto'), action: 'photo' };
  if (step === 'frame') {
    if (state.recognizing)
      return {
        step,
        label: t('flow.recognizing', { pct: Math.round($('ocrProgress').value * 100) }),
        action: null,
      };
    if (pending > 1)
      return { step, label: t('recog.runAllCount', { n: pending }), action: 'recognizeAll' };
    return {
      step,
      label: t(s?.recognized ? 'recog.rerun' : 'recog.run'),
      action: 'recognize',
    };
  }
  if (step === 'review') {
    const values = validate(state.project.rows),
      left = values.filter((v) => v.issues.length || !v.row.verified).length;
    return { step, label: t('flow.review', { n: left }), action: 'review' };
  }
  return { step, label: t('flow.export'), action: 'export' };
}

export function renderFlow() {
  const next = nextAction(),
    current = STEPS.indexOf(next.step);
  document.body.dataset.step = next.step;
  for (const [i, li] of [...$('flowSteps').children].entries()) {
    li.classList.toggle('done', i < current);
    li.classList.toggle('current', i === current);
    const button = li.querySelector('button');
    if (i === current) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.disabled = i > current;
  }
  $('nextStepCaption').textContent = t('flow.caption', {
    n: current + 1,
    total: STEPS.length,
    // On the last step the caption also says how many points go into the file.
    label:
      next.step === 'file'
        ? t('export.ready', { points: tp('n.points', state.project.rows.length) })
        : t('step.' + next.step),
  });
  $('nextStepBtn').textContent = next.label;
  $('nextStepBtn').dataset.action = next.action ?? '';
  $('nextStepBtn').disabled = !next.action || state.busy;
  // On phones the export bar is hidden, so CSV sits next to GSI on the last step.
  $('nextCsvBtn').hidden = next.step !== 'file';
  $('nextCsvBtn').disabled = state.busy;
}
