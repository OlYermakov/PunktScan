// End-to-end checks of the built app (dist/) in headless Chromium.
// Run after `npm run build`: `npm run test:e2e`.
// Set E2E_OCR=1 to also run the slower real-OCR check on the test photos in tests/fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import { chromium, devices } from 'playwright';

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let server, browser, base;
test.before(async () => {
  await fs.access('dist/index.html').catch(() => {
    throw new Error('dist/ is missing: run `npm run build` first.');
  });
  const port = await freePort();
  server = spawn(process.execPath, ['scripts/serve.mjs'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('http://') && resolve());
    server.on('exit', (c) => reject(new Error('Server exited: ' + c)));
  });
  base = `http://localhost:${port}/PunktScan/`;
  // PW_CHROMIUM points to a preinstalled browser when it differs from the pinned Playwright build.
  browser = await chromium.launch(
    process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  );
});
test.after(async () => {
  await browser?.close();
  server?.kill();
});

// Records screen wake lock requests and releases in window.__wakeLog.
function stubWakeLock() {
  window.__wakeLog = [];
  Object.defineProperty(navigator, 'wakeLock', {
    value: {
      async request(type) {
        window.__wakeLog.push('request:' + type);
        const lock = new EventTarget();
        lock.release = async () => {
          window.__wakeLog.push('release');
          lock.dispatchEvent(new Event('release'));
        };
        return lock;
      },
    },
  });
}

async function openApp(options = {}) {
  const context = await browser.newContext({ acceptDownloads: true, ...options.context });
  if (options.init) await context.addInitScript(...[options.init].flat());
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push('console: ' + m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(r.status() + ' ' + r.url());
  });
  await page.goto(base);
  await page.locator('#emptyState').waitFor();
  return { context, page, problems };
}

// Opens "Paste text": in the sidebar on desktops, in the ⋯ menu on phones.
async function openPaste(page) {
  if (await page.locator('#pasteBtn').isVisible()) await page.locator('#pasteBtn').click();
  else {
    await page.locator('#moreBtn').click();
    await page.locator('#moreMenu [data-proxy="pasteBtn"]').click();
  }
}

// Adds the two test tables (tests/fixtures) through the regular file input.
async function addTestPhotos(page) {
  await page
    .locator('#photoInput')
    .setInputFiles(['tests/fixtures/table-1.jpg', 'tests/fixtures/table-2.jpg']);
  await page.locator('#sourceCount', { hasText: '2' }).waitFor();
}

// Confirms every point: card by card, or all at once on the "remaining points" screen.
async function verifyAll(page, count) {
  await page.locator('[data-review]').first().click();
  for (let i = 0; i < count; i++) {
    if (!(await page.locator('#dialog').isVisible())) break;
    if (await page.locator('#verifyAllBtn').isVisible()) {
      await page.locator('#verifyAllBtn').click();
      break;
    }
    const button = page.locator('#verifyNextBtn');
    await assert.doesNotReject(button.waitFor(), 'review dialog for point ' + (i + 1));
    assert.equal(await button.isDisabled(), false, 'point ' + (i + 1) + ' has validation errors');
    await button.click();
  }
  await page.locator('#dialog').waitFor({ state: 'hidden' });
}

async function downloadGsi(page) {
  await page.locator('#exportBtn:not([disabled])').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#confirmExport').click(),
  ]);
  assert.match(download.suggestedFilename(), /\.GSI$/);
  return fs.readFile(await download.path(), 'latin1');
}

test('app loads under /PunktScan/ without errors and registers the service worker', async () => {
  const { context, page, problems } = await openApp();
  assert.equal(await page.title(), 'PunktScan — Foto zu GSI');
  assert.equal(await page.locator('html').getAttribute('lang'), 'de');
  await page.evaluate(() => navigator.serviceWorker.ready);
  assert.equal(await page.locator('#exportBtn').isDisabled(), true);
  assert.deepEqual(problems, []);
  await context.close();
});

test('pasted reference table → review every point → GSI matches the reference file', async () => {
  const { context, page, problems } = await openApp();
  const reference = await fs.readFile('examples/test-reference.GSI', 'latin1');
  const table = (await fs.readFile('examples/test-points.csv', 'utf8')).replace(/^\ufeff/, '');
  const count = reference.trimEnd().split('\r\n').length;

  await openPaste(page);
  await page.locator('#pasteText').fill(table);
  await page.locator('#pasteApply').click();
  await assert.doesNotReject(page.locator('#pointCount', { hasText: String(count) }).waitFor());
  assert.equal(
    await page.locator('#exportBtn').isDisabled(),
    true,
    'export must stay blocked before review',
  );

  await verifyAll(page, count);
  assert.equal(await downloadGsi(page), reference);

  // Editing a reviewed point must revoke its review and block export again.
  await page.locator('#pointsBody input[data-field="e"]').first().fill('3500030.211');
  assert.equal(await page.locator('#exportBtn').isDisabled(), true);
  assert.deepEqual(problems, []);
  await context.close();
});

test(
  'real OCR on the test photos finds all 14 rows',
  { skip: !process.env.E2E_OCR && 'set E2E_OCR=1 to run', timeout: 300000 },
  async () => {
    const { context, page, problems } = await openApp({ init: stubWakeLock });
    await addTestPhotos(page);
    await page.locator('#recognizeAllBtn').click();
    await page.locator('#awakeHint').waitFor();
    assert.match(await page.locator('#nextStepBtn').textContent(), /^Erkennung… \d+ %$/);
    assert.equal(await page.locator('#nextStepBtn').isDisabled(), true);
    await page.locator('#progressArea').waitFor({ state: 'hidden', timeout: 280000 });
    assert.equal(await page.locator('#pointsBody tr[data-row]').count(), 14);
    // The screen was kept awake during recognition and released afterwards.
    assert.deepEqual(await page.evaluate(() => window.__wakeLog), ['request:screen', 'release']);
    assert.equal(await page.locator('#awakeHint').isHidden(), true);

    // Review shows the photo cell of each field, not just the whole row.
    await page.locator('[data-review]').first().click();
    const crops = page.locator('canvas[data-crop-field]');
    await crops.first().waitFor();
    assert.deepEqual(await crops.evaluateAll((list) => list.map((c) => c.dataset.cropField)), [
      'name',
      'e',
      'n',
    ]);
    const sizes = await crops.evaluateAll((list) => list.map((c) => [c.width, c.height]));
    const row = await page.locator('#reviewCrop').evaluate((c) => c.width);
    for (const [w, h] of sizes) assert.ok(w > 20 && h >= 20 && w < row / 2, `cell ${w}×${h}`);
    assert.deepEqual(problems, []);
    await context.close();
  },
);

