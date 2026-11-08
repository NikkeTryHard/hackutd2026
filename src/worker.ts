import { chromium } from 'playwright';
import type { Browser, BrowserContext, CDPSession, Page, Video } from 'playwright';
import { mkdir, rm, stat, unlink } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type {
  Action,
  AgentConfig,
  AgentRun,
  Backend,
  Command,
  EvidenceEvent,
  Finding,
  OperatorMessage,
  Profile,
  Status,
  WorkerHooks,
  World,
} from './contracts';
import {
  ModelError,
  decide,
  isJpeg,
  isPng,
  isPointerAction,
  modelHealth,
  normalizeKeyCombo,
  pngDimensions,
  validateAction,
  type DecisionResult,
  type ViewBox,
} from './model';
import { PROFILE_DEFINITIONS, isProfile } from './profiles';

/**
 * Screenshot-only Nemotron worker.
 *
 * Every run gets a fresh browser context at 1280x800 / DPR1 with a fresh
 * replica world, screenshot observations, physical input actions, restricted
 * network access, and a terminal write that is the final mutation of the run.
 */

const VIEWPORT: ViewBox = { width: 1280, height: 800 };
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MODEL_TIMEOUT_MS = 90_000;
const SETTLE_MS = 250;
const LIVE_FRAME_INTERVAL_MS = 1_000;
const LIVE_FRAME_MAX = 300;
const LIVE_FRAME_KEEP = 2;
const EVENT_TEXT_MAX = 2_000;
const EVENT_DATA_MAX = 32_768;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_FINDINGS = 50;
const MAX_MESSAGES_RECORDED = 20;
const MAX_MESSAGES_MODEL = 6;
const MESSAGE_TEXT_MAX = 2_000;
const SHUTDOWN_GRACE_MS = 15_000;

const SCENARIO_VALUES: Record<string, true> = { shop: true, portal: true };
const COMMAND_VALUES: Record<string, true> = { running: true, paused: true, stopped: true };
const TERMINAL_STATUS: Record<string, true> = { completed: true, failed: true, stopped: true };
const MODEL_EVENT_KINDS: Record<string, true> = {
  action: true,
  observation: true,
  error: true,
  finding: true,
  claim: true,
  world: true,
};

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}

export class ProfileViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileViolationError';
  }
}

export interface Point {
  x: number;
  y: number;
}

export interface ViewTransform {
  originX: number;
  originY: number;
  scale: number;
  width: number;
  height: number;
}

export interface ExecuteActionOptions {
  seed?: number;
  signal?: AbortSignal;
  viewport?: ViewBox;
  /** Observation-to-viewport transform for coordinates in a crop image. */
  view?: ViewTransform;
  /** Publish the actual mapped pointer position before executing browser input. */
  onCursor?: (point: Point) => Promise<void>;
}

export interface ActionResult {
  type: Action['type'];
  input?: Point;
  inputTo?: Point;
  intended?: Point;
  intendedTo?: Point;
  executed?: Point;
  executedTo?: Point;
  offset?: { dx: number; dy: number };
  note?: string;
}

export interface CropResult {
  bytes: Uint8Array;
  image: ViewBox;
  source: { x: number; y: number; width: number; height: number };
  scale: number;
}

export interface BlockedRequest {
  url: string;
  origin: string;
  path: string;
  resourceType: string;
  reason: string;
}

export interface ContainmentOptions {
  scenario?: AgentConfig['scenario'];
  websocket?: boolean;
}

export interface InstallContainmentOptions {
  scenario?: AgentConfig['scenario'];
  onBlocked?: (blocked: BlockedRequest) => void;
}

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export interface Observation {
  bytes: Uint8Array;
  artifact: string;
  eventId: string;
  view: ViewTransform;
}

type ErrorCategory =
  'model' | 'config' | 'profile' | 'security' | 'scenario' | 'browser' | 'artifact' | 'backend';

interface Terminal {
  status: 'completed' | 'failed' | 'stopped';
  outcome: string;
  error?: string;
  category?: ErrorCategory;
}

interface WorkerState {
  config: AgentConfig;
  backend: Backend;
  hooks: WorkerHooks;
  replicaOrigin: string;
  initialUrl: string;
  artifactDir: string;
  requested: Command;
  status: Status;
  step: number;
  findings: Finding[];
  modelEvents: EvidenceEvent[];
  carriedMessages: OperatorMessage[];
  lastObservationId?: string;
  latestFrame?: string;
  lastDecision?: DecisionResult;
  stop: AbortController;
  decision?: AbortController;
  interruptGeneration: number;
  pausedApplied: boolean;
  wake?: () => void;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  video?: Video;
  videoDir: string;
  videoFailure?: string;
  cdp?: CDPSession;
  cdpFailure?: string;
  traceStarted: boolean;
  traceFailure?: string;
  pageReady: boolean;
  pageFatal?: string;
  nextObservation?: Observation;
  screencast?: ScreencastController;
  worldState?: World;
  worldFingerprint?: string;
  worldCompletedObserved: boolean;
  pendingRevision?: number;
  pendingRevisionSince?: number;
  warnedRevision?: number;
  blockedKeys: Set<string>;
  blockedSuppressed: number;
  pendingWrites: Set<Promise<void>>;
  liveOnlyPaths: Set<string>;
  protectedPaths: Set<string>;
  pointerSeed: number;
  startedAt: number;
  closing: boolean;
  closed: boolean;
  shuttingDown: boolean;
  skip: boolean;
}

type FileOutcome =
  { ok: true; artifact: string; bytes: number; sha256: string } | { ok: false; reason: string };

