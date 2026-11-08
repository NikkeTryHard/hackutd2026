import { chromium } from 'playwright';
import { createBackend } from '../src/backend';
import { decide, validateAction } from '../src/model';
import { executeAction, installRequestContainment } from '../src/worker';
import type { AgentConfig, EvidenceEvent } from '../src/contracts';
import { mkdir } from 'node:fs/promises';

// Capture real screenshot-driven model decisions. Editing removes inference waits,
// but never substitutes scripted clicks for the model's chosen browser actions.
const dir = `${import.meta.dir}/../data/video-source`;
await mkdir(dir, { recursive: true });
await mkdir(`${import.meta.dir}/../public/media`, { recursive: true });
const backend = await createBackend();
const replay = process.argv.includes('--replay');
const sourceManifest = replay
  ? ((await Bun.file(`${dir}/manifest.json`).json()) as { scenario: string; runId: string }[])
  : [];
const browser = await chromium.launch(
  replay
    ? {
        headless: false,
        env: { ...process.env, DISPLAY: ':97' },
        args: ['--kiosk', '--window-position=0,0', '--window-size=1280,800'],
      }
    : {},
);
const manifest: unknown[] = [];
try {
  for (const scenario of ['shop', 'portal'] as const) {
    const config: AgentConfig = {
      id: `video-${scenario}-${crypto.randomUUID()}`,
      name: `Landing video · ${scenario}`,
      scenario,
      profile: 'baseline',
      verify: false,
      task:
        scenario === 'shop'
          ? 'Explore the store through a complete shopping journey. Open at least three different product detail pages, inspect available variants, add two different products to the cart, open the cart and complete the synthetic checkout. Navigate through the visible UI only. Do not stop to report cosmetic issues. Finish only after checkout.'
          : 'Explore the campus portal thoroughly through the visible UI. Open and inspect at least six distinct service panels, including advising, financial aid, housing, library, parking and printing if available. Close each panel before opening the next. Scroll to reach more services. Finally open advising and book an available synthetic appointment. Do not stop to report cosmetic issues; keep exploring until all six services are inspected.',
    };
    const source = sourceManifest.find((recording) => recording.scenario === scenario);
    const sourceRun = source ? await backend.get(source.runId) : undefined;
    const replayActions =
      sourceRun?.events
        .filter((event) => event.kind === 'action')
        .map((event) => validateAction(JSON.parse(event.text))) ?? [];
    if (replay && replayActions.length === 0)
      throw new Error(`Missing original ${scenario} actions`);
    await backend.create(config);
    await backend.patch(config.id, { status: 'running' });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...(replay ? {} : { recordVideo: { dir, size: { width: 1280, height: 800 } } }),
    });
    await installRequestContainment(context, 'http://127.0.0.1:4311', config.id, { scenario });
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const canvas = document.createElement('canvas');
        canvas.id = 'demo-pointer';
        canvas.width = innerWidth;
        canvas.height = innerHeight;
        canvas.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;pointer-events:none;width:100vw;height:100vh';
        document.body.append(canvas);
        const context2d = canvas.getContext('2d');
        if (!context2d) throw new Error('Canvas rendering is unavailable');
        const ctx: CanvasRenderingContext2D = context2d;
        let x = 110,
          y = 110;
        const trail: { x: number; y: number; t: number }[] = [];
        const splashes: { x: number; y: number; t: number }[] = [];
        window.addEventListener('mousemove', (e: MouseEvent) => {
          x = e.clientX;
          y = e.clientY;
          trail.push({ x, y, t: performance.now() });
        });
        addEventListener('mousedown', () => splashes.push({ x, y, t: performance.now() }));
        function draw() {
          const now = performance.now();
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          while (trail[0] && now - trail[0].t > 420) trail.shift();
          for (const p of trail) {
            const a = 1 - (now - p.t) / 420;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 9 * a, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(116,106,255,${a * 0.28})`;
            ctx.fill();
          }
          while (splashes[0] && now - splashes[0].t > 650) splashes.shift();
          for (const p of splashes) {
            const a = (now - p.t) / 650;
            ctx.strokeStyle = `rgba(122,105,255,${1 - a})`;
            ctx.lineWidth = 3 * (1 - a);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 8 + 34 * a, 0, Math.PI * 2);
            ctx.stroke();
            for (let i = 0; i < 7; i++) {
              const angle = (i * Math.PI * 2) / 7;
              ctx.beginPath();
              ctx.ellipse(
                p.x + Math.cos(angle) * (12 + 35 * a),
                p.y + Math.sin(angle) * (12 + 35 * a) + 12 * a * a,
                3 * (1 - a),
                5 * (1 - a),
                angle,
                0,
                Math.PI * 2,
              );
              ctx.fillStyle = `rgba(151,137,255,${1 - a})`;
              ctx.fill();
            }
          }
          ctx.save();
          ctx.translate(x, y);
          ctx.shadowColor = 'rgba(0,0,0,.25)';
          ctx.shadowBlur = 8;
          ctx.shadowOffsetY = 3;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(0, 34);
          ctx.lineTo(9, 26);
          ctx.lineTo(16, 41);
          ctx.lineTo(23, 38);
          ctx.lineTo(16, 23);
          ctx.lineTo(29, 23);
          ctx.closePath();
          ctx.fillStyle = '#fcfbff';
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.lineWidth = 2.4;
          ctx.strokeStyle = '#7061de';
          ctx.stroke();
          ctx.restore();
          requestAnimationFrame(draw);
        }
        draw();
      });
    });
    const page = await context.newPage();
    if (replay) {
      const session = await context.newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'fullscreen' },
      });
      await page.waitForTimeout(500);
      await session.detach();
    }
    const capturePath = `${dir}/${scenario}-smooth60.mkv`;
    const capture = replay
      ? Bun.spawn(
          [
            'ffmpeg',
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'x11grab',
            '-framerate',
            '60',
            '-video_size',
            '1280x800',
            '-draw_mouse',
            '0',
            '-i',
            ':97.0',
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '17',
            '-progress',
            'pipe:1',
            capturePath,
          ],
          { stdout: 'pipe', stderr: 'inherit' },
        )
      : undefined;
    if (capture) {
      const reader = capture.stdout.getReader();
      await reader.read();
      reader.releaseLock();
    }
    const start = performance.now();
    const clips: { start: number; end: number }[] = [];
    await page.goto(`http://127.0.0.1:4311/${scenario}?agent=${config.id}`);
    await page.waitForTimeout(900);
    const history: EvidenceEvent[] = [];
    let pointer = { x: 110, y: 110 };
    for (let step = 0; ; step++) {
      await page
        .locator('#demo-pointer')
        .evaluate((e) => ((e as HTMLElement).style.visibility = 'hidden'));
      const image = await page.screenshot({ type: 'png' });
      await page
        .locator('#demo-pointer')
        .evaluate((e) => ((e as HTMLElement).style.visibility = 'visible'));
      const result = replay
        ? { action: replayActions[step] }
        : await decide(
            new Uint8Array(image),
            config,
            history,
            [
              'For text input use action type "type", never "text". Continue the requested journey.',
            ],
            { timeoutMs: 90000 },
          );
      if (!result) break;
      if (!result.action) break;
      const action = validateAction(result.action);
      console.log(JSON.stringify({ scenario, step, action }));
      const clipStart = (performance.now() - start) / 1000;
      if ('x' in action && 'y' in action && action.type !== 'crop') {
        const from = pointer;
        await page.evaluate(
          async ({ from, to }) => {
            const began = performance.now();
            const { promise, resolve } = Promise.withResolvers<void>();
            function frame(now: number) {
              const t = Math.min(1, (now - began) / 1550);
              const eased = t * t * t * (t * (t * 6 - 15) + 10);
              window.dispatchEvent(
                new MouseEvent('mousemove', {
                  clientX: from.x + (to.x - from.x) * eased,
                  clientY: from.y + (to.y - from.y) * eased,
                }),
              );
              if (t < 1) requestAnimationFrame(frame);
              else resolve();
            }
            requestAnimationFrame(frame);
            await promise;
          },
          { from, to: { x: action.x, y: action.y } },
        );
        await page.mouse.move(action.x, action.y);
        pointer = { x: action.x, y: action.y };
      }
      if (!['finish', 'report', 'crop'].includes(action.type))
        await executeAction(page, action, 'baseline', step);
      await page.waitForTimeout(action.type === 'scroll' ? 900 : 700);
      clips.push({ start: Math.max(0, clipStart - 0.15), end: (performance.now() - start) / 1000 });
      history.push({
        id: crypto.randomUUID(),
        agentId: config.id,
        seq: step,
        at: Date.now(),
        kind: 'action',
        text: JSON.stringify(action),
      });
      await backend.append(config.id, { kind: 'action', text: JSON.stringify(action) });
      if (action.type === 'finish') break;
    }
    const video = page.video();
    if (capture) {
      capture.kill('SIGINT');
      const code = await capture.exited;
      if (code !== 255 && code !== 0) throw new Error('60 fps capture failed');
    }
    await context.close();
    const path = capture ? capturePath : await video?.path();
    if (!path) throw new Error('Browser recording did not start');
    manifest.push({
      scenario,
      runId: config.id,
      sourceRunId: source?.runId,
      fps: replay ? 60 : 25,
      path,
      clips,
    });
    await Bun.write(
      `${dir}/${replay ? 'manifest-smooth' : 'manifest'}.json`,
      JSON.stringify(manifest, null, 2),
    );
    await backend.patch(config.id, {
      status: 'completed',
      outcome: 'Recorded model-driven browser journey for landing-page video.',
    });
  }
} finally {
  await browser.close();
  await backend.close();
}
console.log(`Recording manifest: ${dir}/manifest.json`);