test('photo cards are keyboard buttons and the remove button is separate', async () => {
  const { context, page, problems } = await openApp();
  await addTestPhotos(page);
  const cards = page.locator('button.source-select');
  assert.equal(await cards.count(), 2);
  assert.equal(await page.locator('[role="button"][data-source]').count(), 0);
  await cards.first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await cards.first().getAttribute('aria-current'), 'true');
  assert.equal(await cards.nth(1).getAttribute('aria-current'), 'false');
  await page.locator('.source-remove').first().click();
  await page.locator('#sourceCount', { hasText: '1' }).waitFor();
  assert.deepEqual(problems, []);
  await context.close();
});

test('draft survives a reload; an opened project file must be reviewed again', async () => {
  const { context, page, problems } = await openApp();
  await openPaste(page);
  await page.locator('#pasteText').fill('P1;10.000;20.000;\nP2;11.000;21.000;5.5');
  await page.locator('#pasteApply').click();
  await verifyAll(page, 2);
  await page.locator('#saveState', { hasText: 'Entwurf gespeichert' }).waitFor();
  await page.reload();
  await page.locator('#pointCount', { hasText: '2' }).waitFor();
  assert.equal(await page.locator('#exportBtn').isDisabled(), false, 'review state restored');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#saveProjectBtn').click(),
  ]);
  page.once('dialog', (d) => d.accept());
  await page.locator('#projectInput').setInputFiles(await download.path());
  await page.locator('#notice', { hasText: 'Projekt geöffnet' }).waitFor();
  assert.equal(await page.locator('#pointCount').textContent(), '2');
  assert.equal(await page.locator('#exportBtn').isDisabled(), true, 'imported points need review');
  assert.deepEqual(problems, []);
  await context.close();
});

test('a new deployment shows the update banner instead of switching silently', async () => {
  const { context, page, problems } = await openApp();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r));
  });
  // The first install claims the page: that must not count as an update.
  await page.reload();
  assert.equal(await page.locator('#updateBar').isHidden(), true);
  const sw = await fs.readFile('dist/sw.js', 'utf8');
  try {
    await fs.writeFile('dist/sw.js', sw.replace(/punktscan-shell-\w+/, 'punktscan-shell-next'));
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.locator('#updateBar').waitFor();
    await Promise.all([page.waitForEvent('load'), page.locator('#updateBtn').click()]);
    assert.equal(await page.locator('#updateBar').isHidden(), true);
  } finally {
    await fs.writeFile('dist/sw.js', sw);
  }
  assert.deepEqual(problems, []);
  await context.close();
});

test('a page that already runs the new version does not offer the update again', async () => {
  const { context, page, problems } = await openApp();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r));
  });
  await page.reload();
  const sw = await fs.readFile('dist/sw.js', 'utf8');
  try {
    // A new worker of the same version as the page (the page loaded the new HTML, the new
    // worker installs after it): it takes over, but there is nothing to update.
    await fs.writeFile('dist/sw.js', sw + '\n// same version, new worker\n');
    await page.evaluate(async () => {
      const changed = new Promise((r) =>
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }),
      );
      await (await navigator.serviceWorker.getRegistration()).update();
      await changed;
    });
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#updateBar').isHidden(), true);
  } finally {
    await fs.writeFile('dist/sw.js', sw);
  }
  assert.deepEqual(problems, []);
  await context.close();
});

test('on a phone every point is a card with E, N and H visible without sideways scrolling', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  await openPaste(page);
  await page.locator('#pasteText').fill('Af201;3500030.210;5600557.311;101.25');
  await page.locator('#pasteApply').click();
  const scroll = await page
    .locator('.table-scroll')
    .evaluate((el) => [el.scrollWidth, el.clientWidth]);
  assert.ok(scroll[0] <= scroll[1], `table overflows: ${scroll}`);
  const width = page.viewportSize().width;
  for (const field of ['name', 'e', 'n', 'h']) {
    const box = await page.locator(`#pointsBody input[data-field="${field}"]`).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, `${field} is off-screen`);
  }
  for (const button of ['.review-btn', '.delete-row']) {
    const box = await page.locator(button).boundingBox();
    assert.ok(box.width >= 40 && box.height >= 40, `${button} is ${box.width}×${box.height}`);
  }
  assert.deepEqual(problems, []);
  await context.close();
});

test('the ± button flips the sign on touch screens, where the keypad has no minus', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  await openPaste(page);
  await page.locator('#pasteText').fill('P1;10.000;20.000;5.000');
  await page.locator('#pasteApply').click();
  await page.locator('[data-review]').first().click();
  await page.locator('#reviewEditBtn').click();
  for (const field of ['e', 'n', 'h']) {
    const sign = page.locator(`.sign-btn[data-sign="${field}"]`);
    await sign.click();
    assert.match(await page.locator('#review-' + field).inputValue(), /^-\d/);
    await sign.click();
    assert.match(await page.locator('#review-' + field).inputValue(), /^\d/);
  }
  await page.locator('.sign-btn[data-sign="h"]').click();
  await page.locator('#verifyNextBtn').click();
  assert.equal(await page.locator('#pointsBody input[data-field="h"]').inputValue(), '-5.000');
  assert.deepEqual(problems, []);
  await context.close();
});

test('the ± button is hidden with a mouse, where the keyboard has a minus key', async () => {
  const { context, page } = await openApp();
  await openPaste(page);
  await page.locator('#pasteText').fill('P1;10.000;20.000');
  await page.locator('#pasteApply').click();
  await page.locator('[data-review]').first().click();
  await page.locator('#reviewEditBtn').click();
  await page.locator('#review-e').waitFor();
  assert.equal(await page.locator('.sign-btn[data-sign="e"]').isHidden(), true);
  await context.close();
});

test('on a phone the bottom button walks through every step to the GSI file', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  const caption = page.locator('#nextStepCaption'),
    next = page.locator('#nextStepBtn');
  assert.equal(await page.locator('#nextStepBar').isVisible(), true);
  assert.equal(await caption.textContent(), 'Schritt 1 von 4 · Foto');
  assert.equal(await next.textContent(), 'Foto hinzufügen');
  // Rarely used actions live in the ⋯ menu on phones.
  assert.equal(await page.locator('#saveProjectBtn').isVisible(), false);
  await page.locator('#moreBtn').click();
  await page.locator('#moreMenu [data-proxy="pasteBtn"]').click();
  assert.equal(await page.locator('#moreMenu').isHidden(), true);
  await page.locator('#pasteText').fill('A;1.000;2.000\nB;x;2.000');
  await page.locator('#pasteApply').click();
  assert.equal(await caption.textContent(), 'Schritt 3 von 4 · Prüfung');
  assert.equal(await next.textContent(), 'Punkte prüfen · noch 2');
  // Rows with errors come first.
  await next.click();
  assert.equal(await page.locator('#review-name').inputValue(), 'B');
  await page.locator('#review-e').fill('3.000');
  assert.equal(await page.locator('#verifyNextBtn').textContent(), 'Geprüft · weiter');
  await page.locator('#verifyNextBtn').click();
  // The dialog moves on to the point that still needs checking, then closes after the last one.
  // A has no errors: it opens as a card to confirm, with its values shown large.
  assert.equal(await page.locator('[data-value-field="name"]').textContent(), 'A');
  assert.equal(await page.locator('#verifyNextBtn').textContent(), '✓ Richtig');
  await page.locator('#verifyNextBtn').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(await caption.textContent(), 'Schritt 4 von 4 · Bereit für den Export: 2 Punkte');
  assert.equal(
    await page.locator('#flowSteps .done').count(),
    3,
    'earlier steps are marked as done',
  );
  // Exactly one GSI download button on the phone, with CSV next to it.
  assert.equal(await page.locator('#exportBar').isVisible(), false);
  assert.equal(
    await page
      .locator('#exportBtn, #nextStepBtn')
      .evaluateAll((list) => list.filter((el) => el.checkVisibility()).length),
    1,
  );
  await page.locator('#nextCsvBtn').click();
  assert.equal(await page.locator('#confirmExport').getAttribute('data-format'), 'CSV');
  await page.locator('#dialog [data-close]').first().click();
  await next.click();
  assert.equal(await page.locator('#confirmExport').getAttribute('data-format'), 'GSI');
  assert.deepEqual(problems, []);
  await context.close();
});

