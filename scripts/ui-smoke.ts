import { chromium } from 'playwright';
import { createBackend } from '../src/backend';
import { resolve } from 'node:path';
const dataDir = resolve(Bun.env.DATA_DIR || './data');
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const backend = await createBackend();
const browser = await chromium.launch();
const id = `ui-smoke-${crypto.randomUUID()}`;
try {
  await backend.create({
    id,
    name: 'Live browser UI smoke',
    profile: 'baseline',
    scenario: 'shop',
    task: 'Operator interface smoke; no model executed',
    verify: false,
  });
  const artifact = `/artifacts/${id}.png`;
  await Bun.write(
    resolve(dataDir, 'artifacts', `${id}.png`),
    Bun.file(resolve(dataDir, 'smoke', 'shop.png')),
  );
  await backend.append(id, { kind: 'observation', text: 'First browser observation', artifact });
  await backend.patch(id, { status: 'running', latestFrame: artifact, cursor: { x: 200, y: 200 } });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:4310/agent/${id}`);
  await page.getByTestId('detail-frame').locator('img').waitFor();
  await backend.patch(id, { cursor: { x: 700, y: 450 } });
  await page.waitForFunction(
    () => Number.parseFloat((document.querySelector('.sl-cursor') as HTMLElement).style.left) > 50,
  );
  await backend.append(id, {
    kind: 'action',
    text: 'Click checkout',
    data: { action: { type: 'click', x: 700, y: 450 } },
  });
  await page.getByText('Click checkout', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  await page.getByLabel('Execution', { exact: true }).selectOption('paused');
  await page.waitForFunction(() => document.querySelector('select')?.value === 'paused');
  assert((await backend.get(id))?.requested === 'paused', 'Pause request was not persisted');
  await page.getByLabel('Execution', { exact: true }).selectOption('running');
  await page.getByLabel('Interrupt current action').check();
  await page
    .getByLabel('Message agent', { exact: true })
    .fill('Inspect the cart before finishing.');
  await page.getByLabel('Message agent', { exact: true }).press('Enter');
  await page.getByRole('status').filter({ hasText: 'Interrupt requested.' }).waitFor();
  const messages = await backend.takeMessages(id);
  assert(
    messages[0]?.text === 'Inspect the cart before finishing.' && messages[0]?.interrupt,
    'Interrupt-aware message did not reach queue',
  );
  await backend.patch(id, { status: 'completed', outcome: 'Browser smoke completed' });
  await page.getByText('Task done', { exact: true }).waitFor();
  assert(
    await page.getByLabel('Message agent', { exact: true }).isDisabled(),
    'Finished run still accepts messages',
  );
  await page.screenshot({ path: resolve(dataDir, 'smoke', 'agent-detail.png'), fullPage: true });
  await page.goto('http://127.0.0.1:4310/dashboard');
  const card = page.getByTestId('run-card').filter({ has: page.locator(`a[href='/agent/${id}']`) });
  await page.locator('.sl-runs-toggle').click();
  await card.waitFor();
  const box = await card.boundingBox();
  assert(box && box.height < 320, 'Run card is too tall');
  assert((await card.locator('textarea,button').count()) === 0, 'Run card has controls');
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'Dashboard overflows',
    );
  }
  assert(errors.length === 0, errors.join('; '));
  console.log(
    JSON.stringify({
      liveCursor: true,
      timeline: true,
      executionSelect: true,
      interruptMessage: true,
      completionOverlay: true,
      compactCards: true,
      widths: [390, 768, 1280],
      consoleErrors: errors.length,
      limitation: 'Backend-driven browser smoke, not a real model lifecycle',
    }),
  );
} finally {
  await browser.close();
  await backend.close();
}
