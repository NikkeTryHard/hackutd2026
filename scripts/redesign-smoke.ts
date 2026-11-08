import { chromium } from 'playwright';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4310/dashboard');
  await page.getByTestId('run-card').first().waitFor();
  assert((await page.getByTestId('run-card').count()) >= 6, 'Recent runs unavailable');
  await page.locator('.sl-runs-toggle').click();
  assert((await page.getByTestId('run-card').count()) > 6, 'All runs not available');
  await page.locator('.sl-runs-toggle').click();
  await page.goto('http://127.0.0.1:4310/dashboard/settings');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.goto('http://127.0.0.1:4310/dashboard/new');
  await page.locator('.sl-launch-disclosure summary').click();
  await page.getByTestId('profiles-custom').check();
  await page.getByTestId('profile-pointer').check();
  await page.getByTestId('verify-toggle').check();
  await page.getByTestId('verify-toggle').uncheck();
  await page.getByTestId('defect-toggle').check();
  await page.getByTestId('defect-toggle').uncheck();
  await page.getByTestId('scenario-portal').check();
  await page.getByTestId('scenario-shop').check();
  await page.locator('.sl-launch-disclosure summary').click();
  await page.getByTestId('task-input').fill('');
  await page.getByTestId('launch-agents').click();
  await page.getByTestId('launch-error').waitFor();
  assert(
    await page.getByTestId('task-input').evaluate((el) => el === document.activeElement),
    'Invalid task not focused',
  );
  await page.getByTestId('task-input').fill('');
  await page.goto('http://127.0.0.1:4310/dashboard');
  await page.getByTestId('run-card').first().waitFor();
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({ path: 'data/smoke/redesign-desktop.png', fullPage: true });
  await page.getByTestId('run-link').first().click();
  await page.getByTestId('detail-page').waitFor();
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({ path: 'data/smoke/redesign-detail.png', fullPage: true });
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://127.0.0.1:4310/dashboard');
    await page.getByTestId('run-card').first().waitFor();
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished)),
    );
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `Overflow at ${width}`,
    );
    if (width === 390)
      await page.screenshot({ path: 'data/smoke/redesign-mobile.png', fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const moving = await page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
  );
  assert(moving === 0, `Reduced motion leaves ${moving} animations running`);
  assert(errors.length === 0, `Browser errors: ${errors.join(';')}`);
  console.log(
    JSON.stringify({
      desktop: true,
      widths: [390, 768, 1280],
      disclosures: true,
      settings: true,
      historyToggle: true,
      validationFocus: true,
      detailNavigation: true,
      reducedMotion: true,
      consoleErrors: errors.length,
    }),
  );
} finally {
  await browser.close();
}