test('on a desktop the step bar is shown without the phone-only bottom bar and menu', async () => {
  const { context, page, problems } = await openApp();
  assert.equal(await page.locator('#flowSteps').isVisible(), true);
  assert.equal(await page.locator('#nextStepBar').isVisible(), false);
  assert.equal(await page.locator('#moreBtn').isVisible(), false);
  assert.equal(await page.locator('#saveProjectBtn').isVisible(), true);
  assert.equal(
    (await page.locator('#flowSteps [aria-current="step"]').textContent()).replace(/\s+/g, ''),
    '1Foto',
  );
  assert.deepEqual(problems, []);
  await context.close();
});

test('German by default; switching the language translates the app and is remembered', async () => {
  const { context, page, problems } = await openApp();
  assert.equal(await page.locator('#langSelect').inputValue(), 'de');
  assert.equal(await page.locator('#helpBtn .help-text').textContent(), 'Anleitung');
  assert.equal(await page.locator('#langSelect option').count(), 7);
  // Unfinished work survives the reload that applies the language.
  await openPaste(page);
  await page.locator('#pasteText').fill('P1;10.000;20.000');
  await page.locator('#pasteApply').click();
  for (const [code, help, html] of [
    ['en', 'Guide', 'en'],
    ['pl', 'Instrukcja', 'pl'],
    ['uk', 'Інструкція', 'uk'],
  ]) {
    await Promise.all([page.waitForEvent('load'), page.locator('#langSelect').selectOption(code)]);
    await page.locator('#helpBtn .help-text', { hasText: help }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), html);
    assert.equal(await page.locator('#pointCount').textContent(), '1', 'draft kept');
  }
  await page.reload();
  // The draft is read from IndexedDB after the page appears.
  await page.locator('#pointCount', { hasText: '1' }).waitFor();
  assert.equal(await page.locator('#langSelect').inputValue(), 'uk', 'choice remembered');
  assert.equal(await page.locator('#exportStatus').textContent(), 'Залишилося звірити: 1');
  // Plural forms follow the language (Ukrainian: 1 точка, 2 точки, 5 точок).
  await openPaste(page);
  await page
    .locator('#pasteText')
    .fill('P2;11.000;21.000\nP3;12.000;22.000\nP4;13.000;23.000\nP5;14.000;24.000');
  await page.locator('#pasteApply').click();
  await verifyAll(page, 5);
  assert.equal(await page.locator('#exportStatus').textContent(), 'Готово до експорту: 5 точок');
  assert.deepEqual(problems, []);
  await context.close();
});

test('only one "add photo" button is offered at a time', async () => {
  const visible = (page) =>
    page
      .locator('#uploadBtn, #nextStepBtn[data-action="photo"]')
      .evaluateAll((list) => list.filter((el) => el.checkVisibility()).length);
  const desktop = await openApp();
  assert.equal(await visible(desktop.page), 1);
  assert.equal(await desktop.page.locator('#demoBtn, #startBtn').count(), 0);
  await desktop.context.close();
  const phone = await openApp({ context: devices['iPhone 13'] });
  assert.equal(await visible(phone.page), 1);
  assert.equal(await phone.page.locator('#nextStepBtn').isVisible(), true);
  // After the first photo the bottom button moves on and the sidebar offers adding more.
  await addTestPhotos(phone.page);
  assert.equal(await phone.page.locator('#uploadBtn').isVisible(), true);
  assert.notEqual(await phone.page.locator('#nextStepBtn').getAttribute('data-action'), 'photo');
  await phone.context.close();
});

test('every language fits a 320 px phone without sideways scrolling', async () => {
  for (const code of ['de', 'en', 'fr', 'it', 'es', 'pl', 'uk']) {
    const { context, page, problems } = await openApp({
      context: devices['iPhone SE'],
      init: [(l) => localStorage.setItem('punktscan-lang', l), code],
    });
    await addTestPhotos(page);
    await page.evaluate(() => scrollTo(0, 0));
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 320, `${code}: page is ${width}px wide`);
    assert.deepEqual(problems, [], code);
    await context.close();
  }
});

test('the CSV button in the bottom bar appears only on the file step', async () => {
  const { context, page } = await openApp({ context: devices['iPhone 13'] });
  assert.equal(await page.locator('#nextCsvBtn').isVisible(), false);
  await page.locator('#moreBtn').click();
  await page.locator('#moreMenu [data-proxy="pasteBtn"]').click();
  await page.locator('#pasteText').fill('P1;10.000;20.000');
  await page.locator('#pasteApply').click();
  assert.equal(await page.locator('#nextCsvBtn').isVisible(), false, 'not before review');
  await verifyAll(page, 1);
  assert.equal(await page.locator('#nextCsvBtn').isVisible(), true);
  await context.close();
});

test('on a phone paste and open project are offered once, in the ⋯ menu', async () => {
  const { context, page } = await openApp({ context: devices['iPhone 13'] });
  assert.equal(await page.locator('#pasteBtn').isVisible(), false);
  assert.equal(await page.locator('#openProjectBtn').isVisible(), false);
  await page.locator('#moreBtn').click();
  for (const proxy of ['pasteBtn', 'openProjectBtn', 'saveProjectBtn', 'newProjectBtn'])
    assert.equal(await page.locator(`#moreMenu [data-proxy="${proxy}"]`).isVisible(), true);
  await context.close();
  const desktop = await openApp();
  assert.equal(await desktop.page.locator('#pasteBtn').isVisible(), true);
  assert.equal(await desktop.page.locator('#openProjectBtn').isVisible(), true);
  await desktop.context.close();
});

