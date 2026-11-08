import { createBackend } from './backend';
import { modelHealth } from './model';
import { startAgent, commandAgent, interruptAgent, shutdownWorkers } from './worker';
import { replicaHtml } from './replica';
import { createSnapshot, reportHtml, reportMarkdown, reportZip } from './reports';
import { SummaryError, generateActivitySummary, projectRunActivity } from './summary';
import type { ActivitySummary, ActivitySummaryPayload } from './summary';
import type { AgentConfig, AgentRun, Backend, ReportSnapshot } from './contracts';
import {
  DEFAULT_PROFILE_SELECTION,
  MAX_CONCURRENT_AGENTS,
  PROFILE_IDS,
  isProfile,
} from './profiles';
import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

const port = Number(Bun.env.PORT || 4310);
const replicaPort = Number(Bun.env.REPLICA_PORT || 4311);
const nextPort = Number(Bun.env.NEXT_PORT || 4312);
const validPort = (value: number) => Number.isInteger(value) && value >= 1024 && value <= 65535;
if (
  !validPort(port) ||
  !validPort(replicaPort) ||
  !validPort(nextPort) ||
  new Set([port, replicaPort, nextPort]).size !== 3
)
  throw new Error('PORT, REPLICA_PORT and NEXT_PORT must be distinct integer ports in 1024–65535');
const origin = `http://127.0.0.1:${port}`;
const replicaOrigin = `http://127.0.0.1:${replicaPort}`;
const nextOrigin = `http://127.0.0.1:${nextPort}`;
// Explicit deployment origins preserve host/CSRF checks when a tailnet proxy or
// a separate Next.js frontend forwards requests. Never trust forwarded headers.
const demoOrigins = (Bun.env.SIGHTLINE_DEMO_ORIGINS || '')
  .split(',')
  .filter(Boolean)
  .map((value) => {
    const target = new URL(value);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.pathname !== '/' ||
      target.search ||
      target.hash
    )
      throw new Error(
        'SIGHTLINE_DEMO_ORIGINS entries must be HTTP(S) origins without credentials or paths',
      );
    return target.origin;
  });
