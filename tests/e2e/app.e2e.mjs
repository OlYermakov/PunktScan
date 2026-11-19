// End-to-end checks of the built app (dist/) in headless Chromium.
// Run after `npm run build`: `npm run test:e2e`.
// Set E2E_OCR=1 to also run the slower real-OCR check on the demo photos.
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
  browser = await chromium.launch();
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
  if (options.init) await context.addInitScript(options.init);
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

async function verifyAll(page, count) {
  await page.locator('[data-review]').first().click();
  for (let i = 0; i < count; i++) {
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
  assert.equal(await page.title(), 'PunktScan — фото в GSI');
  await page.evaluate(() => navigator.serviceWorker.ready);
  assert.equal(await page.locator('#exportBtn').isDisabled(), true);
  assert.deepEqual(problems, []);
  await context.close();
});

test('pasted reference table → review every point → GSI matches the reference file', async () => {
  const { context, page, problems } = await openApp();
  const reference = await fs.readFile('examples/demo-reference.GSI', 'latin1');
  const table = (await fs.readFile('examples/demo-points.csv', 'utf8')).replace(/^\ufeff/, '');
  const count = reference.trimEnd().split('\r\n').length;

  await page.locator('#pasteBtn').click();
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
  'real OCR on the demo photos finds all 14 rows',
  { skip: !process.env.E2E_OCR && 'set E2E_OCR=1 to run', timeout: 300000 },
  async () => {
    const { context, page, problems } = await openApp({ init: stubWakeLock });
    await page.locator('#demoBtn').click();
    await page.locator('#sourceCount', { hasText: '2' }).waitFor();
    await page.locator('#recognizeAllBtn').click();
    await page.locator('#awakeHint').waitFor();
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
  await page.locator('#demoBtn').click();
  await page.locator('#sourceCount', { hasText: '2' }).waitFor();
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
  await page.locator('#pasteBtn').click();
  await page.locator('#pasteText').fill('P1;10.000;20.000;\nP2;11.000;21.000;5.5');
  await page.locator('#pasteApply').click();
  await verifyAll(page, 2);
  await page.locator('#saveState', { hasText: 'Чернетку збережено' }).waitFor();
  await page.reload();
  await page.locator('#pointCount', { hasText: '2' }).waitFor();
  assert.equal(await page.locator('#exportBtn').isDisabled(), false, 'review state restored');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#saveProjectBtn').click(),
  ]);
  page.once('dialog', (d) => d.accept());
  await page.locator('#projectInput').setInputFiles(await download.path());
  await page.locator('#notice', { hasText: 'Проєкт відкрито' }).waitFor();
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

test('on a phone every point is a card with E, N and H visible without sideways scrolling', async () => {
  const { context, page, problems } = await openApp({ context: devices['iPhone 13'] });
  await page.locator('#pasteBtn').click();
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
  await page.locator('#pasteBtn').click();
  await page.locator('#pasteText').fill('P1;10.000;20.000;5.000');
  await page.locator('#pasteApply').click();
  await page.locator('[data-review]').first().click();
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
  await page.locator('#pasteBtn').click();
  await page.locator('#pasteText').fill('P1;10.000;20.000');
  await page.locator('#pasteApply').click();
  await page.locator('[data-review]').first().click();
  assert.equal(await page.locator('.sign-btn[data-sign="e"]').isHidden(), true);
  await context.close();
});