test('a finger near a frame corner drags it by its movement and shows a magnifier', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  await addTestPhotos(page);
  await page.locator('#frameOverlay ellipse[data-corner="0"]').waitFor();
  const corner = () =>
    page
      .locator('#frameOverlay ellipse[data-corner="0"]')
      .evaluate((el) => [Number(el.getAttribute('cx')), Number(el.getAttribute('cy'))]);
  const touch = (type, x, y) =>
    page.locator('#frameOverlay').evaluate(
      (el, [type, x, y]) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            clientX: x,
            clientY: y,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      [type, x, y],
    );
  const box = await page.locator('#frameOverlay').boundingBox();
  const [cx, cy] = await corner();
  const x = box.x + (cx / 1000) * box.width,
    y = box.y + (cy / 1000) * box.height;
  // The handle is drawn at a finger-friendly size.
  const handle = await page.locator('#frameOverlay ellipse[data-corner="0"]').boundingBox();
  assert.ok(handle.width >= 20, `handle is ${handle.width}px`);

  // Start 25 px away from the corner: still grabs it, and it does not jump under the finger.
  await touch('pointerdown', x + 18, y + 18);
  assert.deepEqual(await corner(), [cx, cy]);
  assert.equal(await page.locator('#loupe').isVisible(), true, 'magnifier shown');
  await touch('pointermove', x + 18 + 30, y + 18 + 20);
  const [mx, my] = await corner();
  assert.ok(Math.abs(mx - cx - (30 / box.width) * 1000) < 1, `moved x to ${mx}`);
  assert.ok(Math.abs(my - cy - (20 / box.height) * 1000) < 1, `moved y to ${my}`);
  await touch('pointerup', x + 48, y + 38);
  assert.equal(await page.locator('#loupe').isVisible(), false, 'magnifier hidden');

  // A touch in the middle of the photo, far from every corner, changes nothing.
  await touch('pointerdown', box.x + box.width / 2, box.y + box.height / 2);
  await touch('pointermove', box.x + box.width / 2 + 40, box.y + box.height / 2 + 40);
  await touch('pointerup', box.x + box.width / 2 + 40, box.y + box.height / 2 + 40);
  assert.deepEqual(await corner(), [mx, my]);
  assert.equal(await page.locator('#loupe').isVisible(), false);
  assert.deepEqual(problems, []);
  await context.close();
});

