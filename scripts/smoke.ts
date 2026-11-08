import { chromium } from 'playwright';
import { createBackend } from '../src/backend';
import type { AgentConfig, Scenario } from '../src/contracts';
import { unzipSync } from 'fflate';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const origin = Bun.env.SMOKE_ORIGIN || 'http://127.0.0.1:4310';
const replicaOrigin = Bun.env.SMOKE_REPLICA_ORIGIN || 'http://127.0.0.1:4311';
const dataDir = resolve(Bun.env.DATA_DIR || './data');
const evidence = resolve(dataDir, 'smoke');
await mkdir(evidence, { recursive: true });
await mkdir(resolve(dataDir, 'artifacts'), { recursive: true });
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const backend = await createBackend();
const health = await backend.health();
assert(health.ok, `SpacetimeDB required: ${health.detail}`);
const browser = await chromium.launch({ headless: true });
const results: string[] = [];
try {
  const healthResponse = await fetch(`${origin}/api/health`);
  assert(healthResponse.ok, 'Control server health endpoint failed');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.waitForSelector('h1');
  await page.screenshot({ path: resolve(evidence, 'control-room.png'), fullPage: true });
  assert(
    (await page.locator('body').innerText()).includes('Sightline'),
    'Dashboard did not render Sightline',
  );
  results.push('Actual React dashboard loaded in Chromium');
  const configs: AgentConfig[] = [];
  for (const scenario of ['shop', 'portal'] as Scenario[]) {
    const config: AgentConfig = {
      id: `smoke-${scenario}-${crypto.randomUUID()}`,
      name: `Infrastructure smoke ${scenario}`,
      profile: 'baseline',
      task: 'Deterministic infrastructure smoke; not a model evaluation',
      scenario,
      verify: false,
    };
    await backend.create(config);
    await backend.patch(config.id, { status: 'running' });
    configs.push(config);
    const replica = await context.newPage();
    await replica.goto(`${replicaOrigin}/${scenario}?agent=${config.id}`);
    await replica.waitForFunction(() =>
      document.querySelector('#connectionStatus')?.textContent?.startsWith('Connected'),
    );
    if (scenario === 'shop') {
      await replica.locator('#shopSearch').fill('');
      await replica.locator('#shopSearchButton').click();
      await replica.locator('#shopResults [data-product]').first().click();
      await replica.locator('#variantButtons button').first().click();
      await replica.locator('#addToCartButton').click();
      await replica.waitForFunction(
        () => Number(document.querySelector('#cartCount')?.textContent) > 0,
      );
      await replica.locator('#checkoutButton').click();
      await replica.locator('#completeCheckoutButton').click();
      await replica.locator('#orderConfirmation').waitFor({ state: 'visible' });
      assert(
        (await backend.world(config.id)).completed,
        'Shop checkout did not persist completion',
      );
    } else {
      const tiles = replica.locator('#tileGrid button');
      assert((await tiles.count()) === 18, 'Portal does not expose all 18 service tiles');
      for (let index = 0; index < 18; index += 1) {
        await tiles.nth(index).focus();
        await replica.keyboard.press('Enter');
        await replica.locator('#panelArea').waitFor({ state: 'visible' });
        await replica.locator('#closePanelButton').click();
        await replica.locator('#panelArea').waitFor({ state: 'hidden' });
      }
      await replica.locator('#addSessionButton').click();
      await replica.waitForFunction(
        () => !document.querySelector('#planList')?.textContent?.includes('No sessions'),
      );
    }
    const ackDeadline = Date.now() + 5000;
    for (;;) {
      const current = await backend.world(config.id);
      if (current.appliedRevision >= current.revision) break;
      assert(Date.now() < ackDeadline, 'Replica never acknowledged the rendered world revision');
      await Bun.sleep(50);
    }
    await replica.screenshot({ path: resolve(evidence, `${scenario}.png`), fullPage: true });
    const artifact = `/artifacts/${config.id}-smoke.png`;
    await Bun.write(
      resolve(dataDir, 'artifacts', `${config.id}-smoke.png`),
      Bun.file(resolve(evidence, `${scenario}.png`)),
    );
    await backend.append(config.id, {
      kind: 'observation',
      text: 'Deterministic browser observation, not model output',
      artifact,
    });
    await backend.patch(config.id, { latestFrame: artifact });
    const worldResponse = await fetch(`${replicaOrigin}/api/world/${config.id}`);
    const visibleWorld = (await worldResponse.json()) as Record<string, unknown>;
    assert(!('defect' in visibleWorld), 'Replica world exposed hidden evaluator truth');
    await replica.close();
  }
  const first = configs[0];
  const second = configs[1];
  assert(first && second, 'Fixture creation failed');
  await backend.message(first.id, 'smoke message');
  const [firstMessage] = await backend.takeMessages(first.id);
  assert(firstMessage?.text === 'smoke message', 'Message delivery failed');
  assert(firstMessage.interrupt === false, 'Queued message was marked interrupting');
  assert((await backend.takeMessages(first.id)).length === 0, 'Message delivered more than once');
  assert((await backend.takeMessages(second.id)).length === 0, 'Message crossed worlds');
  const event1 = await backend.append(first.id, { kind: 'smoke', text: 'First evidence' });
  const event2 = await backend.append(first.id, { kind: 'smoke', text: 'Second evidence' });
  assert(event2.seq > event1.seq, 'Evidence sequence did not increase');
  await backend.patch(first.id, {
    status: 'completed',
    outcome: 'Deterministic infrastructure verification only',
  });
  const reportResponse = await fetch(`${origin}/api/reports/${first.id}.zip`);
  assert(reportResponse.ok, `Report ZIP failed: ${await reportResponse.clone().text()}`);
  const zipBytes = new Uint8Array(await reportResponse.arrayBuffer());
  await Bun.write(resolve(evidence, 'report.zip'), zipBytes);
  const zip = unzipSync(zipBytes);
  assert(
    Object.keys(zip).some((name) => name.endsWith('report.html')),
    'ZIP has no offline report',
  );
  for (const [name, bytes] of Object.entries(zip)) {
    if (name === 'report.html') await Bun.write(resolve(evidence, 'report.html'), bytes);
  }
  const offline = await context.newPage();
  await offline.route('http://**/*', (route) => route.abort());
  await offline.route('https://**/*', (route) => route.abort());
  await offline.goto(`file://${resolve(evidence, 'report.html')}`);
  assert(
    (await offline.locator('body').innerText()).includes('Deterministic infrastructure'),
    'Offline report did not render run content',
  );
  assert(
    await offline
      .locator('img')
      .evaluateAll(
        (images) =>
          images.length > 0 &&
          images.every(
            (image) =>
              (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
          ),
      ),
    'Offline evidence images did not decode',
  );
  await offline.screenshot({ path: resolve(evidence, 'offline-report.png'), fullPage: true });
  const foreign = await fetch(`${origin}/api/runs/${first.id}/messages`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'forbidden' }),
  });
  assert(foreign.status === 403, 'Cross-origin mutation was not rejected');
  assert(
    (await fetch(`${origin}/artifacts/not-registered.png`)).status === 404,
    'Unregistered artifact was served',
  );
  assert(pageErrors.length === 0, `Dashboard errors: ${pageErrors.join('; ')}`);
  results.push(
    'Both real replica pages loaded with isolated DB worlds and hidden truth omitted',
    'Messages consumed once; evidence ordering persisted',
    'ZIP exported and standalone HTML opened with HTTP requests blocked',
    'Cross-origin mutation and unregistered artifact access rejected',
  );
  await context.close();
  console.log(
    JSON.stringify(
      { label: 'Infrastructure smoke only — no model evaluation', results, evidence },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await backend.close();
}
