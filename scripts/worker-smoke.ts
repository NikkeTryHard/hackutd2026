import { chromium } from 'playwright';
import { createBackend } from '../src/backend';
import {
  executeAction,
  cropObservation,
  installRequestContainment,
  mapObservationPoint,
} from '../src/worker';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const backend = await createBackend();
const browser = await chromium.launch({ headless: true });
const id = `worker-smoke-${crypto.randomUUID()}`;
try {
  await backend.create({
    id,
    name: 'Worker infrastructure smoke',
    scenario: 'shop',
    profile: 'baseline',
    task: 'Infrastructure only; no model execution',
    verify: false,
  });
  await backend.patch(id, { status: 'running' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
  });
  const blocked: string[] = [];
  await installRequestContainment(context, 'http://127.0.0.1:4311', id, {
    scenario: 'shop',
    onBlocked: (entry) => {
      blocked.push(entry.url);
    },
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:4311/shop?agent=${id}`);
  await page.waitForFunction(() =>
    document.querySelector('#connectionStatus')?.textContent?.startsWith('Connected'),
  );
  const search = await page.locator('#shopSearch').boundingBox();
  assert(search, 'Search input has no rendered bounds');
  await executeAction(page, { type: 'click', x: search.x + 20, y: search.y + 15 }, 'baseline', 0);
  await executeAction(page, { type: 'type', text: 'bottle' }, 'baseline', 1);
  await executeAction(page, { type: 'key', key: 'Enter' }, 'keyboard', 2);
  await page.waitForFunction(() => {
    const visible = [...document.querySelectorAll('#shopResults [data-product]')].filter(
      (element) => (element as HTMLElement).offsetParent !== null,
    );
    return visible.length === 1 && visible[0]?.getAttribute('data-product') === 'bottle';
  });
  let rejected = false;
  try {
    await executeAction(page, { type: 'click', x: 20, y: 20 }, 'keyboard', 3);
  } catch (error) {
    rejected = error instanceof Error && error.name === 'ProfileViolationError';
  }
  assert(rejected, 'Keyboard profile allowed a pointer action');
  const image = new Uint8Array(await page.screenshot({ type: 'png' }));
  const crop = await cropObservation(image, {
    type: 'crop',
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    scale: 2,
  });
  assert(crop.image.width === 400 && crop.image.height === 200, 'Crop output dimensions are wrong');
  const mapped = mapObservationPoint(
    { originX: 100, originY: 100, scale: 2, width: 400, height: 200 },
    { x: 40, y: 20 },
  );
  assert(mapped.x === 120 && mapped.y === 110, 'Crop point did not map to original viewport');
  const urls = [
    'http://127.0.0.1:4310/api/runs',
    'http://127.0.0.1:4311/api/world/another-agent',
    'http://127.0.0.1:4311/artifacts/private.png',
    'https://example.com/',
  ];
  for (const url of urls) {
    const success = await page.evaluate(async (target) => {
      try {
        const response = await fetch(target);
        return response.ok;
      } catch {
        return false;
      }
    }, url);
    assert(!success, `Browser containment allowed ${url}`);
  }
  assert(
    blocked.some((url) => url.includes('another-agent')),
    'Cross-agent request did not reach containment evidence',
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: 'deuteranopia' });
  assert((await page.screenshot()).byteLength > 0, 'Filtered screenshot capture failed');
  await cdp.detach();
  await context.close();
  await backend.patch(id, {
    status: 'stopped',
    requested: 'stopped',
    outcome: 'Browser worker infrastructure verified; no model executed',
  });
  console.log(
    JSON.stringify(
      {
        label: 'Actual Chromium worker smoke; not model evaluation',
        coordinateInput: true,
        keyboardEnforced: true,
        cropMapping: true,
        browserContainment: true,
        filteredCapture: true,
        blockedRequests: blocked.length,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await backend.close();
}