const controlHosts = new Set([
  new URL(origin).host,
  ...demoOrigins.map((value) => new URL(value).host),
]);
const dataDir = resolve(Bun.env.DATA_DIR || './data');
const artifactDir = resolve(dataDir, 'artifacts');
function isDashboardRequest(pathname: string) {
  return (
    pathname === '/' ||
    pathname === '/dashboard' ||
    pathname.startsWith('/dashboard/') ||
    /^\/agent\/[^/]+$/.test(pathname) ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/media/')
  );
}
async function proxyDashboard(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  const headers = new Headers(req.headers);
  headers.delete('host');
  // Bun decodes compressed bodies while keeping content-encoding/content-length,
  // so ask the internal server for an identity body and forward its headers as-is.
  headers.set('accept-encoding', 'identity');
  const upstream = await fetch(`${nextOrigin}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    redirect: 'manual',
  });
  const forwarded = new Headers(upstream.headers);
  if (!url.pathname.startsWith('/_next/')) {
    forwarded.set('X-Frame-Options', 'DENY');
    forwarded.set('Content-Security-Policy', "frame-ancestors 'none'");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwarded,
  });
}
await mkdir(artifactDir, { recursive: true });
await mkdir(resolve(dataDir, 'reports'), { recursive: true });
const backend: Backend = await createBackend();
const terminal: Record<string, true> = { completed: true, failed: true, stopped: true };
const snapshots = new Map<string, ReportSnapshot>();
const snapshotWrites = new Map<string, Promise<ReportSnapshot>>();
const active = new Map<string, Promise<void>>();
interface CachedActivitySummary {
  fingerprint: string;
  summary: ActivitySummary;
  activityCount: number;
}
const activitySummaries = new Map<string, CachedActivitySummary>();
const activitySummaryInFlight = new Map<string, Promise<CachedActivitySummary>>();
const MAX_ACTIVITY_SUMMARIES = 64;
let creating = 0;
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
let broadcasting = false;
let dirty = false;

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
function failure(error: unknown) {
  return json(
    { error: error instanceof Error ? error.message : 'Request failed' },
    error instanceof InputError ? error.status : 503,
  );
}
class InputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function idPart(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new InputError('Invalid run ID');
  return value;
}
function safeMutation(req: Request, expectedOrigin: string) {
  const source = req.headers.get('origin');
  if (
    source &&
    source !== expectedOrigin &&
    !(expectedOrigin === origin && demoOrigins.includes(source))
  )
    throw new InputError('Cross-origin mutations are forbidden', 403);
  if (req.headers.get('sec-fetch-site') === 'cross-site')
    throw new InputError('Cross-site mutations are forbidden', 403);
}
async function body(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length') || 0) > 16384)
    throw new InputError('Request body exceeds 16 KiB', 413);
  const reader = req.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) {
          await reader.cancel();
          throw new InputError('Request body exceeds 16 KiB', 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InputError('Expected JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new InputError('Expected JSON object');
  return parsed as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new InputError(`${label} must contain 1–${max} characters`);
  return value.trim();
}
async function requireRun(id: string) {
  const run = await backend.get(idPart(id));
  if (!run) throw new InputError('Run not found', 404);
  return run;
}
function activitySummaryPayload(run: AgentRun): ActivitySummaryPayload {
  const projected = projectRunActivity(run);
  const cached = activitySummaries.get(run.config.id);
  return {
    runId: run.config.id,
    summary: cached?.summary ?? null,
    // A different visible sequence means the cached bullets no longer describe
    // the whole run. Serving the cache is still free; the operator chooses when
    // to spend another model call.
    stale: cached ? cached.fingerprint !== projected.fingerprint : true,
    canSummarize: projected.activityCount > 0,
    activityCount: projected.activityCount,
  };
}
function rememberActivitySummary(id: string, record: CachedActivitySummary): void {
  const existing = activitySummaries.get(id);
  if ((existing?.summary.generatedAt ?? 0) > record.summary.generatedAt) return;
  activitySummaries.delete(id);
  activitySummaries.set(id, record);
  while (activitySummaries.size > MAX_ACTIVITY_SUMMARIES) {
    const oldest = activitySummaries.keys().next();
    if (oldest.done) break;
    activitySummaries.delete(oldest.value);
  }
}
function summaryFailure(error: unknown): never {
  if (error instanceof SummaryError)
    throw new InputError(
      error.message,
      error.stage === 'empty' ? 409 : error.stage === 'config' ? 503 : 502,
    );
  throw error;
}
async function summarizeRunActivity(run: AgentRun): Promise<{ cached: boolean }> {
  const id = run.config.id;
  const projected = projectRunActivity(run);
  if (projected.activityCount === 0)
    throw new InputError(
      'No visible activity has been recorded for this run yet, so there is nothing to summarize.',
      409,
    );
  const cached = activitySummaries.get(id);
  if (cached && cached.fingerprint === projected.fingerprint) return { cached: true };

  // Coalesce concurrent clicks for the same visible sequence into one call.
  const pending = activitySummaryInFlight.get(id);
  if (pending) {
    const resolved = await pending;
    if (resolved.fingerprint === projected.fingerprint) return { cached: true };
  }

  const publication = (async (): Promise<CachedActivitySummary> => {
    const summary = await generateActivitySummary(run).catch((error: unknown): never =>
      summaryFailure(error),
    );
    return {
      fingerprint: projected.fingerprint,
      summary,
      activityCount: projected.activityCount,
    };
  })();
  activitySummaryInFlight.set(id, publication);
  try {
    rememberActivitySummary(id, await publication);
    return { cached: false };
  } finally {
    if (activitySummaryInFlight.get(id) === publication) activitySummaryInFlight.delete(id);
  }
}
async function broadcast() {
  dirty = true;
  if (broadcasting) return;
  broadcasting = true;
  try {
    while (dirty) {
      dirty = false;
      const runs = await backend.list();
      await Promise.all(
        runs.filter((run) => terminal[run.status]).map((run) => snapshot(run.config.id)),
      );
      const bytes = encoder.encode(`event: runs\ndata: ${JSON.stringify(runs)}\n\n`);
      for (const stream of streams) {
        try {
          if ((stream.desiredSize ?? 0) < 0) {
            stream.close();
            streams.delete(stream);
          } else stream.enqueue(bytes);
        } catch {
          streams.delete(stream);
        }
      }
    }
  } catch (error) {
    console.error(
      'Live state update failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
  } finally {
    broadcasting = false;
  }
}
backend.subscribe(() => {
  void broadcast();
});
async function snapshot(id: string): Promise<ReportSnapshot> {
  const cached = snapshots.get(id);
  if (cached) return cached;
  const pending = snapshotWrites.get(id);
  if (pending) return pending;
  const publication = (async () => {
    const run = await requireRun(id);
    if (!terminal[run.status])
      throw new InputError('Reports become available after the run finishes', 409);
    const path = resolve(dataDir, 'reports', `${id}.json`);
    const file = Bun.file(path);
    if (await file.exists()) {
      const saved = (await file.json()) as ReportSnapshot;
      snapshots.set(id, saved);
      return saved;
    }
    const frozen = createSnapshot(run, await backend.world(id));
    const staging = `${path}.${crypto.randomUUID()}.tmp`;
    await Bun.write(staging, JSON.stringify(frozen));
    await rename(staging, path);
    snapshots.set(id, frozen);
    return frozen;
  })();
  snapshotWrites.set(id, publication);
  try {
    return await publication;
  } finally {
    snapshotWrites.delete(id);
  }
}
function artifactName(path: string) {
  if (!path.startsWith('/artifacts/')) throw new InputError('Invalid artifact reference');
  const name = path.slice('/artifacts/'.length);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,180}$/.test(name) || name.includes('..'))
    throw new InputError('Invalid artifact filename');
  return name;
}
async function registeredArtifact(path: string) {
  const name = artifactName(path);
  const runs = await backend.list();
  if (
    !runs.some(
      (run) =>
        run.latestFrame === path ||
        run.events.some((event) => event.artifact === path) ||
        // Recent screencast frames remain on disk briefly after latestFrame advances.
        // Authorize only generated frame names owned by a registered run.
        (name.startsWith(`${run.config.id}-`) &&
          /^\d{13}-[0-9a-f-]{36}\.jpg$/.test(name.slice(run.config.id.length + 1))),
    )
  )
    throw new InputError('Artifact not found', 404);
  const file = Bun.file(resolve(artifactDir, name));
  if (!(await file.exists())) throw new InputError('Artifact not found', 404);
  if (file.size > 128 * 1024 * 1024) throw new InputError('Artifact exceeds download limit', 413);
  return file;
}
async function assetsFor(report: ReportSnapshot, imagesOnly = false) {
  const paths = new Set(
    report.run.events.map((event) => event.artifact).filter((value): value is string => !!value),
  );
  if (report.run.latestFrame) paths.add(report.run.latestFrame);
  const assets: Record<string, Uint8Array> = {};
  let total = 0;
  for (const path of paths) {
    if (imagesOnly && !/\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i.test(path)) continue;
    try {
      const file = await registeredArtifact(path);
      total += file.size;
      if (total > 256 * 1024 * 1024)
        throw new InputError('Report evidence exceeds 256 MiB export limit', 413);
      assets[path] = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (error instanceof InputError && error.status === 404) continue;
      throw error;
    }
  }
  return assets;
}
function dataAssets(assets: Record<string, Uint8Array>) {
  return Object.fromEntries(
    Object.entries(assets)
      .filter(([path]) => /\.(png|jpe?g|webp)$/.test(path))
      .map(([path, bytes]) => [
        path,
        `data:${path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg'};base64,${Buffer.from(bytes).toString('base64')}`,
      ]),
  );
}
async function markCreatedFailed(
  config: AgentConfig,
  reason: string,
): Promise<'marked' | 'none' | 'error'> {
  try {
    const run = await backend.get(config.id);
    if (!run || terminal[run.status]) return 'none';
    try {
      await backend.append(config.id, {
        kind: 'error',
        text: reason,
        data: { category: 'launch' },
      });
    } catch (error) {
      console.error(
        `Could not append aborted-launch evidence for ${config.id}:`,
        error instanceof Error ? error.message : 'unknown error',
      );
    }
    // The DB permits queued -> failed. These rows never received a worker.
    await backend.patch(config.id, {
      status: 'failed',
      requested: 'stopped',
      error: reason,
      outcome: 'Infrastructure failure',
    });
    return 'marked';
  } catch (error) {
    console.error(
      `Could not mark aborted run ${config.id} failed:`,
      error instanceof Error ? error.message : 'unknown error',
    );
    return 'error';
  }
}
function startPrepared(config: AgentConfig) {
  const work = (async () => {
    try {
      await startAgent(config, backend, {
        origin,
        replicaOrigin,
        artifactDir,
        async onFrame(id, bytes, at) {
          const extension =
            bytes[0] === 0x89 && bytes[1] === 0x50
              ? 'png'
              : bytes[0] === 0xff && bytes[1] === 0xd8
                ? 'jpg'
                : undefined;
          if (!extension) throw new Error('Worker supplied an unsupported frame encoding');
          if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Worker frame exceeds 8 MiB');
          const name = `${idPart(id)}-${at}-${crypto.randomUUID()}.${extension}`;
          await Bun.write(resolve(artifactDir, name), bytes);
          return `/artifacts/${name}`;
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent execution failed';
      await backend.append(config.id, { kind: 'error', text: message });
      await backend.patch(config.id, {
        status: 'failed',
        error: message,
        outcome: 'Infrastructure failure',
      });
    } finally {
      active.delete(config.id);
      let completed = false;
      try {
        const run = await backend.get(config.id);
        completed = run?.status === 'completed';
        if (run && terminal[run.status]) {
          try {
            await snapshot(config.id);
          } catch (error) {
            console.error(
              `Report snapshot for ${config.id} failed:`,
              error instanceof Error ? error.message : 'unknown error',
            );
          }
        }
      } catch (error) {
        console.error(
          `Could not read finalized run ${config.id}:`,
          error instanceof Error ? error.message : 'unknown error',
        );
      }
      if (config.verify && completed) {
        const verification: AgentConfig = {
          ...config,
          id: crypto.randomUUID(),
          name: `${config.name} · verification`,
          verify: false,
          defect: false,
          verificationOf: config.id,
        };
        try {
          await launchBatch([verification]);
        } catch (error) {
          console.error(
            `Automatic verification for ${config.id} could not start:`,
            error instanceof Error ? error.message : 'unknown error',
          );
        }
      }
    }
  })();
  active.set(config.id, work);
  creating -= 1;
  work.catch((error) =>
    console.error(
      'Run finalization failed:',
      error instanceof Error ? error.message : 'unknown error',
    ),
  );
}
async function launchBatch(configs: AgentConfig[]): Promise<string[]> {
  if (configs.length === 0) throw new InputError('At least one agent is required');
  const reservation = configs.length;
  if (active.size + creating + reservation > MAX_CONCURRENT_AGENTS)
    throw new InputError(`At most ${MAX_CONCURRENT_AGENTS} agents may run concurrently`, 409);
  creating += reservation;
  const created: AgentConfig[] = [];
  let attempted: AgentConfig | undefined;
  try {
    for (const config of configs) {
      attempted = config;
      await backend.create(config);
      created.push(config);
    }
  } catch (error) {
    const reason = `Batch launch aborted before any agent started: ${error instanceof Error ? error.message : 'unknown error'}`;
    const cleanupTargets =
      attempted && !created.includes(attempted) ? [...created, attempted] : created;
    const cleanup: Array<{ id: string; result: 'marked' | 'none' | 'error' }> = [];
    for (const config of cleanupTargets)
      cleanup.push({ id: config.id, result: await markCreatedFailed(config, reason) });
    creating -= reservation;
    const createdIds = created.map((config) => config.id);
    const markedIds = cleanup.filter((item) => item.result === 'marked').map((item) => item.id);
    const failedIds = cleanup.filter((item) => item.result === 'error').map((item) => item.id);
    const createdNote = createdIds.length
      ? `Confirmed created rows: ${createdIds.join(', ')}.`
      : 'No run rows were confirmed created.';
    const markedNote = markedIds.length ? ` Marked failed: ${markedIds.join(', ')}.` : '';
    const failureNote = failedIds.length
      ? ` Cleanup failed for ${failedIds.join(', ')}; inspect them in the control room.`
      : '';
    throw new InputError(
      `${reason}. ${createdNote}${markedNote}${failureNote} No workers were started.`,
      503,
    );
  }
  for (const config of created) startPrepared(config);
  return created.map((config) => config.id);
}

const replicaServer = Bun.serve({
  hostname: '127.0.0.1',
  port: replicaPort,
  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.host !== `127.0.0.1:${replicaPort}`) throw new InputError('Invalid host', 403);
      if (req.method === 'GET' && (url.pathname === '/shop' || url.pathname === '/portal')) {
        const id = idPart(url.searchParams.get('agent') || '');
        const run = await requireRun(id);
        if (url.pathname !== `/${run.config.scenario}`)
          throw new InputError('Scenario mismatch', 403);
        return new Response(replicaHtml(run.config.scenario), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'",
          },
        });
      }
      const match = url.pathname.match(/^\/api\/world\/([a-zA-Z0-9_-]+)(?:\/(action|ack))?$/);
      if (!match) return json({ error: 'Not found' }, 404);
      const id = idPart(match[1] ?? '');
      await requireRun(id);
      if (req.method === 'POST') {
        safeMutation(req, replicaOrigin);
        const input = await body(req);
        if (match[2] === 'action') {
          if (
            input.value !== undefined &&
            (typeof input.value !== 'string' || input.value.length > 200)
          )
            throw new InputError('value must be a string of at most 200 characters');
          await backend.worldAction(id, text(input.action, 'action', 40), input.value);
        } else if (match[2] === 'ack') {
          if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
            throw new InputError('Invalid revision');
          await backend.acknowledge(id, Number(input.revision));
        } else throw new InputError('Unknown operation');
      } else if (req.method !== 'GET' || match[2])
        return json({ error: 'Method not allowed' }, 405);
      const { defect: _hidden, ...world } = await backend.world(id);
      return json(world);
    } catch (error) {
      return failure(error);
    }
  },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  // A real summary completion can exceed Bun's 10-second default while the
  // provider reasons. Keep the explicit summary request timeout authoritative.
  idleTimeout: 255,
  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (!controlHosts.has(url.host)) throw new InputError('Invalid host', 403);
      if (isDashboardRequest(url.pathname)) return await proxyDashboard(req);
      if (req.method === 'GET' && url.pathname === '/api/health')
        return json({
          backend: await backend.health(),
          model: await modelHealth(),
          origin,
          replicaOrigin,
        });
      if (req.method === 'GET' && url.pathname === '/api/runs') return json(await backend.list());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>(
          {
            start(value) {
              controller = value;
              streams.add(value);
              value.enqueue(encoder.encode(': connected\n\n'));
              void broadcast();
            },
            cancel() {
              streams.delete(controller);
            },
          },
          { highWaterMark: 2 },
        );
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          },
        });
      }
      if (req.method === 'POST') safeMutation(req, origin);
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const input = await body(req);
        const task = text(input.task, 'Task');
        if (input.scenario !== 'shop' && input.scenario !== 'portal')
          throw new InputError('Unknown scenario');
        const scenario = input.scenario;
        const selected: unknown =
          input.profiles === undefined ? DEFAULT_PROFILE_SELECTION : input.profiles;
        if (
          !Array.isArray(selected) ||
          selected.length < 1 ||
          selected.length > PROFILE_IDS.length ||
          !selected.every(isProfile)
        )
          throw new InputError(`Choose one to ${PROFILE_IDS.length} valid profiles`);
        const selectedProfiles = selected.filter(isProfile);
        if (new Set(selectedProfiles).size !== selectedProfiles.length)
          throw new InputError('Duplicate profiles');
        if (input.verify !== undefined && typeof input.verify !== 'boolean')
          throw new InputError('verify must be a boolean');
        if (input.defect !== undefined && typeof input.defect !== 'boolean')
          throw new InputError('defect must be a boolean');
        if (input.url !== undefined && input.url !== '') {
          const target = new URL(text(input.url, 'URL', 500));
          if (
            target.origin !== replicaOrigin ||
            target.pathname !== `/${scenario}` ||
            target.search ||
            target.hash ||
            target.username ||
            target.password
          )
            throw new InputError(`URL must be ${replicaOrigin}/${scenario}`);
        }
        const configs: AgentConfig[] = selectedProfiles.map((profile) => ({
          id: crypto.randomUUID(),
          name: `${scenario === 'shop' ? 'Shop' : 'Campus'} · ${profile}`,
          profile,
          scenario,
          task,
          url: `${replicaOrigin}/${scenario}`,
          verify: input.verify === true,
          defect: input.defect !== false,
        }));
        return json({ ids: await launchBatch(configs) }, 201);
      }
      const runMatch = url.pathname.match(
        /^\/api\/runs\/([a-zA-Z0-9_-]+)(?:\/(control|messages|verify|summary))?$/,
      );
      if (runMatch) {
        const id = idPart(runMatch[1] ?? '');
        const run = await requireRun(id);
        if (runMatch[2] === 'summary') {
          if (req.method === 'GET') return json(activitySummaryPayload(run));
          if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
          const result = await summarizeRunActivity(run);
          return json({ ...activitySummaryPayload(await requireRun(id)), cached: result.cached });
        }
        if (req.method === 'GET' && !runMatch[2]) return json(run);
        if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        if (runMatch[2] === 'verify') {
          if (!terminal[run.status])
            throw new InputError('Finish the original run before verification', 409);
          const config: AgentConfig = {
            ...run.config,
            id: crypto.randomUUID(),
            name: `${run.config.name} · verification`,
            verify: false,
            defect: false,
            verificationOf: run.config.id,
          };
          await launchBatch([config]);
          return json({ id: config.id }, 201);
        }
        if (terminal[run.status]) throw new InputError('Run is already terminal', 409);
        const input = await body(req);
        if (runMatch[2] === 'control') {
          if (!['running', 'paused', 'stopped'].includes(String(input.command)))
            throw new InputError('Unknown command');
          const command = input.command as 'running' | 'paused' | 'stopped';
          await backend.patch(id, { requested: command });
          commandAgent(id, command);
          await backend.append(id, { kind: 'control', text: `Operator requested ${command}` });
          return json({ requested: command });
        }
        if (runMatch[2] === 'messages') {
          if (input.interrupt !== undefined && typeof input.interrupt !== 'boolean')
            throw new InputError('interrupt must be a boolean');
          const interrupt = input.interrupt === true;
          await backend.message(id, text(input.text, 'Message', 2000), { interrupt });
          // The durable message is written first, so a worker woken by the
          // abort can consume it at the very next boundary.
          const interrupted = interrupt ? interruptAgent(id) : false;
          return json({ accepted: true, interrupt, interrupted });
        }
        throw new InputError('Unknown operation');
      }
      const reportMatch =
        url.pathname.match(/^\/api\/reports\/([a-zA-Z0-9_-]+)\.(json|md|html|zip)$/) ||
        url.pathname.match(/^\/report\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && reportMatch) {
        const id = idPart(reportMatch[1] ?? '');
        const format = reportMatch[2] || 'html';
        const report = await snapshot(id);
        if (format === 'json') return json(report);
        if (format === 'md')
          return new Response(reportMarkdown(report), {
            headers: {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': `attachment; filename="${id}.md"`,
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'private, no-store',
            },
          });
        if (format === 'zip') {
          const assets = await assetsFor(report);
          return new Response(new Blob([new Uint8Array(reportZip(report, assets))]), {
            headers: {
              'Content-Type': 'application/zip',
              'Content-Disposition': `attachment; filename="${id}.zip"`,
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'private, no-store',
            },
          });
        }
        const assets = await assetsFor(report, true);
        return new Response(reportHtml(report, dataAssets(assets)), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Cache-Control': 'private, no-store',
            ...(url.pathname.startsWith('/api/')
              ? { 'Content-Disposition': `attachment; filename="${id}.html"` }
              : {}),
            'Content-Security-Policy':
              "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
        const file = await registeredArtifact(url.pathname);
        return new Response(file, {
          headers: {
            'Cache-Control': 'private, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return failure(error);
    }
  },
});
console.log(`Sightline ready at ${origin} · replicas ${replicaOrigin}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const stopping = [server.stop(), replicaServer.stop()];
  await shutdownWorkers();
  await Promise.all(stopping);
  await Promise.allSettled(active.values());
  await backend.close();
  for (const stream of streams)
    try {
      stream.close();
    } catch {
      /* Disconnected clients may already have closed their stream. */
    }
  process.exit(0);
}
function requestClose() {
  void close().catch((error) => {
    console.error(
      'Sightline shutdown failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
    process.exitCode = 1;
  });
}
process.on('SIGINT', requestClose);
process.on('SIGTERM', requestClose);