test(
  'a table without outer borders and with a box around every value is read',
  { skip: !process.env.E2E_OCR && 'set E2E_OCR=1 to run', timeout: 300000 },
  async () => {
    const { context, page, problems } = await openApp();
    const rows = [
      ['R-09-01', '3423197.856', '5538496.915'],
      ['R-09-02', '3423203.055', '5538498.482'],
      ['R-09-03', '3423198.026', '5538496.339'],
      ['R-09-04', '3423198.600', '5538496.512'],
      ['R-09-05', '3423203.231', '5538497.909'],
      ['R-09-06', '3423201.292', '5538494.817'],
    ];
    // Draw a CAD-style table: only inner column lines and row lines, every value boxed.
    const png = await page.evaluate((rows) => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 80 * rows.length + 20;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = '#000';
      g.fillStyle = '#000';
      g.font = '34px "DejaVu Sans Mono", monospace';
      g.lineWidth = 2;
      for (const x of [360, 800]) g.strokeRect(x, 0, 0, c.height);
      rows.forEach((row, i) => {
        const y = 10 + i * 80;
        g.strokeRect(0, y + 78, c.width, 0);
        row.forEach((text, k) => {
          const width = g.measureText(text).width,
            x = [180, 580, 1000][k] - width / 2;
          g.fillText(text, x, y + 52);
          g.strokeRect(x - 6, y + 16, width + 12, 46);
        });
      });
      return c.toDataURL('image/png').split(',')[1];
    }, rows);
    await page.locator('#photoInput').setInputFiles({
      name: 'boxed.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await page.locator('#sourceCount', { hasText: '1' }).waitFor();
    await page.locator('#recognizeBtn').click();
    await page.locator('#progressArea').waitFor({ state: 'hidden', timeout: 280000 });
    const read = await page
      .locator('#pointsBody tr[data-row]')
      .evaluateAll((trs) =>
        trs.map((tr) =>
          ['name', 'e', 'n'].map((k) => tr.querySelector(`[data-field="${k}"]`).value),
        ),
      );
    const exact = rows.filter((row) => read.some((r) => r.join() === row.join())).length;
    assert.ok(exact >= 5, `only ${exact}/6 rows read exactly: ${JSON.stringify(read)}`);
    assert.deepEqual(problems, []);
    await context.close();
  },
);

// Real photos from the field (tests/fixtures/real): screens photographed at an angle or close up
// with strong moiré, CAD tables with a box around every value and 4 decimals, and a folded
// paper sheet outdoors.
test(
  'real field photos: no wrong value goes unflagged, and accuracy does not regress',
  { skip: !process.env.E2E_OCR && 'set E2E_OCR=1 to run', timeout: 600000 },
  async () => {
    const dir = 'tests/fixtures/real/';
    const expected = JSON.parse(await fs.readFile(dir + 'expected.json', 'utf8'));
    let total = 0,
      correct = 0;
    const silent = [],
      report = [],
      notices = {};
    for (const [file, rows] of Object.entries(expected)) {
      const { context, page, problems } = await openApp();
      await page.locator('#photoInput').setInputFiles(dir + file);
      await page.locator('#sourceCount', { hasText: '1' }).waitFor();
      await page.locator('#recognizeBtn').click();
      await page.locator('#progressArea').waitFor({ state: 'hidden', timeout: 280000 });
      const read = await page.locator('#pointsBody tr[data-row]').evaluateAll((trs) =>
        trs.map((tr) =>
          ['name', 'e', 'n', 'h'].map((k) => {
            const input = tr.querySelector(`[data-field="${k}"]`);
            return {
              value: input.value.replace(/\s/g, '').replace(/^\+/, '').replace(',', '.'),
              flagged: input.matches('.invalid, .uncertain'),
            };
          }),
        ),
      );
      let ok = 0;
      rows.forEach((want, i) => {
        const got = read.find((r) => r[0].value.toLowerCase() === want[0].toLowerCase()) ?? read[i];
        want.forEach((value, k) => {
          total++;
          if (got?.[k].value === value) ok++;
          else if (got && !got[k].flagged)
            silent.push(`${file} ${want[0]}: ${got[k].value} ≠ ${value}`);
        });
      });
      correct += ok;
      notices[file] = (await page.locator('#notice').textContent()) ?? '';
      report.push(
        `${file}: ${read.length}/${rows.length} rows, ${ok}/${rows.flat().length} fields`,
      );
      assert.equal(read.length, rows.length, `${file}: row count`);
      assert.deepEqual(problems, [], file);
      await context.close();
    }
    console.log(report.join('\n') + `\nTOTAL ${correct}/${total}`);
    // The safety property: a value read wrongly is always marked for review.
    assert.deepEqual(silent, []);
    // 335/337 with the second recogniser; allow small differences between browser builds.
    assert.ok(correct >= 325, `accuracy regressed: ${correct}/${total}`);
    // The second recogniser (PaddleOCR) ran on every photo and reported how many values agreed.
    for (const [file, text] of Object.entries(notices))
      assert.match(text, /Zweite Erkennung: \d+ von \d+ Werten gleich gelesen/, file);
    // Headings "Hoch | Rechts" over Rechtswert | Hochwert values: order taken from the values,
    // and the user is told (the values themselves are checked above).
    assert.match(
      notices['digital-swapped-headings.jpg'],
      /Überschriften passen nicht zu den Werten/,
    );

    // A close-up of one number column: no invented points, a clear explanation instead.
    const { context, page } = await openApp();
    await page.locator('#photoInput').setInputFiles(dir + 'closeup-one-column.jpg');
    await page.locator('#sourceCount', { hasText: '1' }).waitFor();
    await page.locator('#recognizeBtn').click();
    await page.locator('#progressArea').waitFor({ state: 'hidden', timeout: 280000 });
    assert.equal(await page.locator('#pointsBody tr[data-row]').count(), 0);
    assert.match(await page.locator('#notice').textContent(), /Nur eine Zahlenspalte/);
    await context.close();
  },
);

test('review cards: doubtful points first, marked characters, swipes and confirming the rest at once', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  const point = (name, e, n, extra = {}) => ({ id: name, name, e, n, h: '', ...extra });
  const project = {
    format: 'PunktScan',
    version: 1,
    name: 'Karten',
    sources: [],
    rows: [
      point('A', '3439861.598', '5544885.470'),
      // Recognition was unsure about one digit of B's Rechtswert.
      point('B', '3439860.465', '5544883.242', {
        disputed: [false, true, false, false],
        uncertainChars: [[], [8], [], []],
      }),
      point('C', '3439858.236', '5544884.375'),
      point('D', '3439859.370', '5544886.604'),
    ],
  };
  await page.locator('#projectInput').setInputFiles({
    name: 'karten.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.locator('#pointCount', { hasText: '4' }).waitFor();
  const swipe = (dx) =>
    page.locator('#reviewCard').evaluate((card, dx) => {
      const ev = (type, x) =>
        card.dispatchEvent(
          new PointerEvent(type, {
            clientX: x,
            clientY: 300,
            pointerId: 9,
            pointerType: 'touch',
            isPrimary: true,
            bubbles: true,
          }),
        );
      ev('pointerdown', 150);
      ev('pointermove', 150 + dx / 2);
      ev('pointermove', 150 + dx);
      ev('pointerup', 150 + dx);
    }, dx);

  // The doubtful point comes first, with the doubtful digit marked.
  await page.locator('#nextStepBtn').click();
  assert.equal(await page.locator('[data-value-field="name"]').textContent(), 'B');
  assert.equal(await page.locator('[data-value-field="e"] mark').textContent(), '4');
  // Swipe left: later. Only confident points are left, so they are shown together.
  await swipe(-160);
  await page.locator('#verifyAllBtn').waitFor();
  assert.equal(await page.locator('.bulk-item').count(), 3);
  assert.match(await page.locator('#verifyAllBtn').textContent(), /3/);
  await page.locator('#verifyAllBtn').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#nextStepBtn').textContent(), 'Punkte prüfen · noch 1');
  // B again; swipe right confirms it.
  await page.locator('#nextStepBtn').click();
  assert.equal(await page.locator('[data-value-field="name"]').textContent(), 'B');
  await swipe(160);
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('#nextStepCaption').textContent(),
    'Schritt 4 von 4 · Bereit für den Export: 4 Punkte',
  );
  assert.deepEqual(problems, []);
  await context.close();
});

// Fake share sheet: records shared files; window.__shareMode = 'ok' | 'cancel' | 'fail'.
function stubShare() {
  window.__shared = [];
  window.__shareMode = 'ok';
  // Navigator's own properties cannot simply be assigned in Chromium.
  const define = (name, value) =>
    Object.defineProperty(navigator, name, { value, configurable: true });
  define('canShare', (data) => Array.isArray(data?.files));
  define('share', async (data) => {
    if (window.__shareMode === 'cancel') throw new DOMException('closed', 'AbortError');
    if (window.__shareMode === 'fail') throw new DOMException('not allowed', 'NotAllowedError');
    for (const f of data.files)
      window.__shared.push({ name: f.name, type: f.type, text: await f.text() });
  });
}

test('export through the share sheet: sent, cancelled, or saved when sending fails', async () => {
  const { context, page, problems } = await openApp({ init: stubShare });
  const reference = await fs.readFile('examples/test-reference.GSI', 'latin1');
  const table = (await fs.readFile('examples/test-points.csv', 'utf8')).replace(/^\ufeff/, '');
  await openPaste(page);
  await page.locator('#pasteText').fill(table);
  await page.locator('#pasteApply').click();
  await verifyAll(page, 14);

  // Cancelled: the export dialog stays open.
  await page.evaluate(() => (window.__shareMode = 'cancel'));
  await page.locator('#exportBtn').click();
  await page.locator('#exportName').fill('Absteckung');
  await page.locator('#shareExport').click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#dialog').isVisible(), true);

  // Sent: the GSI file goes to the share sheet with the exact content.
  await page.evaluate(() => (window.__shareMode = 'ok'));
  await page.locator('#shareExport').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  const [shared] = await page.evaluate(() => window.__shared);
  assert.equal(shared.name, 'Absteckung.GSI');
  assert.equal(shared.text, reference);
  await page.locator('#toast', { hasText: 'übergeben' }).waitFor();

  // Sharing refused by the browser: the file is saved the usual way instead.
  await page.evaluate(() => (window.__shareMode = 'fail'));
  await page.locator('#csvBtn').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#shareExport').click(),
  ]);
  assert.match(download.suggestedFilename(), /\.CSV$/);
  await page.locator('#toast', { hasText: 'gespeichert' }).waitFor();
  assert.deepEqual(problems, []);
  await context.close();
});

test('without a share sheet the export dialog only offers saving', async () => {
  const { context, page } = await openApp({
    init: () =>
      Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }),
  });
  await openPaste(page);
  await page.locator('#pasteText').fill('P1;10.000;20.000');
  await page.locator('#pasteApply').click();
  await verifyAll(page, 1);
  await page.locator('#exportBtn').click();
  await page.locator('#confirmExport').waitFor();
  assert.equal(await page.locator('#shareExport').count(), 0);
  await context.close();
});

test('recognition settings stay folded and a phone shows only the photo screen before recognition', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  await page.locator('#photoInput').setInputFiles(['tests/fixtures/table-1.jpg']);
  await page.locator('#imageWorkspace:not([hidden])').waitFor();
  assert.equal(await page.locator('#advancedSettings').evaluate((d) => d.open), false);
  assert.equal(await page.locator('#columnOrder').isVisible(), false);
  assert.equal(await page.locator('body').getAttribute('data-screen'), 'photo');
  assert.equal(await page.locator('#pointsSection').isVisible(), false);
  assert.equal(await page.locator('#recognizeBtn').isVisible(), true);
  // The result view needs a recognised photo.
  assert.equal(await page.locator('#viewTabs [data-view="result"]').isDisabled(), true);
  assert.deepEqual(problems, []);
  await context.close();
});