const workers = new Map<string, WorkerState>();
const activeRuns = new Map<string, Promise<void>>();
let shuttingDown = false;

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  if (signal.aborted) return Promise.reject(abortError());
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    reject(abortError());
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  const { promise: raced, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => {
    signal.removeEventListener('abort', onAbort);
    reject(abortError());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  promise.then(
    (value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    },
    (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    },
  );
  return raced;
}

function createDeferred(): Deferred {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    promise,
    resolve: () => {
      resolve();
    },
  };
}

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mixSeed(seed: number, step: number): number {
  let value = (seed ^ Math.imul(step, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return value >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function nextPointerOffset(random: () => number): number {
  const magnitude = 1 + Math.floor(random() * 6);
  return random() < 0.5 ? -magnitude : magnitude;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function formatPoint(point: Point): string {
  return `(${formatNumber(point.x)}, ${formatNumber(point.y)})`;
}

function scrubSecrets(value: string): string {
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key || key.length < 4) return value;
  return value.split(key).join('[redacted]');
}

function limitText(value: string, max: number): string {
  const clean = scrubSecrets(value.replaceAll('\u0000', ''));
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return limitText(message, 2_000);
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function stoppedTerminal(state: WorkerState): Terminal {
  return {
    status: 'stopped',
    outcome: state.shuttingDown
      ? 'Stopped by worker shutdown'
      : 'Stopped by operator at action boundary',
  };
}

function stopRequested(state: WorkerState): boolean {
  return state.shuttingDown || state.requested === 'stopped';
}

function pauseRequested(state: WorkerState): boolean {
  return state.requested === 'paused';
}

function terminalCategory(error: unknown): ErrorCategory {
  if (error instanceof ModelError) return 'model';
  if (error instanceof WorkerConfigError) return 'config';
  if (error instanceof ProfileViolationError) return 'profile';
  return 'backend';
}

function assertViewport(view: ViewBox): void {
  if (
    !Number.isInteger(view.width) ||
    !Number.isInteger(view.height) ||
    view.width < 1 ||
    view.height < 1 ||
    view.width > 4096 ||
    view.height > 4096
  ) {
    throw new Error(`Invalid viewport ${view.width}x${view.height}.`);
  }
}

function assertView(view: ViewTransform): void {
  if (!Number.isFinite(view.scale) || view.scale <= 0)
    throw new Error('Observation view scale must be positive.');
  if (
    !Number.isFinite(view.width) ||
    !Number.isFinite(view.height) ||
    view.width < 1 ||
    view.height < 1
  )
    throw new Error('Observation view dimensions are invalid.');
  if (!Number.isFinite(view.originX) || !Number.isFinite(view.originY))
    throw new Error('Observation view origin is invalid.');
}

/** Maps a point in the current observation image back to viewport coordinates. */
export function mapObservationPoint(
  view: ViewTransform,
  point: Point,
  viewport: ViewBox = VIEWPORT,
): Point {
  assertViewport(viewport);
  assertView(view);
  if (point.x < 0 || point.y < 0 || point.x >= view.width || point.y >= view.height) {
    throw new Error(
      `Coordinate ${formatPoint(point)} lies outside the current observation ${view.width}x${view.height}.`,
    );
  }
  const x = view.originX + point.x / view.scale;
  const y = view.originY + point.y / view.scale;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    throw new Error(
      `Mapped coordinate ${formatPoint({ x, y })} lies outside the ${viewport.width}x${viewport.height} viewport.`,
    );
  }
  return { x, y };
}

function pointerPoint(
  view: ViewTransform | undefined,
  point: Point,
  viewport: ViewBox,
  random: () => number,
  applyOffset: boolean,
): { intended: Point; executed: Point; offset?: { dx: number; dy: number } } {
  const intended = view ? mapObservationPoint(view, point, viewport) : point;
  if (
    intended.x < 0 ||
    intended.y < 0 ||
    intended.x >= viewport.width ||
    intended.y >= viewport.height
  ) {
    throw new Error(
      `Pointer coordinate ${formatPoint(intended)} lies outside the ${viewport.width}x${viewport.height} viewport.`,
    );
  }
  if (!applyOffset) return { intended, executed: intended };
  const dx = nextPointerOffset(random);
  const dy = nextPointerOffset(random);
  const executed = {
    x: Math.min(viewport.width - 1, Math.max(0, intended.x + dx)),
    y: Math.min(viewport.height - 1, Math.max(0, intended.y + dy)),
  };
  return { intended, executed, offset: { dx, dy } };
}

/**
 * Executes one physical browser action. Keyboard profiles reject pointer
 * actions here, at the executor boundary, before any browser input is sent.
 */
export async function executeAction(
  page: Page,
  action: Action,
  profile: Profile,
  step: number,
  options: ExecuteActionOptions = {},
): Promise<ActionResult> {
  if (!isProfile(profile)) throw new WorkerConfigError(`Unknown profile "${String(profile)}".`);
  if (profile === 'keyboard' && isPointerAction(action)) {
    throw new ProfileViolationError(
      `Keyboard-only profile rejected pointer action "${action.type}" at step ${step}.`,
    );
  }
  const viewport = options.viewport ?? VIEWPORT;
  assertViewport(viewport);
  if (options.view) assertView(options.view);
  const random = mulberry32(
    options.seed === undefined ? hashSeed(`${profile}:${step}`) : options.seed >>> 0,
  );
  const applyOffset = profile === 'pointer';

  switch (action.type) {
    case 'click':
    case 'move': {
      const pointer = pointerPoint(
        options.view,
        { x: action.x, y: action.y },
        viewport,
        random,
        applyOffset,
      );
      await options.onCursor?.(pointer.executed);
      if (action.type === 'click') await page.mouse.click(pointer.executed.x, pointer.executed.y);
      else await page.mouse.move(pointer.executed.x, pointer.executed.y);
      return {
        type: action.type,
        input: { x: action.x, y: action.y },
        intended: pointer.intended,
        executed: pointer.executed,
        offset: pointer.offset,
      };
    }
    case 'drag': {
      const start = pointerPoint(
        options.view,
        { x: action.x, y: action.y },
        viewport,
        random,
        applyOffset,
      );
      const end = pointerPoint(
        options.view,
        { x: action.toX, y: action.toY },
        viewport,
        random,
        applyOffset,
      );
      await options.onCursor?.(start.executed);
      await page.mouse.move(start.executed.x, start.executed.y);
      await page.mouse.down();
      await options.onCursor?.(end.executed);
      await page.mouse.move(end.executed.x, end.executed.y, { steps: 8 });
      await page.mouse.up();
      return {
        type: 'drag',
        input: { x: action.x, y: action.y },
        inputTo: { x: action.toX, y: action.toY },
        intended: start.intended,
        intendedTo: end.intended,
        executed: start.executed,
        executedTo: end.executed,
        offset: start.offset ?? end.offset,
      };
    }
    case 'scroll': {
      if (!Number.isFinite(action.dx) || !Number.isFinite(action.dy))
        throw new Error('scroll deltas must be finite numbers.');
      await page.mouse.wheel(action.dx, action.dy);
      return { type: 'scroll' };
    }
    case 'key': {
      const key = normalizeKeyCombo(action.key);
      await page.keyboard.press(key);
      return { type: 'key', note: `pressed ${key}` };
    }
    case 'type': {
      if (!action.text || action.text.length > 500)
        throw new Error('type text must contain 1–500 characters.');
      await page.keyboard.type(action.text, { delay: 0 });
      return { type: 'type' };
    }
    case 'wait': {
      if (!Number.isInteger(action.ms) || action.ms < 1 || action.ms > 10_000)
        throw new Error('wait ms must be an integer between 1 and 10000.');
      await delay(action.ms, options.signal);
      return { type: 'wait', note: `waited ${action.ms} ms` };
    }
    case 'observe':
      return { type: 'observe', note: 'Observation is captured by the worker.' };
    case 'crop':
      throw new Error(
        'crop is an observation action handled by cropObservation(), not a browser input.',
      );
    case 'report':
      throw new Error('report is an evidence action handled by the worker loop.');
    case 'finish':
      throw new Error('finish is a terminal action handled by the worker loop.');
    default:
      throw new Error('Unsupported action type.');
  }
}

/**
 * Extracts a rectangular crop from an existing PNG observation and scales it
 * with sharp. The returned source rectangle and scale are the metadata needed
 * to map later crop-image clicks back to the original viewport.
 */
export async function cropObservation(
  bytes: Uint8Array,
  action: Extract<Action, { type: 'crop' }>,
): Promise<CropResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24)
    throw new Error('Crop source must be a PNG observation.');
  const sourceImage = pngDimensions(bytes);
  const checked = validateAction(action, { view: sourceImage });
  if (checked.type !== 'crop') throw new Error('cropObservation requires a crop action.');
  const outputWidth = Math.round(checked.width * checked.scale);
  const outputHeight = Math.round(checked.height * checked.scale);
  if (
    outputWidth < 1 ||
    outputHeight < 1 ||
    outputWidth > VIEWPORT.width ||
    outputHeight > VIEWPORT.height
  ) {
    throw new Error(
      `Crop output ${outputWidth}x${outputHeight} exceeds the ${VIEWPORT.width}x${VIEWPORT.height} limit.`,
    );
  }
  let buffer: Buffer;
  try {
    buffer = await sharp(bytes)
      .extract({ left: checked.x, top: checked.y, width: checked.width, height: checked.height })
      .resize({
        width: outputWidth,
        height: outputHeight,
        fit: 'fill',
        kernel: sharp.kernel.nearest,
      })
      .png({ compressionLevel: 6 })
      .toBuffer();
  } catch (error) {
    throw new Error(`Crop failed: ${errorMessage(error)}`, { cause: error });
  }
  const cropped = new Uint8Array(buffer);
  const actual = pngDimensions(cropped);
  if (actual.width !== outputWidth || actual.height !== outputHeight) {
    throw new Error(
      `Crop produced ${actual.width}x${actual.height}, expected ${outputWidth}x${outputHeight}.`,
    );
  }
  return {
    bytes: cropped,
    image: actual,
    source: { x: checked.x, y: checked.y, width: checked.width, height: checked.height },
    scale: checked.scale,
  };
}

function artifactBasename(path: string): string {
  const match = /^\/artifacts\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,180})$/.exec(path);
  const name = match?.[1];
  if (!name || name.includes('..'))
    throw new Error(`Invalid artifact reference "${limitText(path, 200)}".`);
  return name;
}

function artifactFile(state: WorkerState, path: string): string {
  const name = artifactBasename(path);
  const file = resolve(state.artifactDir, name);
  if (!file.startsWith(`${state.artifactDir}${sep}`))
    throw new Error('Artifact path escaped the artifact directory.');
  return file;
}

