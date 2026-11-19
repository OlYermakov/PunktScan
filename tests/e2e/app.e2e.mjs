// End-to-end checks of the built app (dist/) in headless Chromium.
// Run after `npm run build`: `npm run test:e2e`.
// Set E2E_OCR=1 to also run the slower real-OCR check on the demo photos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import { chromium } from 'playwright';

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

async function openApp() {
  const context = await browser.newContext({ acceptDownloads: true });
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
    const { context, page, problems } = await openApp();
    await page.locator('#demoBtn').click();
    await page.locator('#sourceCount', { hasText: '2' }).waitFor();
    await page.locator('#recognizeAllBtn').click();
    await page.locator('#progressArea').waitFor({ state: 'hidden', timeout: 280000 });
    assert.equal(await page.locator('#pointsBody tr[data-row]').count(), 14);
    assert.deepEqual(problems, []);
    await context.close();
  },
);