test(
  'the result is drawn over the photo: tapping a value opens its card, screens and hover link both',
  { skip: !process.env.E2E_OCR && 'set E2E_OCR=1 to run', timeout: 600000 },
  async () => {
    const photo = 'tests/fixtures/real/cad-boxed-13.jpg';
    // Phone: one screen at a time.
    {
      const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
      await page.locator('#photoInput').setInputFiles([photo]);
      await page.locator('#imageWorkspace:not([hidden])').waitFor();
      await page.locator('#nextStepBtn').click();
      await page.locator('body[data-step="review"]').waitFor({ timeout: 280000 });
      const cells = page.locator('#resultOverlay polygon');
      assert.ok((await cells.count()) >= 30, 'a box per recognised value');
      const classes = await cells.evaluateAll((list) => list.map((p) => p.getAttribute('class')));
      assert.ok(
        classes.every((c) => /^cell-(ok|check|error|verified)$/.test(c)),
        classes.join(),
      );
      assert.equal(await page.locator('#frameOverlay').isVisible(), false);
      assert.equal(await page.locator('body').getAttribute('data-screen'), 'review');
      assert.equal(await page.locator('.recognition-panel').isVisible(), false);
      assert.equal(await page.locator('#pointsSection').isVisible(), true);
      // The step bar goes back to the photo screen, where the table is hidden.
      await page.locator('#flowSteps li:nth-child(1) button').click();
      assert.equal(await page.locator('body').getAttribute('data-screen'), 'photo');
      assert.equal(await page.locator('#pointsSection').isVisible(), false);
      assert.equal(await page.locator('#resultOverlay').isVisible(), true);
      // Tapping a value opens that point's review card.
      const target = cells.nth(1),
        id = await target.getAttribute('data-row');
      const name = await page
        .locator(`#pointsBody tr[data-row="${id}"] [data-field="name"]`)
        .inputValue();
      await target.click({ force: true });
      await page.locator('#dialog').waitFor();
      assert.equal(await page.locator('[data-value-field="name"]').textContent(), name);
      assert.deepEqual(problems, []);
      await context.close();
    }
    // Desktop: photo and table side by side, a table row highlights its cells on the photo.
    {
      const { context, page, problems } = await openApp({
        context: { viewport: { width: 1440, height: 900 } },
      });
      await page.locator('#photoInput').setInputFiles([photo]);
      await page.locator('#recognizeBtn').click();
      await page.locator('body[data-step="review"]').waitFor({ timeout: 280000 });
      const photoBox = await page.locator('#imageWorkspace').boundingBox(),
        tableBox = await page.locator('#pointsSection').boundingBox();
      assert.ok(tableBox.x > photoBox.x + photoBox.width - 1, 'table to the right of the photo');
      assert.ok(tableBox.y < photoBox.y + photoBox.height, 'side by side, not stacked');
      const row = page.locator('#pointsBody tr[data-row]').nth(2);
      await row.hover();
      const id = await row.getAttribute('data-row');
      const lit = await page
        .locator('#resultOverlay polygon.hover')
        .evaluateAll((list) => list.map((p) => p.getAttribute('data-row')));
      assert.ok(lit.length >= 1 && lit.every((x) => x === id), JSON.stringify(lit));
      // With the settings open the photo column is taller than the window: while it stays in
      // view it never covers the export bar or the note, which follow the table directly.
      await page.evaluate(() => {
        document.getElementById('advancedSettings').open = true;
      });
      for (const y of [0, 400, 100000]) {
        await page.evaluate((y) => window.scrollTo(0, y), y);
        const layout = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect(),
            photo = box(document.getElementById('imageWorkspace'));
          const overlap = (el) => {
            const b = box(el);
            return (
              Math.max(0, Math.min(photo.right, b.right) - Math.max(photo.left, b.left)) *
              Math.max(0, Math.min(photo.bottom, b.bottom) - Math.max(photo.top, b.top))
            );
          };
          return {
            covered: ['#pointsSection', '#exportBar', '.main-footer'].map((s) =>
              overlap(document.querySelector(s)),
            ),
            gap:
              box(document.getElementById('exportBar')).top -
              box(document.getElementById('pointsSection')).bottom,
          };
        });
        assert.deepEqual(layout.covered, [0, 0, 0], 'scroll ' + y);
        assert.ok(
          layout.gap >= 0 && layout.gap < 60,
          'export bar right under the table: ' + layout.gap,
        );
      }
      assert.deepEqual(problems, []);
      await context.close();
    }
  },
);

// Pastes rows into the open project and names it.
async function pasteProject(page, name, text) {
  await openPaste(page);
  await page.locator('#pasteText').fill(text);
  await page.locator('#pasteApply').click();
  await page.locator('#projectName').fill(name);
  await page.locator('#projectName').blur();
}

test('projects stay in the browser: new keeps the old one, the list opens and deletes them', async () => {
  const { context, page, problems } = await openApp();
  page.on('dialog', (d) => d.accept());
  await pasteProject(page, 'Nord', 'A;1.000;2.000\nB;3.000;4.000');
  await page.locator('#newProjectBtn').click();
  // The start screen lists the previous project; the new one is empty.
  await page.locator('#recentProjects:not([hidden])').waitFor();
  assert.equal(await page.locator('#pointsBody tr[data-row]').count(), 0);
  const item = page.locator('#recentList .project-item');
  assert.equal(await item.count(), 1);
  assert.equal(await item.locator('strong').textContent(), 'Nord');
  assert.match(await item.locator('small').textContent(), /2 Punkte · 0 geprüft/);
  await pasteProject(page, 'Süd', 'C;5.000;6.000');
  await page.waitForTimeout(800);
  // After a reload the last project is open and the other one is in "Meine Objekte".
  await page.reload();
  await page.locator('#pointsBody tr[data-row]').first().waitFor();
  assert.equal(await page.locator('#projectName').inputValue(), 'Süd');
  await page.locator('#projectsBtn').click();
  const listed = page.locator('#dialog .project-item');
  assert.deepEqual(await listed.locator('strong').allTextContents(), ['Nord']);
  await listed.locator('[data-project-open]').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#projectName').inputValue(), 'Nord');
  assert.equal(await page.locator('#pointsBody tr[data-row]').count(), 2);
  assert.equal(await page.locator('#undoBtn').isDisabled(), true, 'no undo into another project');
  // Delete "Süd" from the list; it stays gone after a reload.
  await page.locator('#projectsBtn').click();
  assert.deepEqual(await listed.locator('strong').allTextContents(), ['Süd']);
  await listed.locator('[data-project-delete]').click();
  await page.locator('#dialog .project-list').waitFor({ state: 'detached' });
  await page.reload();
  await page.locator('#pointsBody tr[data-row]').first().waitFor();
  await page.locator('#projectsBtn').click();
  assert.equal(await page.locator('#dialog .project-item').count(), 0);
  assert.deepEqual(problems, []);
  await context.close();
});

