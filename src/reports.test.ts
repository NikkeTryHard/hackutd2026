import { describe, expect, test } from 'bun:test';
import { strFromU8, unzipSync } from 'fflate';
import type { AgentRun, World } from './contracts';
import { createSnapshot, reportHtml, reportMarkdown, reportZip } from './reports';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const base: AgentRun = {
    config: {
      id: 'agent-test',
      name: 'Test Agent',
      profile: 'baseline',
      task: 'Complete the controlled task',
      scenario: 'shop',
      verify: false,
    },
    status: 'completed',
    requested: 'running',
    step: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
    events: [
      {
        id: 'event-observation',
        agentId: 'agent-test',
        seq: 1,
        at: 1_700_000_001_000,
        kind: 'observation',
        text: 'Decision observation',
        artifact: '/artifacts/observation.png',
        data: { width: 1280, height: 800, sha256: 'abc' },
      },
      {
        id: 'event-claim',
        agentId: 'agent-test',
        seq: 2,
        at: 1_700_000_002_000,
        kind: 'claim',
        text: 'Model claims completion: done',
        data: { summary: 'done' },
      },
    ],
    findings: [],
    outcome: 'Checkout complete',
    latestFrame: '/artifacts/observation.png',
  };
  return structuredClone({ ...base, ...overrides });
}

function buildWorld(overrides: Partial<World> = {}): World {
  return {
    agentId: 'agent-test',
    scenario: 'shop',
    revision: 2,
    stock: 4,
    notice: 'In stock',
    cart: 1,
    selected: 'notebook/ruled',
    completed: true,
    panels: [],
    appliedRevision: 1,
    defect: false,
    ...overrides,
  };
}

function imageAssets() {
  return {
    '/artifacts/observation.png': `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
  };
}

describe('reports', () => {
  test('snapshots are deep-frozen and require terminal runs', () => {
    const snapshot = createSnapshot(buildRun(), buildWorld());
    expect(snapshot.version).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.run.events)).toBe(true);
    expect(() => {
      snapshot.run.status = 'running';
    }).toThrow();
    expect(() => createSnapshot(buildRun({ status: 'running' }), buildWorld())).toThrow(
      'terminal run',
    );
  });

  test('standalone HTML escapes untrusted text, inlines images and stays offline', () => {
    const run = buildRun({
      config: {
        ...buildRun().config,
        name: '<script>alert(1)</script>',
        task: '</script><img src=x onerror=alert(1)>',
      },
      outcome: '<img src=x>',
    });
    const html = reportHtml(createSnapshot(run, buildWorld()), imageAssets());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('id="frame-select"');
    expect(html).not.toMatch(/src="(?!data:)/);
  });

  test('missing image and technical artifacts are explicit, not broken links', () => {
    const run = buildRun();
    run.events.push({
      id: 'event-trace',
      agentId: 'agent-test',
      seq: 3,
      at: 1_700_000_003_000,
      kind: 'artifact',
      text: 'Playwright trace',
      artifact: '/artifacts/trace.zip',
      data: { type: 'trace' },
    });
    run.events.push({
      id: 'event-video',
      agentId: 'agent-test',
      seq: 4,
      at: 1_700_000_004_000,
      kind: 'artifact',
      text: 'Session video',
      artifact: '/artifacts/session.webm',
      data: { type: 'video' },
    });
    const html = reportHtml(createSnapshot(run, buildWorld()), {});
    expect(html).toContain('not included in this export');
    expect(html).toContain('Missing evidence assets');
    expect(html).toContain('/artifacts/observation.png');
    expect(html).toContain('/artifacts/trace.zip');
    expect(html).toContain('/artifacts/session.webm');
    expect(html).not.toContain('src="/artifacts/observation.png"');
  });

  test('ZIP carries hashed payloads without manifest self-reference', () => {
    const snapshot = createSnapshot(buildRun(), buildWorld());
    const archive = unzipSync(
      reportZip(snapshot, {
        '/artifacts/observation.png': PNG,
        '/artifacts/trace.zip': new Uint8Array([80, 75, 3, 4]),
      }),
    );
    expect(Object.keys(archive).sort()).toEqual([
      'README.txt',
      'evidence/observation.png',
      'manifest.json',
      'report.html',
      'report.json',
      'report.md',
      'sha256sums.txt',
      'trace/trace.zip',
    ]);
    const rows = strFromU8(archive['sha256sums.txt'] ?? new Uint8Array())
      .trim()
      .split('\n');
    const bundledHtml = strFromU8(archive['report.html'] ?? new Uint8Array());
    expect(bundledHtml).not.toContain('Missing evidence assets');
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      const bytes = archive[name ?? ''];
      expect(bytes).toBeDefined();
      if (!bytes || !hash) continue;
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(hash);
      expect(name).not.toBe('manifest.json');
      expect(name).not.toBe('sha256sums.txt');
    }
  });

  test('Markdown exposes verification lineage only for verification runs', () => {
    const verificationRun = buildRun({
      config: { ...buildRun().config, verify: false, verificationOf: 'originalRun' },
      findings: [],
    });
    const markdown = reportMarkdown(createSnapshot(verificationRun, buildWorld()));
    expect(markdown).toContain('/report/agent-test');
    expect(markdown).toContain('/report/originalRun');
    expect(markdown).toContain('do not render local ZIP images on GitHub');
    expect(markdown).toContain('report.html');
    const verificationRow = markdown
      .split('\n')
      .find((line) => line.startsWith('| Verification |'));
    expect(verificationRow).toBeDefined();
    if (!verificationRow) throw new Error('Missing verification summary row');
    expect(verificationRow).toContain('originalRun');

    const nonVerification = reportMarkdown(
      createSnapshot(buildRun({ findings: [] }), buildWorld()),
    );
    const plainRow = nonVerification
      .split('\n')
      .find((line) => line.startsWith('| Verification |'));
    expect(plainRow).toBeDefined();
    if (!plainRow) throw new Error('Missing verification summary row');
    expect(plainRow).not.toContain('originalRun');
    expect(nonVerification).not.toContain('/report/originalRun');
  });
});