async function unlinkArtifact(state: WorkerState, path: string): Promise<void> {
  try {
    await unlink(artifactFile(state, path));
  } catch {
    // A superseded live frame may already be gone; it is never referenced by evidence.
  }
}

/** Validates and canonicalizes one HTTP(S)/WS(S) replica request for this agent. */
export function replicaRequestAllowed(
  url: URL,
  replicaOrigin: string,
  agentId: string,
  options: ContainmentOptions = {},
): { ok: true } | { ok: false; reason: string } {
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:')
    return { ok: true };
  const websocket = url.protocol === 'ws:' || url.protocol === 'wss:';
  if (websocket) {
    if (!options.websocket) return { ok: false, reason: 'websocket URL on an HTTP route' };
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed` };
  }
  const comparable = new URL(url.toString());
  if (websocket) comparable.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  if (comparable.origin !== replicaOrigin) return { ok: false, reason: 'foreign origin' };
  if (comparable.username || comparable.password)
    return { ok: false, reason: 'credentials in URL' };

  if (comparable.pathname === '/shop' || comparable.pathname === '/portal') {
    if (options.websocket) return { ok: false, reason: 'websocket document path is not allowed' };
    if (options.scenario && comparable.pathname !== `/${options.scenario}`)
      return { ok: false, reason: 'wrong scenario route' };
    for (const key of comparable.searchParams.keys()) {
      if (key !== 'agent' && key !== 'agentId')
        return { ok: false, reason: `unexpected document query parameter "${limitText(key, 40)}"` };
    }
    const agentValues = comparable.searchParams.getAll('agent');
    if (agentValues.length !== 1 || agentValues[0] !== agentId)
      return { ok: false, reason: 'document agent ID mismatch' };
    const aliases = comparable.searchParams.getAll('agentId');
    if (aliases.some((value) => value !== agentId))
      return { ok: false, reason: 'document agent ID mismatch' };
    return { ok: true };
  }

  const match = /^\/api\/world\/([^/]+)(?:\/(action|ack))?$/.exec(comparable.pathname);
  if (!match) return { ok: false, reason: 'replica path is not allowed' };
  const encodedId = match[1] ?? '';
  let pathId: string;
  try {
    pathId = decodeURIComponent(encodedId);
  } catch {
    return { ok: false, reason: 'world ID is not valid percent encoding' };
  }
  if (pathId !== agentId) return { ok: false, reason: 'other agent world ID' };
  for (const key of ['agent', 'agentId']) {
    if (comparable.searchParams.getAll(key).some((value) => value !== agentId))
      return { ok: false, reason: 'query agent ID mismatch' };
  }
  return { ok: true };
}

/**
 * Installs the worker's network containment on a real BrowserContext:
 * cross-origin/file/dashboard requests are aborted, replica paths must belong
 * to this agent's own world, and WebSockets obey the same origin/ID rules.
 */
export async function installRequestContainment(
  context: BrowserContext,
  replicaOrigin: string,
  agentId: string,
  options: InstallContainmentOptions = {},
): Promise<void> {
  let expectedOrigin: string;
  try {
    const parsed = new URL(replicaOrigin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)');
    expectedOrigin = parsed.origin;
  } catch {
    throw new WorkerConfigError('Replica origin must be a valid http(s) URL.');
  }
  const report = (blocked: BlockedRequest) => {
    try {
      options.onBlocked?.(blocked);
    } catch {
      // A reporting callback must never interfere with request containment.
    }
  };

  await context.route('**/*', async (route) => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      report({
        url: request.url(),
        origin: 'invalid',
        path: '',
        resourceType: request.resourceType(),
        reason: 'invalid URL',
      });
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    const allowed = replicaRequestAllowed(url, expectedOrigin, agentId, {
      scenario: options.scenario,
    });
    if (!allowed.ok) {
      report({
        url: url.toString(),
        origin: url.origin,
        path: url.pathname,
        resourceType: request.resourceType(),
        reason: allowed.reason,
      });
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });

  await context.routeWebSocket(
    () => true,
    (route) => {
      let url: URL;
      try {
        url = new URL(route.url());
      } catch {
        report({
          url: route.url(),
          origin: 'invalid',
          path: '',
          resourceType: 'websocket',
          reason: 'invalid URL',
        });
        void route.close({ code: 1008, reason: 'Blocked by Sightline' }).catch(() => undefined);
        return;
      }
      const allowed = replicaRequestAllowed(url, expectedOrigin, agentId, {
        scenario: options.scenario,
        websocket: true,
      });
      if (!allowed.ok) {
        report({
          url: url.toString(),
          origin: url.origin,
          path: url.pathname,
          resourceType: 'websocket',
          reason: allowed.reason,
        });
        void route.close({ code: 1008, reason: 'Blocked by Sightline' }).catch(() => undefined);
        return;
      }
      try {
        route.connectToServer();
      } catch {
        void route.close({ code: 1008, reason: 'Blocked by Sightline' }).catch(() => undefined);
      }
    },
  );
}

function validateAgentConfig(config: AgentConfig): void {
  if (!config || typeof config !== 'object')
    throw new WorkerConfigError('Agent configuration is missing.');
  if (typeof config.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(config.id))
    throw new WorkerConfigError(
      'Agent ID must contain 1–100 letters, digits, underscores or dashes.',
    );
  if (!isProfile(config.profile))
    throw new WorkerConfigError(`Unknown profile "${String(config.profile)}".`);
  if (!SCENARIO_VALUES[config.scenario])
    throw new WorkerConfigError(`Unknown scenario "${String(config.scenario)}".`);
  if (typeof config.task !== 'string' || !config.task.trim() || config.task.length > 4_000)
    throw new WorkerConfigError('Agent task must contain 1–4000 characters.');
  if (typeof config.verify !== 'boolean') throw new WorkerConfigError('verify must be a boolean.');
  if (config.defect !== undefined && typeof config.defect !== 'boolean')
    throw new WorkerConfigError('defect must be a boolean when present.');
  if (config.url !== undefined && (typeof config.url !== 'string' || config.url.length > 500))
    throw new WorkerConfigError('url must be a string of at most 500 characters.');
}

function createState(config: AgentConfig, backend: Backend, hooks: WorkerHooks): WorkerState {
  validateAgentConfig(config);
  if (!hooks || typeof hooks !== 'object') throw new WorkerConfigError('Worker hooks are missing.');
  if (typeof hooks.onFrame !== 'function')
    throw new WorkerConfigError('Worker onFrame hook is missing.');
  let replica: URL;
  try {
    replica = new URL(hooks.replicaOrigin);
  } catch {
    throw new WorkerConfigError('Replica origin is not a valid URL.');
  }
  if (replica.protocol !== 'http:' && replica.protocol !== 'https:')
    throw new WorkerConfigError('Replica origin must use http or https.');
  const host = replica.hostname.toLowerCase();
  if (!(
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  )) {
    throw new WorkerConfigError('Replica origin must be a loopback host.');
  }
  if (replica.username || replica.password)
    throw new WorkerConfigError('Replica origin must not contain credentials.');
  const base = `${replica.origin}/${config.scenario}`;
  if (config.url !== undefined && config.url !== '') {
    let supplied: URL;
    try {
      supplied = new URL(config.url);
    } catch {
      throw new WorkerConfigError('Agent url is not a valid URL.');
    }
    if (
      supplied.origin !== replica.origin ||
      supplied.pathname !== `/${config.scenario}` ||
      supplied.search ||
      supplied.hash ||
      supplied.username ||
      supplied.password
    ) {
      throw new WorkerConfigError(`Agent url must be exactly ${base}.`);
    }
  }
  if (typeof hooks.artifactDir !== 'string' || !hooks.artifactDir.trim())
    throw new WorkerConfigError('Artifact directory is missing.');
  const startedAt = Date.now();
  const artifactDir = resolve(hooks.artifactDir);
  return {
    config,
    backend,
    hooks,
    replicaOrigin: replica.origin,
    initialUrl: `${base}?agent=${encodeURIComponent(config.id)}`,
    artifactDir,
    requested: 'running',
    status: 'queued',
    step: 0,
    findings: [],
    modelEvents: [],
    carriedMessages: [],
    stop: new AbortController(),
    interruptGeneration: 0,
    pausedApplied: false,
    videoDir: resolve(artifactDir, `.video-${config.id}-${startedAt}`),
    traceStarted: false,
    pageReady: false,
    worldCompletedObserved: false,
    blockedKeys: new Set(),
    blockedSuppressed: 0,
    pendingWrites: new Set(),
    liveOnlyPaths: new Set(),
    protectedPaths: new Set(),
    pointerSeed: hashSeed(`${config.profile}\u0000${config.scenario}\u0000${config.task}`),
    startedAt,
    closing: false,
    closed: false,
    shuttingDown: false,
    skip: false,
  };
}

async function appendEvent(
  state: WorkerState,
  input: Omit<EvidenceEvent, 'id' | 'agentId' | 'seq' | 'at'>,
): Promise<EvidenceEvent> {
  const text = limitText(input.text, EVENT_TEXT_MAX);
  const payload: Omit<EvidenceEvent, 'id' | 'agentId' | 'seq' | 'at'> = { kind: input.kind, text };
  if (input.artifact !== undefined)
    payload.artifact = `/artifacts/${artifactBasename(input.artifact)}`;
  if (input.data !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(input.data);
    } catch {
      throw new Error('Evidence data is not JSON serializable.');
    }
    if (serialized.length > EVENT_DATA_MAX)
      throw new Error(`Evidence data exceeds the ${EVENT_DATA_MAX}-byte bound.`);
    payload.data = input.data;
  }
  const event = await state.backend.append(state.config.id, payload);
  if (MODEL_EVENT_KINDS[event.kind]) {
    state.modelEvents.push(event);
    if (state.modelEvents.length > 40) state.modelEvents.splice(0, state.modelEvents.length - 40);
  }
  if (event.kind === 'observation' && event.artifact) state.lastObservationId = event.id;
  return event;
}

function trackWrite(state: WorkerState, promise: Promise<unknown>): void {
  const tracked = promise.then(
    () => undefined,
    () => undefined,
  );
  state.pendingWrites.add(tracked);
  void tracked.then(() => {
    state.pendingWrites.delete(tracked);
  });
}

async function recordSecurity(
  state: WorkerState,
  key: string,
  text: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (state.closing || state.closed) return;
  if (state.blockedKeys.has(key)) return;
  if (state.blockedKeys.size >= 10) {
    state.blockedSuppressed += 1;
    return;
  }
  state.blockedKeys.add(key);
  try {
    await appendEvent(state, { kind: 'error', text, data: { category: 'security', ...data } });
  } catch {
    // Backend failure surfaces on the next worker operation.
  }
}

async function recordBlockedRequest(state: WorkerState, blocked: BlockedRequest): Promise<void> {
  if (
    blocked.origin === state.replicaOrigin &&
    (blocked.path === '/favicon.ico' || blocked.path === '/robots.txt')
  )
    return;
  const target = `${blocked.origin}${blocked.path}`;
  await recordSecurity(
    state,
    `request:${target}`,
    `Blocked browser request (${blocked.reason}): ${limitText(target, 300)}`,
    {
      resourceType: blocked.resourceType,
      origin: blocked.origin,
      path: blocked.path,
      reason: blocked.reason,
    },
  );
}

function publicWorld(world: World): Record<string, unknown> {
  return {
    agentId: world.agentId,
    scenario: world.scenario,
    revision: world.revision,
    stock: world.stock,
    notice: limitText(world.notice, 500),
    cart: world.cart,
    selected: limitText(world.selected, 200),
    completed: world.completed,
    panels: world.panels.slice(0, 32).map((panel) => limitText(panel, 120)),
    appliedRevision: world.appliedRevision,
  };
}

async function recordWorld(state: WorkerState, world: World, initial: boolean): Promise<void> {
  assertWorld(state, world);
  const publicState = publicWorld(world);
  const fingerprint = JSON.stringify(publicState);
  if (fingerprint === state.worldFingerprint) return;
  const wasCompleted = state.worldState?.completed === true;
  state.worldState = world;
  state.worldFingerprint = fingerprint;
  await appendEvent(state, {
    kind: 'world',
    text: initial
      ? `Initial world state (revision ${world.revision})`
      : `World revision ${world.revision} (applied ${world.appliedRevision})`,
    data: publicState,
  });
  if (world.completed && !wasCompleted && !state.worldCompletedObserved) {
    state.worldCompletedObserved = true;
    await appendEvent(state, {
      kind: 'observation',
      text: 'Observed world state: checkout completed',
      data: { observed: 'completed', revision: world.revision },
    });
  } else if (world.completed) {
    state.worldCompletedObserved = true;
  }
}

function assertWorld(state: WorkerState, world: World): void {
  if (world.agentId !== state.config.id)
    throw new WorkerConfigError(
      `World belongs to a different agent (${limitText(world.agentId, 100)}).`,
    );
  if (world.scenario !== state.config.scenario)
    throw new WorkerConfigError(
      `World scenario ${world.scenario} does not match run scenario ${state.config.scenario}.`,
    );
}

async function pollWorld(state: WorkerState): Promise<void> {
  const world = await state.backend.world(state.config.id);
  await recordWorld(state, world, false);
  if (world.appliedRevision < world.revision) {
    if (state.pendingRevision !== world.revision) {
      state.pendingRevision = world.revision;
      state.pendingRevisionSince = Date.now();
    } else if (
      state.pendingRevisionSince !== undefined &&
      state.warnedRevision !== world.revision &&
      Date.now() - state.pendingRevisionSince > 8_000
    ) {
      state.warnedRevision = world.revision;
      await appendEvent(state, {
        kind: 'error',
        text: `Replica did not acknowledge world revision ${world.revision} (applied ${world.appliedRevision}) within 8000 ms.`,
        data: {
          category: 'scenario',
          revision: world.revision,
          appliedRevision: world.appliedRevision,
        },
      });
    }
  } else {
    state.pendingRevision = undefined;
    state.pendingRevisionSince = undefined;
  }
}

async function artifactOutcomeFromFile(state: WorkerState, path: string): Promise<FileOutcome> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1)
      return { ok: false, reason: 'artifact file is empty or missing' };
    if (info.size > MAX_ARTIFACT_BYTES) {
      await unlink(path).catch(() => undefined);
      return {
        ok: false,
        reason: `artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte download limit`,
      };
    }
    const artifact = `/artifacts/${basename(path)}`;
    artifactBasename(artifact);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    state.protectedPaths.add(artifact);
    return { ok: true, artifact, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function persistCanonicalArtifact(state: WorkerState, bytes: Uint8Array): Promise<string> {
  const artifact = await state.hooks.onFrame(state.config.id, bytes, Date.now());
  artifactBasename(artifact);
  state.protectedPaths.add(artifact);
  return artifact;
}

async function captureObservation(state: WorkerState, text: string): Promise<Observation> {
  const page = state.page;
  if (!page || page.isClosed())
    throw new Error('Browser page is not available for a screenshot observation.');
  let buffer: Buffer;
  try {
    buffer = await page.screenshot({ type: 'png', caret: 'hide', timeout: PAGE_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`Viewport screenshot failed: ${errorMessage(error)}`, { cause: error });
  }
  const bytes = new Uint8Array(buffer);
  if (!isPng(bytes)) throw new Error('Viewport screenshot was not a PNG image.');
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES)
    throw new Error(`Viewport screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes.`);
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== VIEWPORT.width || dimensions.height !== VIEWPORT.height) {
    throw new Error(
      `Viewport screenshot is ${dimensions.width}x${dimensions.height}, expected ${VIEWPORT.width}x${VIEWPORT.height}.`,
    );
  }
  const artifact = await persistCanonicalArtifact(state, bytes);
  const view: ViewTransform = {
    originX: 0,
    originY: 0,
    scale: 1,
    width: dimensions.width,
    height: dimensions.height,
  };
  const event = await appendEvent(state, {
    kind: 'observation',
    text,
    artifact,
    data: { width: dimensions.width, height: dimensions.height, sha256: sha256Hex(bytes), view },
  });
  state.latestFrame = artifact;
  await state.backend.patch(state.config.id, { latestFrame: artifact });
  return { bytes, artifact, eventId: event.id, view };
}

async function cropObservationAndRecord(
  state: WorkerState,
  source: Observation,
  action: Extract<Action, { type: 'crop' }>,
): Promise<Observation> {
  const crop = await cropObservation(source.bytes, action);
  const artifact = await persistCanonicalArtifact(state, crop.bytes);
  const view: ViewTransform = {
    originX: source.view.originX + crop.source.x / source.view.scale,
    originY: source.view.originY + crop.source.y / source.view.scale,
    scale: source.view.scale * crop.scale,
    width: crop.image.width,
    height: crop.image.height,
  };
  const event = await appendEvent(state, {
    kind: 'observation',
    text: `Magnified crop ${crop.image.width}x${crop.image.height} from (${crop.source.x}, ${crop.source.y}) at scale ${formatNumber(crop.scale)}`,
    artifact,
    data: {
      width: crop.image.width,
      height: crop.image.height,
      sha256: sha256Hex(crop.bytes),
      view,
      crop: {
        x: crop.source.x,
        y: crop.source.y,
        width: crop.source.width,
        height: crop.source.height,
        scale: crop.scale,
      },
    },
  });
  return { bytes: crop.bytes, artifact, eventId: event.id, view };
}

async function persistLiveFrame(state: WorkerState, bytes: Uint8Array): Promise<void> {
  const artifact = await state.hooks.onFrame(state.config.id, bytes, Date.now());
  artifactBasename(artifact);
  if (state.protectedPaths.has(artifact)) return;
  state.liveOnlyPaths.add(artifact);
  state.latestFrame = artifact;
  await state.backend.patch(state.config.id, { latestFrame: artifact });
  const paths = [...state.liveOnlyPaths];
  while (paths.length > LIVE_FRAME_KEEP) {
    const old = paths.shift();
    if (old === undefined) break;
    state.liveOnlyPaths.delete(old);
    if (old !== state.latestFrame && !state.protectedPaths.has(old))
      await unlinkArtifact(state, old);
  }
}

class ScreencastController {
  private stopped = false;
  private stopping = false;
  private busy = false;
  private failed = false;
  private capped = false;
  private lastPersistAt = 0;
  private writes = 0;
  private idle?: Deferred;

  constructor(
    private readonly state: WorkerState,
    private readonly cdp: CDPSession,
  ) {}

  async start(): Promise<void> {
    this.cdp.on('Page.screencastFrame', this.handleFrame);
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    });
  }

  async stop(waitForIdle = true): Promise<void> {
    this.stopping = true;
    if (waitForIdle) await this.waitForIdle();
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.cdp.send('Page.stopScreencast');
    } catch {
      // The CDP session may already be gone during a crash or shutdown.
    }
  }

  private async waitForIdle(): Promise<void> {
    while (this.busy) {
      const idle = this.idle;
      if (!idle) return;
      await idle.promise;
    }
  }

  private readonly handleFrame = (event: unknown): void => {
    void this.process(event);
  };

  private async process(event: unknown): Promise<void> {
    const record = typeof event === 'object' && event !== null ? event : undefined;
    const sessionId =
      record && 'sessionId' in record && typeof record.sessionId === 'number'
        ? record.sessionId
        : undefined;
    const data =
      record && 'data' in record && typeof record.data === 'string' ? record.data : undefined;
    if (this.stopped || this.stopping || this.state.closing || this.state.closed) {
      await this.ack(sessionId);
      return;
    }
    if (this.busy) {
      await this.ack(sessionId);
      return;
    }
    this.busy = true;
    this.idle = createDeferred();
    try {
      const wait = Math.max(0, this.lastPersistAt + LIVE_FRAME_INTERVAL_MS - Date.now());
      if (wait > 0) await delay(wait);
      if (this.stopped || this.stopping || this.state.closing || this.state.closed) return;
      if (this.writes >= LIVE_FRAME_MAX) {
        if (!this.capped) {
          this.capped = true;
          await appendEvent(this.state, {
            kind: 'state',
            text: `Live frame cap reached (${LIVE_FRAME_MAX}); canonical observations continue.`,
            data: { maxLiveFrames: LIVE_FRAME_MAX },
          });
        }
        await this.stop(false);
        return;
      }
      if (!data) return;
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      if (!isJpeg(bytes) && !isPng(bytes)) return;
      await persistLiveFrame(this.state, bytes);
      this.lastPersistAt = Date.now();
      this.writes += 1;
    } catch (error) {
      if (!this.failed) {
        this.failed = true;
        try {
          await appendEvent(this.state, {
            kind: 'error',
            text: `Live frame persistence failed: ${errorMessage(error)}`,
            data: { category: 'artifact' },
          });
        } catch {
          // The run loop will report backend failure.
        }
      }
      await this.stop(false);
    } finally {
      this.busy = false;
      await this.ack(sessionId);
      this.idle?.resolve();
      this.idle = undefined;
    }
  }

  private async ack(sessionId: number | undefined): Promise<void> {
    if (sessionId === undefined) return;
    try {
      await this.cdp.send('Page.screencastFrameAck', { sessionId });
    } catch {
      // The CDP session may already be gone.
    }
  }
}

async function setupBrowser(state: WorkerState): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    timeout: 30_000,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-dev-shm-usage',
      '--no-first-run',
    ],
  });
  state.browser = browser;
  await mkdir(state.videoDir, { recursive: true });
  const shared = {
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    screen: { width: VIEWPORT.width, height: VIEWPORT.height },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light' as const,
    serviceWorkers: 'block' as const,
    acceptDownloads: false,
    storageState: { cookies: [], origins: [] },
  };
  let context: BrowserContext;
  try {
    context = await browser.newContext({
      ...shared,
      recordVideo: {
        dir: state.videoDir,
        size: { width: VIEWPORT.width, height: VIEWPORT.height },
      },
    });
  } catch (error) {
    state.videoFailure = `Video recording unavailable: ${errorMessage(error)}`;
    context = await browser.newContext(shared);
  }
  state.context = context;
  await installRequestContainment(context, state.replicaOrigin, state.config.id, {
    scenario: state.config.scenario,
    onBlocked: (blocked) => {
      trackWrite(state, recordBlockedRequest(state, blocked));
    },
  });

  const page = await context.newPage();
  state.page = page;
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  state.video = page.video() ?? undefined;
  if (!state.video && !state.videoFailure)
    state.videoFailure = 'Video recording was not enabled by the browser.';

  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    state.traceStarted = true;
  } catch (error) {
    state.traceFailure = `Trace could not start: ${errorMessage(error)}`;
  }

  page.on('download', (download) => {
    void download.cancel().catch(() => undefined);
    trackWrite(
      state,
      recordSecurity(state, 'download', 'Blocked a browser download.', {
        category: 'security',
        event: 'download',
      }),
    );
  });
  page.on('filechooser', (chooser) => {
    void chooser.setFiles([]).catch(() => undefined);
    trackWrite(
      state,
      recordSecurity(state, 'filechooser', 'Blocked a browser file chooser.', {
        category: 'security',
        event: 'filechooser',
      }),
    );
  });
  page.on('dialog', (dialog) => {
    void dialog.dismiss().catch(() => undefined);
    trackWrite(
      state,
      recordSecurity(
        state,
        'dialog',
        `Dismissed a browser dialog: ${limitText(dialog.message(), 200)}`,
        { category: 'browser', event: 'dialog' },
      ),
    );
  });
  page.on('popup', (popup) => {
    trackWrite(state, closePopup(state, popup));
  });
  context.on('page', (popup) => {
    if (popup === state.page) return;
    trackWrite(state, closePopup(state, popup));
  });
  page.on('crash', () => {
    if (state.closing || state.closed) return;
    state.pageFatal = 'Browser page crashed.';
    trackWrite(
      state,
      recordSecurity(state, 'page-crash', 'Browser page crashed during the run.', {
        category: 'browser',
        event: 'crash',
      }),
    );
  });
  page.on('close', () => {
    if (state.closing || state.closed) return;
    state.pageFatal = 'Browser page closed unexpectedly.';
  });

  const visionDeficiency = PROFILE_DEFINITIONS[state.config.profile].visionDeficiency;
  try {
    state.cdp = await context.newCDPSession(page);
  } catch (error) {
    state.cdpFailure = `Live CDP session unavailable: ${errorMessage(error)}`;
    if (visionDeficiency)
      throw new Error(
        `${state.cdpFailure} Vision emulation mode=${visionDeficiency} requires a CDP session.`,
        { cause: error },
      );
  }
  if (visionDeficiency) {
    const cdp = state.cdp;
    if (!cdp) throw new Error(`Vision emulation mode=${visionDeficiency} requires a CDP session.`);
    await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: visionDeficiency });
  }
}

async function closePopup(state: WorkerState, popup: Page): Promise<void> {
  if (popup === state.page) return;
  let target: string;
  try {
    const url = new URL(popup.url());
    target = `${url.origin}${url.pathname}`;
  } catch {
    target = '';
  }
  await recordSecurity(
    state,
    `popup:${target}`,
    `Blocked a browser popup${target ? `: ${limitText(target, 200)}` : '.'}`,
    {
      category: 'security',
      event: 'popup',
      target,
    },
  );
  try {
    await popup.close();
  } catch {
    // The popup may already have been closed by the browser.
  }
}

async function navigate(state: WorkerState): Promise<void> {
  const page = state.page;
  if (!page) throw new Error('Browser page was not created.');
  const worldPath = `/api/world/${state.config.id}`;
  const worldResponse = page
    .waitForResponse(
      (response) => {
        let url: URL;
        try {
          url = new URL(response.url());
        } catch {
          return false;
        }
        return (
          url.origin === state.replicaOrigin &&
          url.pathname === worldPath &&
          response.request().method() === 'GET'
        );
      },
      { timeout: 8_000 },
    )
    .catch(() => undefined);

  const response = await page.goto(state.initialUrl, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await worldResponse;
  if (!response) throw new Error('Initial replica navigation returned no response.');
  if (response.status() >= 400)
    throw new Error(`Initial replica navigation failed with HTTP ${response.status()}.`);
  const finalUrl = new URL(page.url());
  const allowed = replicaRequestAllowed(finalUrl, state.replicaOrigin, state.config.id, {
    scenario: state.config.scenario,
  });
  if (!allowed.ok)
    throw new Error(
      `Initial navigation ended at a disallowed URL: ${finalUrl.origin}${finalUrl.pathname} (${allowed.reason}).`,
    );
  await page.waitForLoadState('load', { timeout: 8_000 }).catch(() => undefined);
  await delay(SETTLE_MS);
  state.pageReady = true;
}

async function beginRun(state: WorkerState, run: AgentRun): Promise<void> {
  if (run.config.id !== state.config.id)
    throw new WorkerConfigError('Backend run ID does not match the worker configuration.');
  if (
    run.config.profile !== state.config.profile ||
    run.config.scenario !== state.config.scenario
  ) {
    throw new WorkerConfigError(
      'Backend run profile/scenario does not match the worker configuration.',
    );
  }
  if (!COMMAND_VALUES[run.requested])
    throw new WorkerConfigError(
      `Backend run has an invalid requested command "${String(run.requested)}".`,
    );
  state.requested = run.requested;
  state.status = run.status;
  state.step = run.step;
  state.findings = run.findings;
  state.latestFrame = run.latestFrame;
  if (!stopRequested(state)) {
    await state.backend.patch(state.config.id, { status: 'running', requested: state.requested });
    state.status = 'running';
  }
  await appendEvent(state, {
    kind: 'state',
    text: `Run started · profile ${state.config.profile} · scenario ${state.config.scenario}`,
    data: {
      profile: state.config.profile,
      scenario: state.config.scenario,
      verify: state.config.verify,
    },
  });
  if (stopRequested(state)) return;

  const health = await raceWithAbort(modelHealth(), state.stop.signal);
  if (!health.ok) throw new ModelError(`Model preflight failed: ${health.detail}`, 'config');
  await appendEvent(state, {
    kind: 'state',
    text: `Model preflight passed: ${health.model ?? 'configured model'}`,
    data: { model: health.model, endpoint: health.endpoint },
  });

  const world = await state.backend.world(state.config.id);
  await recordWorld(state, world, true);
  if (stopRequested(state)) return;

  await setupBrowser(state);
  if (stopRequested(state)) return;
  await navigate(state);
  if (stopRequested(state)) return;
  const profileDefinition = PROFILE_DEFINITIONS[state.config.profile];
  const visionDeficiency = profileDefinition.visionDeficiency;
  await appendEvent(state, {
    kind: 'state',
    text: `Profile applied: ${state.config.profile}${visionDeficiency ? ` · Emulation.setEmulatedVisionDeficiency mode=${visionDeficiency}` : ''}`,
    data: {
      profile: state.config.profile,
      profileGuidance: profileDefinition.guidance,
      ...(visionDeficiency ? { visionDeficiency } : {}),
    },
  });
  const initial = await captureObservation(state, 'Decision observation');
  state.nextObservation = initial;
  if (stopRequested(state)) return;
  await startScreencast(state);
}

async function startScreencast(state: WorkerState): Promise<void> {
  const cdp = state.cdp;
  if (!cdp) {
    try {
      await appendEvent(state, {
        kind: 'error',
        text: `Live screencast unavailable: ${state.cdpFailure ?? 'no CDP session'}`,
        data: { category: 'artifact' },
      });
    } catch {
      // Canonical observations still work.
    }
    return;
  }
  const controller = new ScreencastController(state, cdp);
  try {
    await controller.start();
    state.screencast = controller;
  } catch (error) {
    try {
      await appendEvent(state, {
        kind: 'error',
        text: `Live screencast unavailable: ${errorMessage(error)}`,
        data: { category: 'artifact' },
      });
    } catch {
      // Canonical observations still work.
    }
  }
}

async function applyBoundary(state: WorkerState): Promise<Terminal | undefined> {
  if (stopRequested(state)) return stoppedTerminal(state);
  if (!pauseRequested(state)) return undefined;
  if (!state.pausedApplied) {
    state.pausedApplied = true;
    await state.backend.patch(state.config.id, { status: 'paused', requested: 'paused' });
    state.status = 'paused';
    await appendEvent(state, {
      kind: 'control',
      text: 'Paused at action boundary',
      data: { command: 'paused' },
    });
  }
  while (pauseRequested(state) && !state.shuttingDown) {
    const deferred = createDeferred();
    state.wake = deferred.resolve;
    if (!pauseRequested(state) || state.shuttingDown) {
      state.wake = undefined;
      break;
    }
    await deferred.promise;
    state.wake = undefined;
  }
  if (stopRequested(state)) return stoppedTerminal(state);
  state.pausedApplied = false;
  await state.backend.patch(state.config.id, { status: 'running', requested: 'running' });
  state.status = 'running';
  await appendEvent(state, {
    kind: 'control',
    text: 'Resumed at action boundary',
    data: { command: 'running' },
  });
  return undefined;
}

async function deliverMessages(state: WorkerState): Promise<OperatorMessage[]> {
  const raw = await state.backend.takeMessages(state.config.id);
  const messages: OperatorMessage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const text = limitText(item.text, MESSAGE_TEXT_MAX);
    if (text) messages.push({ text, interrupt: item.interrupt === true });
  }
  const recorded = messages.slice(-MAX_MESSAGES_RECORDED);
  for (const message of recorded) {
    await appendEvent(state, {
      kind: 'message',
      text: message.text,
      data: { length: message.text.length, interrupt: message.interrupt },
    });
  }
  if (messages.length > recorded.length) {
    await appendEvent(state, {
      kind: 'state',
      text: `Bounded message evidence: ${messages.length - recorded.length} older operator message(s) omitted.`,
      data: { omitted: messages.length - recorded.length },
    });
  }
  return [...state.carriedMessages, ...messages.slice(-MAX_MESSAGES_MODEL)].slice(
    -MAX_MESSAGES_MODEL,
  );
}

/**
 * Persists only model metadata that is safe to display. The decision's
 * `reasoning` field is private chain-of-thought and is never stored; the
 * visible event text (the action the agent chose) is the supported decision
 * summary, and the activity summarizer only sees that visible evidence.
 */
function decisionMetaData(decision: DecisionResult): Record<string, unknown> {
  const data: Record<string, unknown> = {
    model: decision.meta.model,
    requestedModel: decision.meta.requestedModel,
    elapsedMs: decision.meta.elapsedMs,
    status: decision.meta.status,
  };
  if (decision.meta.usage) data.usage = decision.meta.usage;
  if (decision.meta.responseId) data.responseId = decision.meta.responseId;
  return data;
}

function actionText(action: Action, result?: ActionResult): string {
  switch (action.type) {
    case 'click':
    case 'move':
      return `${action.type} ${formatPoint({ x: action.x, y: action.y })}${result?.executed ? ` → viewport ${formatPoint(result.executed)}` : ''}`;
    case 'drag':
      return `drag ${formatPoint({ x: action.x, y: action.y })} → ${formatPoint({ x: action.toX, y: action.toY })}${result?.executedTo ? ` (viewport end ${formatPoint(result.executedTo)})` : ''}`;
    case 'scroll':
      return `scroll (${formatNumber(action.dx)}, ${formatNumber(action.dy)})`;
    case 'key':
      return `key ${action.key}`;
    case 'type':
      return `type ${JSON.stringify(limitText(action.text, 160))}`;
    case 'wait':
      return `wait ${action.ms} ms`;
    case 'observe':
      return 'observe';
    case 'crop':
      return `crop (${action.x}, ${action.y}) ${action.width}x${action.height} scale ${formatNumber(action.scale)}`;
    case 'report':
      return `report ${action.severity}: ${limitText(action.title, 200)}`;
    case 'finish':
      return `finish: ${limitText(action.summary, 300)}`;
    default:
      return 'unknown action';
  }
}

async function addFinding(
  state: WorkerState,
  action: Extract<Action, { type: 'report' }>,
  decision: DecisionResult,
): Promise<void> {
  if (state.findings.length >= MAX_FINDINGS) {
    await appendEvent(state, {
      kind: 'error',
      text: `Finding limit reached (${MAX_FINDINGS}); the report action was not stored.`,
      data: { category: 'model', action, step: state.step, ...decisionMetaData(decision) },
    });
    return;
  }
  const finding: Finding = {
    id: crypto.randomUUID(),
    title: action.title,
    detail: action.detail,
    severity: action.severity,
    ...(state.lastObservationId ? { observationId: state.lastObservationId } : {}),
  };
  state.findings = [...state.findings, finding];
  await state.backend.patch(state.config.id, { findings: state.findings });
  await appendEvent(state, {
    kind: 'finding',
    text: `${action.severity}: ${action.title}`,
    data: { finding, step: state.step, ...decisionMetaData(decision) },
  });
}

async function recordInterruption(state: WorkerState, messages: OperatorMessage[]): Promise<void> {
  // Keep the messages delivered for the aborted call; they must be visible to
  // the next decision even though no action consumed them yet.
  state.carriedMessages = messages.slice(-MAX_MESSAGES_MODEL);
  await appendEvent(state, {
    kind: 'control',
    text: 'Operator interrupt applied before the next decision.',
    data: { command: 'interrupt' },
  });
}

async function runLoop(state: WorkerState): Promise<Terminal> {
  let observation = state.nextObservation;
  state.nextObservation = undefined;
  for (;;) {
    const boundary = await applyBoundary(state);
    if (boundary) return boundary;
    if (state.pageFatal) throw new Error(state.pageFatal);

    await pollWorld(state);
    if (!observation) observation = await captureObservation(state, 'Decision observation');
    const current = observation;
    observation = undefined;

    // Snapshot before reading the durable queue: an interrupt requested while
    // this read is in flight must force another delivery pass, because the
    // message may have been written after the procedure's read snapshot.
    const preDeliveryGeneration = state.interruptGeneration;
    const messages = await deliverMessages(state);
    const decisionGeneration = state.interruptGeneration;
    if (decisionGeneration !== preDeliveryGeneration) {
      await recordInterruption(state, messages);
      observation = current;
      continue;
    }

    let decision: DecisionResult;
    state.lastDecision = undefined;
    const controller = new AbortController();
    state.decision = controller;
    try {
      // Close the window between the boundary check above and the request:
      // an interrupt requested while this decision was being prepared aborts
      // immediately instead of waiting for the next action boundary.
      if (state.interruptGeneration !== decisionGeneration) controller.abort();
      decision = await decide(
        current.bytes,
        state.config,
        state.modelEvents.slice(-24),
        messages.map((message) => message.text),
        {
          signal: AbortSignal.any([state.stop.signal, controller.signal]),
          timeoutMs: MODEL_TIMEOUT_MS,
          view: {
            originX: current.view.originX,
            originY: current.view.originY,
            scale: current.view.scale,
          },
        },
      );
    } catch (error) {
      if (stopRequested(state)) return stoppedTerminal(state);
      if (controller.signal.aborted) {
        await recordInterruption(state, messages);
        observation = current;
        continue;
      }
      throw error;
    } finally {
      if (state.decision === controller) state.decision = undefined;
    }
    if (state.interruptGeneration !== decisionGeneration) {
      // The model call completed at the same instant an interrupt arrived.
      // Discard the decision so the operator message is delivered first.
      await recordInterruption(state, messages);
      observation = current;
      continue;
    }
    state.lastDecision = decision;

    const action = validateAction(decision.action, {
      view: { width: current.view.width, height: current.view.height },
    });
    if (stopRequested(state)) return stoppedTerminal(state);
    if (pauseRequested(state)) {
      const paused = await applyBoundary(state);
      if (paused) return paused;
      state.carriedMessages = messages.slice(-MAX_MESSAGES_MODEL);
      continue;
    }

    state.step += 1;
    await state.backend.patch(state.config.id, { step: state.step });
    const actionCount = state.step;

    if (action.type === 'finish') {
      await appendEvent(state, {
        kind: 'claim',
        text: `Model claims completion: ${action.summary}`,
        data: { summary: action.summary, actionCount, ...decisionMetaData(decision) },
      });
      return { status: 'completed', outcome: `Model claim: ${action.summary}` };
    }

    if (action.type === 'report') {
      await appendEvent(state, {
        kind: 'action',
        text: actionText(action),
        data: { action, step: state.step, actionCount, ...decisionMetaData(decision) },
      });
      if (stopRequested(state)) return stoppedTerminal(state);
      await addFinding(state, action, decision);
      state.carriedMessages = [];
      continue;
    }

    if (action.type === 'crop') {
      await appendEvent(state, {
        kind: 'action',
        text: actionText(action),
        data: { action, step: state.step, actionCount, ...decisionMetaData(decision) },
      });
      observation = await cropObservationAndRecord(state, current, action);
      state.carriedMessages = [];
      continue;
    }

    if (action.type === 'observe') {
      await appendEvent(state, {
        kind: 'action',
        text: actionText(action),
        data: { action, step: state.step, actionCount, ...decisionMetaData(decision) },
      });
      state.carriedMessages = [];
      continue;
    }

    const page = state.page;
    if (!page || page.isClosed())
      throw new Error('Browser page is not available for an input action.');
    let result: ActionResult;
    try {
      result = await executeAction(page, action, state.config.profile, state.step, {
        seed: mixSeed(state.pointerSeed, state.step),
        signal: state.stop.signal,
        view: current.view,
        onCursor: async (cursor) => {
          await state.backend.patch(state.config.id, { cursor });
        },
      });
    } catch (error) {
      if (error instanceof ProfileViolationError) {
        await appendEvent(state, {
          kind: 'error',
          text: error.message,
          data: {
            category: 'profile',
            action,
            step: state.step,
            actionCount,
            ...decisionMetaData(decision),
          },
        });
        state.carriedMessages = messages.slice(-MAX_MESSAGES_MODEL);
        continue;
      }
      if (stopRequested(state) || isAbortError(error)) return stoppedTerminal(state);
      throw error;
    }

    await appendEvent(state, {
      kind: 'action',
      text: actionText(action, result),
      data: {
        action,
        profile: state.config.profile,
        step: state.step,
        actionCount,
        ...result,
        ...decisionMetaData(decision),
      },
    });
    state.carriedMessages = [];
    await delay(SETTLE_MS);
  }
}

async function stopTrace(state: WorkerState): Promise<FileOutcome> {
  if (!state.traceStarted)
    return { ok: false, reason: state.traceFailure ?? 'Trace was not started.' };
  const context = state.context;
  if (!context)
    return {
      ok: false,
      reason: 'Trace could not be stopped because the browser context is missing.',
    };
  const path = resolve(state.artifactDir, `trace-${state.config.id}-${state.startedAt}.zip`);
  try {
    await context.tracing.stop({ path });
  } catch (error) {
    await unlink(path).catch(() => undefined);
    return { ok: false, reason: `Trace stop failed: ${errorMessage(error)}` };
  }
  return artifactOutcomeFromFile(state, path);
}

async function saveVideo(state: WorkerState): Promise<FileOutcome> {
  const video = state.video;
  if (!video) {
    await rm(state.videoDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, reason: state.videoFailure ?? 'Video recording was not started.' };
  }
  const path = resolve(state.artifactDir, `video-${state.config.id}-${state.startedAt}.webm`);
  try {
    await video.saveAs(path);
  } catch (error) {
    await rm(state.videoDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, reason: `Video save failed: ${errorMessage(error)}` };
  }
  await rm(state.videoDir, { recursive: true, force: true }).catch(() => undefined);
  return artifactOutcomeFromFile(state, path);
}

async function appendArtifactEvent(
  state: WorkerState,
  type: 'trace' | 'video',
  outcome: FileOutcome,
): Promise<void> {
  const label = type === 'trace' ? 'Playwright trace' : 'Session video';
  if (outcome.ok) {
    await appendEvent(state, {
      kind: 'artifact',
      text: label,
      artifact: outcome.artifact,
      data: { type, bytes: outcome.bytes, sha256: outcome.sha256 },
    });
    return;
  }
  await appendEvent(state, {
    kind: 'artifact',
    text: `${type === 'trace' ? 'Trace' : 'Video'} unavailable: ${outcome.reason}`,
    data: { type, available: false, reason: outcome.reason },
  });
}

async function deleteLiveOnlyArtifacts(state: WorkerState): Promise<void> {
  for (const path of [...state.liveOnlyPaths]) {
    state.liveOnlyPaths.delete(path);
    if (path !== state.latestFrame && !state.protectedPaths.has(path))
      await unlinkArtifact(state, path);
  }
}

/**
 * Final evidence is written before the single terminal status patch. After that
 * patch the worker performs no event, finding or state mutation on the run.
 */
async function finalizeRun(state: WorkerState, terminal: Terminal): Promise<void> {
  state.closing = true;
  let patchFailure: unknown;
  try {
    await state.screencast?.stop();

    if (state.pageReady && state.page && !state.page.isClosed()) {
      try {
        await captureObservation(state, 'Final observation');
      } catch (error) {
        try {
          await appendEvent(state, {
            kind: 'error',
            text: `Final observation unavailable: ${errorMessage(error)}`,
            data: { category: 'artifact' },
          });
        } catch {
          // The terminal patch below still records the run outcome.
        }
      }
    }

    const trace = await stopTrace(state);
    const context = state.context;
    if (context) {
      try {
        await context.close();
      } catch (error) {
        if (!state.videoFailure)
          state.videoFailure = `Context close failed: ${errorMessage(error)}`;
      }
    }
    const browser = state.browser;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Closing an already-closed browser is harmless.
      }
    }
    const video = await saveVideo(state);

    await Promise.allSettled([...state.pendingWrites]);
    await appendArtifactEvent(state, 'trace', trace);
    await appendArtifactEvent(state, 'video', video);

    if (state.blockedSuppressed > 0) {
      await appendEvent(state, {
        kind: 'error',
        text: `Suppressed ${state.blockedSuppressed} additional blocked request(s) after the evidence cap.`,
        data: { category: 'security', suppressed: state.blockedSuppressed },
      });
    }

    await deleteLiveOnlyArtifacts(state);

    if (terminal.status === 'failed') {
      const error = terminal.error ?? 'Run failed.';
      await appendEvent(state, {
        kind: 'error',
        text: error,
        data: {
          category: terminal.category ?? 'backend',
          ...(state.lastDecision ? decisionMetaData(state.lastDecision) : {}),
          actionCount: state.step,
        },
      });
    } else if (terminal.status === 'stopped') {
      await appendEvent(state, {
        kind: 'control',
        text: terminal.outcome,
        data: { command: 'stopped' },
      });
    } else {
      await appendEvent(state, {
        kind: 'state',
        text: `Run completed: ${terminal.outcome}`,
        data: { step: state.step },
      });
    }

    const patch: Partial<AgentRun> = {
      status: terminal.status,
      requested: terminal.status === 'stopped' ? 'stopped' : state.requested,
      outcome: limitText(terminal.outcome, 2_000),
      step: state.step,
      findings: state.findings,
    };
    if (state.latestFrame) patch.latestFrame = state.latestFrame;
    if (terminal.error) patch.error = limitText(terminal.error, 2_000);
    await state.backend.patch(state.config.id, patch);
    state.status = terminal.status;
  } catch (error) {
    patchFailure = error;
  } finally {
    state.closed = true;
  }
  if (patchFailure !== undefined) {
    throw patchFailure instanceof Error
      ? patchFailure
      : new Error('Failed to write the terminal run state.');
  }
}

async function runAgent(state: WorkerState): Promise<void> {
  let terminal: Terminal | undefined;
  try {
    const run = await state.backend.get(state.config.id);
    if (!run) throw new Error(`Run ${state.config.id} was not found in the backend.`);
    if (TERMINAL_STATUS[run.status] === true) {
      state.skip = true;
      return;
    }
    await beginRun(state, run);
    terminal = await runLoop(state);
  } catch (error) {
    if (stopRequested(state) || isAbortError(error)) {
      terminal = stoppedTerminal(state);
    } else {
      terminal = {
        status: 'failed',
        outcome: 'Run failed',
        error: errorMessage(error),
        category: terminalCategory(error),
      };
    }
  } finally {
    if (!state.skip)
      await finalizeRun(
        state,
        terminal ?? {
          status: 'failed',
          outcome: 'Run failed',
          error: 'Run ended without a terminal state.',
          category: 'backend',
        },
      );
  }
}

/** Starts one agent and resolves when the run reaches a terminal state. */
export async function startAgent(
  config: AgentConfig,
  backend: Backend,
  hooks: WorkerHooks,
): Promise<void> {
  if (shuttingDown) throw new Error('Worker shutdown is in progress.');
  if (workers.has(config.id)) throw new Error(`Agent ${config.id} is already running.`);
  const state = createState(config, backend, hooks);
  workers.set(config.id, state);
  const task: Promise<void> = runAgent(state).finally(() => {
    if (workers.get(config.id) === state) workers.delete(config.id);
    activeRuns.delete(config.id);
  });
  activeRuns.set(config.id, task);
  await task;
}

/** Applies an operator command at the next safe action boundary. */
export function commandAgent(id: string, command: Command): void {
  if (!COMMAND_VALUES[command]) return;
  const state = workers.get(id);
  if (!state || state.closed || state.closing) return;
  state.requested = command;
  if (command === 'stopped') state.stop.abort();
  state.wake?.();
}

/**
 * Signals that an operator message with `interrupt: true` is durable. The
 * in-flight model call (if any) is aborted; the run itself keeps going, and the
 * message is delivered before the next decision. Returns true only when a model
 * call was actually waiting to be aborted.
 */
export function interruptAgent(id: string): boolean {
  const state = workers.get(id);
  if (!state || state.closed || state.closing) return false;
  state.interruptGeneration += 1;
  const controller = state.decision;
  if (controller) controller.abort();
  state.wake?.();
  return controller !== undefined;
}

/** Stops all workers, letting in-flight terminal evidence finish first. */
export async function shutdownWorkers(): Promise<void> {
  if (shuttingDown) {
    await Promise.allSettled([...activeRuns.values()]);
    return;
  }
  shuttingDown = true;
  const states = [...workers.values()];
  for (const state of states) {
    if (state.closing || state.closed) continue;
    state.shuttingDown = true;
    state.requested = 'stopped';
    state.stop.abort();
    state.wake?.();
  }
  const all = Promise.allSettled([...activeRuns.values()]);
  await Promise.race([all, Bun.sleep(SHUTDOWN_GRACE_MS)]);
  for (const state of states) {
    const browser = state.browser;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // The run may already have closed it.
      }
    }
  }
  await all;
  workers.clear();
}