test('the single draft of earlier versions becomes the first project of the list', async () => {
  const { context, page, problems } = await openApp();
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('punktscan-v1', 1);
        r.onsuccess = () => {
          const tx = r.result.transaction('projects', 'readwrite'),
            store = tx.objectStore('projects');
          store.clear();
          store.put(
            {
              format: 'PunktScan',
              version: 1,
              name: 'Alt',
              sources: [],
              rows: [{ id: 'r1', name: 'X', e: '1.000', n: '2.000', h: '', verified: false }],
            },
            'current',
          );
          tx.oncomplete = () => {
            r.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await page.locator('#pointsBody tr[data-row]').first().waitFor();
  assert.equal(await page.locator('#projectName').inputValue(), 'Alt');
  const keys = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open('punktscan-v1', 1);
        r.onsuccess = () => {
          const q = r.result.transaction('projects').objectStore('projects').getAllKeys();
          q.onsuccess = () => resolve(q.result.map((k) => String(k).replace(/:.*/, ':id')).sort());
        };
      }),
  );
  assert.deepEqual(keys, ['active', 'index', 'p:id']);
  assert.deepEqual(problems, []);
  await context.close();
});

const luminance = (rgb) => {
  const [r, g, b] = rgb
    .match(/\d+/g)
    .slice(0, 3)
    .map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// Every visible text against what is really behind it: glass panels are blended over the page.
function lowContrastTexts() {
  const parse = (c) => {
    const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
    if (c.startsWith('color('))
      return { r: m[0] * 255, g: m[1] * 255, b: m[2] * 255, a: m[3] ?? 1 };
    return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
  };
  const lum = ({ r, g, b }) =>
    [r, g, b]
      .map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const behind = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 1) break;
    }
    let base = parse(
      getComputedStyle(document.documentElement)
        .getPropertyValue('--canvas')
        .trim()
        .replace(
          /^#(..)(..)(..)$/,
          (_, r, g, b) => `rgb(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)})`,
        ),
    );
    for (const c of layers.reverse()) base = over(c, base);
    return base;
  };
  const low = [];
  for (const el of document.querySelectorAll('body *')) {
    if (
      !el.checkVisibility() ||
      el.closest('svg, :disabled') ||
      ['IMG', 'CANVAS', 'OPTION', 'SELECT'].includes(el.tagName)
    )
      continue;
    const cs = getComputedStyle(el);
    const own =
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) ||
      (el.tagName === 'INPUT' && el.value);
    if (!own || parseFloat(cs.fontSize) === 0) continue;
    const bg = behind(el),
      fg = over(parse(cs.color), bg);
    const [x, y] = [lum(fg), lum(bg)].sort((a, b) => b - a),
      ratio = (x + 0.05) / (y + 0.05);
    const large =
      parseFloat(cs.fontSize) >= 24 ||
      (parseFloat(cs.fontSize) >= 18.66 && parseInt(cs.fontWeight) >= 600);
    if (ratio < (large ? 3 : 4.5))
      low.push(`${(el.value || el.textContent).trim().slice(0, 30)}: ${ratio.toFixed(2)}`);
  }
  return low;
}

test('one light theme, also with a dark system setting, and every text readable on the glass', async () => {
  for (const context of [{ viewport: { width: 1440, height: 900 } }, devices['iPhone 13']]) {
    const {
      context: ctx,
      page,
      problems,
    } = await openApp({ context: { ...context, colorScheme: 'dark', reducedMotion: 'reduce' } });
    assert.equal(await page.locator('#themeSelect').count(), 0, 'no theme picker');
    const body = await page.evaluate(() => getComputedStyle(document.body).color);
    assert.ok(luminance(body) < 0.02, 'dark text: the light theme stays ' + body);
    assert.deepEqual(await page.evaluate(lowContrastTexts), [], 'start screen');
    await openPaste(page);
    await page
      .locator('#pasteText')
      .fill('P1;3423197.856;5538496.915;101.20\nP2;x;5538498.482\nP3;3423198.026;5538496.339');
    await page.locator('#pasteApply').click();
    await page
      .locator('#toast')
      .waitFor({ state: 'hidden' })
      .catch(() => {});
    assert.deepEqual(await page.evaluate(lowContrastTexts), [], 'points');
    await page.locator('[data-review]').first().click();
    await page.locator('#dialog').waitFor();
    assert.deepEqual(await page.evaluate(lowContrastTexts), [], 'review card');
    assert.deepEqual(problems, []);
    await ctx.close();
  }
});

test('implausible points are marked and reviewed first: far away, odd height, name off the series, missing row', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  await openPaste(page);
  await page.locator('#pasteText').fill(
    [
      'P1;3423197.856;5538496.915;101.20',
      'P2;3423203.055;5538498.482;101.35',
      // N misread by one digit: a kilometre away.
      'P3;3423198.026;5539496.339;100.98',
      // Height misread: 101 → 191.
      'P4;3423198.600;5538496.512;191.42',
      // P5 is missing: a table row was not recognised.
      'P6;3423203.231;5538497.909;102.10',
      'P7;3423201.292;5538494.817;101.50',
      // P8 read as P19.
      'P19;3423202.100;5538495.100;101.40',
      'P9;3423200.500;5538497.300;101.60',
      'P10;3423199.700;5538495.900;101.10',
    ].join('\n'),
  );
  await page.locator('#pasteApply').click();
  const cell = (name, field) =>
    page.locator(
      `#pointsBody tr:has([data-field="name"][value="${name}"]) [data-field="${field}"]`,
    );
  const marked = await page
    .locator('#pointsBody input.uncertain')
    .evaluateAll((list) =>
      list.map(
        (i) => `${i.closest('tr').querySelector('[data-field="name"]').value}.${i.dataset.field}`,
      ),
    );
  assert.deepEqual(marked.sort(), ['P19.name', 'P3.n', 'P4.h', 'P6.name']);
  assert.match(
    await cell('P3', 'n').getAttribute('title'),
    /998 m vom nächsten Punkt.*Prüfe vor allem N/,
  );
  assert.match(await cell('P4', 'h').getAttribute('title'), /um 90 m/);
  assert.match(await cell('P6', 'name').getAttribute('title'), /fehlt P5/);
  assert.match(await cell('P19', 'name').getAttribute('title'), /Erwartet: P8/);
  // The review starts with these points, in table order, the doubtful field framed in yellow.
  await page.locator('#nextStepBtn').click();
  for (const [name, field] of [
    ['P3', 'n'],
    ['P4', 'h'],
    ['P6', 'name'],
    ['P19', 'name'],
  ]) {
    assert.equal(await page.locator('[data-value-field="name"]').textContent(), name);
    assert.equal(await page.locator('.review-field.flagged').count(), 1);
    assert.equal(await page.locator(`.review-field-${field}.flagged`).count(), 1);
    assert.ok(await page.locator('#reviewCard .review-message').isVisible());
    await page.locator('#verifyNextBtn').click();
  }
  // The plausible rest is confirmed together; the file is ready.
  await page.locator('#verifyAllBtn').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('body').getAttribute('data-step'), 'file');
  // Confirmed points are no longer marked.
  assert.equal(await page.locator('#pointsBody input.uncertain').count(), 0);
  assert.deepEqual(problems, []);
  await context.close();
});

