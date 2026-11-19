// The guided flow: which step the project is on, the step bar and the phone's next-step button.
import { validate } from './core.js?v=__BUILD__';
import { state, source, ready } from './state.js?v=__BUILD__';
import { $ } from './dom.js?v=__BUILD__';

// Recognition is a single tap on a checked frame, so it belongs to the frame step.
export const STEPS = [
  { id: 'photo', label: 'Фото' },
  { id: 'frame', label: 'Рамка' },
  { id: 'review', label: 'Звіряння' },
  { id: 'file', label: 'Файл' },
];

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
  if (step === 'photo') return { step, label: 'Додати фото', action: 'photo' };
  if (step === 'frame') {
    if (state.recognizing)
      return {
        step,
        label: `Розпізнавання… ${Math.round($('ocrProgress').value * 100)}%`,
        action: null,
      };
    if (pending > 1)
      return { step, label: `Розпізнати нові фото (${pending})`, action: 'recognizeAll' };
    return {
      step,
      label: s?.recognized ? 'Розпізнати повторно' : 'Розпізнати фото',
      action: 'recognize',
    };
  }
  if (step === 'review') {
    const values = validate(state.project.rows),
      left = values.filter((v) => v.issues.length || !v.row.verified).length;
    return { step, label: `Звірити точки · залишилось ${left}`, action: 'review' };
  }
  return { step, label: 'Завантажити GSI', action: 'export' };
}

export function renderFlow() {
  const next = nextAction(),
    current = STEPS.findIndex((x) => x.id === next.step);
  for (const [i, li] of [...$('flowSteps').children].entries()) {
    li.classList.toggle('done', i < current);
    li.classList.toggle('current', i === current);
    const button = li.querySelector('button');
    if (i === current) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.disabled = i > current;
  }
  $('nextStepCaption').textContent =
    `Крок ${current + 1} з ${STEPS.length} · ${STEPS[current].label}`;
  $('nextStepBtn').textContent = next.label;
  $('nextStepBtn').dataset.action = next.action ?? '';
  $('nextStepBtn').disabled = !next.action || state.busy;
}