test('dialogs close with × only: no second close or OK button at the bottom', async () => {
  const { context, page, problems } = await openApp();
  await openPaste(page);
  await page.locator('#pasteText').fill('A;1.000;2.000\nB;x;4.000');
  await page.locator('#pasteApply').click();
  const openers = [
    () => page.locator('#helpBtn').click(),
    () => page.locator('#mapBtn').click(),
    () => page.locator('#offlineBtn').click(),
    () => page.locator('#projectsBtn').click(),
    // A point with an error opens its card for editing.
    () => page.locator('[data-review]').nth(1).click(),
  ];
  for (const open of openers) {
    await open();
    await page.locator('#dialog').waitFor();
    const title = await page.locator('#dialog h2').textContent();
    const duplicates = await page
      .locator('#dialog .dialog-footer [data-close]')
      .evaluateAll((list) =>
        list.map((b) => b.textContent.trim()).filter((t) => /^(Schließen|OK)$/.test(t)),
      );
    assert.deepEqual(duplicates, [], title);
    assert.equal(await page.locator('#dialog .dialog-head [data-close]').count(), 1, title);
    await page.locator('#dialog .dialog-head [data-close]').click();
    await page.locator('#dialog').waitFor({ state: 'hidden' });
  }
  assert.deepEqual(problems, []);
  await context.close();
});

test('the send button appears only for files the browser can really send (GSI on Windows: save only)', async () => {
  // Like Chrome and Edge on Windows: files can be shared, but not with the .GSI extension.
  const windowsShare = () => {
    Object.defineProperty(navigator, 'canShare', {
      value: (data) => (data?.files ?? []).every((f) => /\.(txt|csv)$/i.test(f.name)),
      configurable: true,
    });
    Object.defineProperty(navigator, 'share', { value: async () => {}, configurable: true });
  };
  const { context, page, problems } = await openApp({ init: windowsShare });
  await openPaste(page);
  await page.locator('#pasteText').fill('A;1.000;2.000');
  await page.locator('#pasteApply').click();
  await verifyAll(page, 1);
  await page.locator('#exportBtn').click();
  assert.equal(await page.locator('#shareExport').count(), 0, 'GSI: no send button');
  assert.equal(await page.locator('#confirmExport').isVisible(), true);
  await page.locator('#dialog .dialog-head [data-close]').click();
  await page.locator('#csvBtn').click();
  assert.equal(await page.locator('#shareExport').count(), 1, 'CSV can be sent');
  assert.deepEqual(problems, []);
  await context.close();
});

test('point map: zoom with the wheel, buttons and two fingers, move by dragging, tap a point', async () => {
  const { context, page, problems } = await openApp();
  await openPaste(page);
  // Two points 1 cm apart, one 40 m away: at first the close pair overlaps.
  await page
    .locator('#pasteText')
    .fill('A;3415030.210;5545557.311\nB;3415030.220;5545557.311\nC;3415070.000;5545590.000');
  await page.locator('#pasteApply').click();
  await page.locator('#mapBtn').click();
  const map = page.locator('#pointMap');
  await map.waitFor();
  const gap = () =>
    page.evaluate(() => {
      const [a, b] = [...document.querySelectorAll('#pointMap circle')].map((c) =>
        Number(c.getAttribute('cx')),
      );
      return Math.abs(a - b);
    });
  const scale = () => page.locator('#pointMap .map-scale text').textContent();
  const before = await gap();
  assert.ok(before < 1, 'the close points overlap at first: ' + before);
  // The wheel zooms in around the pointer.
  const box = await map.boundingBox();
  const a = await page.locator('#pointMap circle').first().boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
  assert.ok((await gap()) > 15, 'close points apart after zooming: ' + (await gap()));
  // Points keep their size.
  assert.equal(await page.locator('#pointMap circle').first().getAttribute('r'), '5');
  const zoomedScale = await scale();
  // Dragging moves the map.
  const cx = async () => Number(await page.locator('#pointMap circle').first().getAttribute('cx'));
  const x0 = await cx();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.ok((await cx()) - x0 > 40, 'dragged to the right');
  // The fit button shows all points again; zoom buttons change the scale bar.
  await page.locator('#mapFit').click();
  assert.ok((await gap()) < 1);
  const fitScale = await scale();
  assert.notEqual(fitScale, zoomedScale);
  await page.locator('#mapZoomIn').click();
  await page.locator('#mapZoomIn').click();
  assert.notEqual(await scale(), fitScale);
  // A tap on a point opens its review card.
  await page.locator('#mapFit').click();
  const c = await page.locator('#pointMap .map-mark').nth(2).locator('circle').boundingBox();
  await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
  await page.locator('#reviewCard').waitFor();
  assert.equal(await page.locator('[data-value-field="name"]').textContent(), 'C');
  assert.deepEqual(problems, []);
  await context.close();
});

test('point map on a phone: two fingers zoom in', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  await openPaste(page);
  await page
    .locator('#pasteText')
    .fill('A;3415030.210;5545557.311\nB;3415030.220;5545557.311\nC;3415070.000;5545590.000');
  await page.locator('#pasteApply').click();
  await page
    .locator('#moreBtn')
    .click()
    .catch(() => {});
  await page.evaluate(() => document.getElementById('mapBtn').click());
  await page.locator('#pointMap').waitFor();
  const f = () =>
    page.evaluate(() => document.querySelector('#pointMap .map-scale text').textContent);
  const start = await f();
  // A pinch: two pointers moving apart.
  await page.evaluate(() => {
    const svg = document.getElementById('pointMap'),
      r = svg.getBoundingClientRect(),
      x = r.left + r.width / 2,
      y = r.top + r.height / 2;
    const fire = (type, id, dx) =>
      svg.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          clientX: x + dx,
          clientY: y,
          bubbles: true,
          pointerType: 'touch',
        }),
      );
    fire('pointerdown', 1, -20);
    fire('pointerdown', 2, 20);
    for (let d = 20; d <= 120; d += 10) {
      fire('pointermove', 1, -d);
      fire('pointermove', 2, d);
    }
    fire('pointerup', 1, -120);
    fire('pointerup', 2, 120);
  });
  assert.notEqual(await f(), start, 'the scale changed with the pinch');
  assert.equal(await page.locator('#reviewCard').count(), 0, 'a pinch does not open a point');
  assert.deepEqual(problems, []);
  await context.close();
});
