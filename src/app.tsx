'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AnchorHTMLAttributes,
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import type {
  AgentConfig,
  AgentRun,
  Command,
  EvidenceEvent,
  Finding,
  Profile,
  Scenario,
  Status,
} from './contracts';
import {
  DEFAULT_PROFILE_SELECTION,
  MAX_CONCURRENT_AGENTS,
  PROFILE_DEFINITIONS,
  PROFILE_IDS,
  isProfile,
} from './profiles';
import type { ActivitySummary, ActivitySummaryPayload } from './summary';
import WorkspaceSidebar from '../app/workspace-sidebar';
import '../app/workspace.css';
import WorkspaceSettings from '../app/workspace-settings';

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'orange';
type SelectionMode = 'auto' | 'custom';
type Route =
  | { kind: 'home'; screen: 'runs' | 'new' | 'history' | 'settings' }
  | { kind: 'detail'; id: string }
  | { kind: 'report' }
  | { kind: 'not-found'; path: string };

interface HealthEntry {
  key: string;
  ok: boolean;
  detail: string;
}

interface HealthReport {
  entries: HealthEntry[];
  allOk: boolean;
  checkedAt: number;
  origin: string | null;
  replicaOrigin: string | null;
}

interface LaunchResult {
  ids: string[];
  runs: AgentRun[];
}

interface CreateRunBody {
  task: string;
  scenario: Scenario;
  url?: string;
  profiles?: Profile[];
  verify: boolean;
  defect: boolean;
}

const SCENARIO_ORDER: readonly Scenario[] = ['shop', 'portal'];
const TERMINAL_STATUSES: Record<string, true> = {
  completed: true,
  failed: true,
  stopped: true,
};
const MAX_TASK_LENGTH = 4000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_URL_LENGTH = 500;
const CONCURRENT_LIMIT = MAX_CONCURRENT_AGENTS;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

const PROFILE_TONES: Record<Profile, Tone> = {
  baseline: 'info',
  keyboard: 'violet',
  pointer: 'accent',
  'older-adult': 'ok',
  child: 'warn',
  'young-adult': 'accent',
  deuteranopia: 'orange',
  protanopia: 'orange',
  tritanopia: 'orange',
  achromatopsia: 'orange',
};

function profileMeta(profile: Profile): { label: string; description: string; tone: Tone } {
  const definition = PROFILE_DEFINITIONS[profile];
  return {
    label: definition.label,
    description: definition.description,
    tone: PROFILE_TONES[profile],
  };
}

const SCENARIO_META: Record<Scenario, { label: string; description: string }> = {
  shop: {
    label: 'Shop',
    description:
      'Search, product and variant selection, scheduled stock notice, isolated cart, and synthetic checkout.',
  },
  portal: {
    label: 'Campus portal',
    description:
      'Eighteen generic campus service tiles, searchable navigation, schedule controls, and working panels.',
  },
};

const STATUS_META: Record<Status, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
};

const SEVERITY_META: Record<Finding['severity'], { label: string; tone: Tone }> = {
  info: { label: 'Info', tone: 'info' },
  minor: { label: 'Minor', tone: 'warn' },
  major: { label: 'Major', tone: 'orange' },
  critical: { label: 'Critical', tone: 'danger' },
};

const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// Single canonical guard for untrusted JSON at the HTTP/SSE boundary in this UI bundle.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && Object.hasOwn(STATUS_META, value);
}

function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && Object.hasOwn(SCENARIO_META, value);
}

function isSeverity(value: unknown): value is Finding['severity'] {
  return typeof value === 'string' && Object.hasOwn(SEVERITY_META, value);
}

function isCommand(value: unknown): value is Command {
  return value === 'running' || value === 'paused' || value === 'stopped';
}

function isCursor(value: unknown): value is { x: number; y: number } {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function parseEvidenceEvent(value: unknown): EvidenceEvent {
  if (!isRecord(value)) throw new Error('An evidence event is not an object.');
  if (
    typeof value.id !== 'string' ||
    typeof value.agentId !== 'string' ||
    typeof value.seq !== 'number' ||
    !Number.isFinite(value.seq) ||
    typeof value.at !== 'number' ||
    !Number.isFinite(value.at) ||
    typeof value.kind !== 'string' ||
    typeof value.text !== 'string'
  ) {
    throw new Error('An evidence event is missing required fields.');
  }
  if (
    value.artifact !== undefined &&
    value.artifact !== null &&
    typeof value.artifact !== 'string'
  ) {
    throw new Error('An evidence event has an invalid artifact reference.');
  }
  if (value.data !== undefined && value.data !== null && !isRecord(value.data)) {
    throw new Error('An evidence event has invalid structured data.');
  }
  return {
    id: value.id,
    agentId: value.agentId,
    seq: value.seq,
    at: value.at,
    kind: value.kind,
    text: value.text,
    ...(typeof value.artifact === 'string' && value.artifact ? { artifact: value.artifact } : {}),
    ...(isRecord(value.data) ? { data: value.data } : {}),
  };
}

function parseFinding(value: unknown): Finding {
  if (!isRecord(value)) throw new Error('A finding is not an object.');
  const severity = value.severity;
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.detail !== 'string' ||
    !isSeverity(severity)
  ) {
    throw new Error('A finding is missing required fields.');
  }
  if (
    value.observationId !== undefined &&
    value.observationId !== null &&
    typeof value.observationId !== 'string'
  ) {
    throw new Error('A finding has an invalid observation reference.');
  }
  if (
    value.verification !== undefined &&
    value.verification !== null &&
    typeof value.verification !== 'string'
  ) {
    throw new Error('A finding has an invalid verification note.');
  }
  return {
    id: value.id,
    title: value.title,
    detail: value.detail,
    severity,
    ...(typeof value.observationId === 'string' && value.observationId
      ? { observationId: value.observationId }
      : {}),
    ...(typeof value.verification === 'string' && value.verification
      ? { verification: value.verification }
      : {}),
  };
}

function parseAgentRun(value: unknown): AgentRun {
  if (!isRecord(value)) throw new Error('An agent run is not an object.');
  const configValue = value.config;
  if (!isRecord(configValue)) throw new Error('An agent run is missing its configuration.');

  const id = configValue.id;
  const name = configValue.name;
  const profile = configValue.profile;
  const task = configValue.task;
  const scenario = configValue.scenario;
  const verify = configValue.verify;
  const url = configValue.url;
  const defect = configValue.defect;
  const verificationOf = configValue.verificationOf;

  if (typeof id !== 'string' || !id) throw new Error('An agent configuration is missing an id.');
  if (typeof name !== 'string' || !name)
    throw new Error('An agent configuration is missing a name.');
  if (!isProfile(profile)) throw new Error('An agent configuration has an invalid profile.');
  if (typeof task !== 'string') throw new Error('An agent configuration is missing a task.');
  if (!isScenario(scenario)) throw new Error('An agent configuration has an invalid scenario.');
  if (typeof verify !== 'boolean') {
    throw new Error('An agent configuration has an invalid verification flag.');
  }
  if (url !== undefined && url !== null && typeof url !== 'string') {
    throw new Error('An agent configuration has an invalid URL.');
  }
  if (defect !== undefined && defect !== null && typeof defect !== 'boolean') {
    throw new Error('An agent configuration has an invalid defect flag.');
  }
  if (
    verificationOf !== undefined &&
    verificationOf !== null &&
    typeof verificationOf !== 'string'
  ) {
    throw new Error('An agent configuration has an invalid verification link.');
  }

  const status = value.status;
  const requested = value.requested;
  const step = value.step;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const outcome = value.outcome;
  const eventValues = value.events;
  const findingValues = value.findings;
  const latestFrame = value.latestFrame;
  const cursor = value.cursor;
  const runError = value.error;

  if (!isStatus(status)) throw new Error('An agent run has an invalid status.');
  if (!isCommand(requested)) throw new Error('An agent run has an invalid requested state.');
  if (typeof step !== 'number' || !Number.isSafeInteger(step)) {
    throw new Error('An agent run has an invalid step count.');
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw new Error('An agent run has an invalid creation timestamp.');
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new Error('An agent run has an invalid update timestamp.');
  }
  if (typeof outcome !== 'string') throw new Error('An agent run is missing its outcome field.');
  if (!Array.isArray(eventValues)) throw new Error('An agent run is missing its evidence events.');
  if (!Array.isArray(findingValues)) throw new Error('An agent run is missing its findings.');
  if (latestFrame !== undefined && latestFrame !== null && typeof latestFrame !== 'string') {
    throw new Error('An agent run has an invalid latest frame reference.');
  }
  if (cursor !== undefined && cursor !== null && !isCursor(cursor)) {
    throw new Error('An agent run has an invalid cursor position.');
  }
  if (runError !== undefined && runError !== null && typeof runError !== 'string') {
    throw new Error('An agent run has an invalid error field.');
  }

  const parsedConfig: AgentConfig = {
    id,
    name,
    profile,
    task,
    scenario,
    verify,
    ...(typeof url === 'string' && url ? { url } : {}),
    ...(typeof defect === 'boolean' ? { defect } : {}),
    ...(typeof verificationOf === 'string' && verificationOf ? { verificationOf } : {}),
  };

  return {
    config: parsedConfig,
    status,
    requested,
    step,
    createdAt,
    updatedAt,
    events: eventValues.map(parseEvidenceEvent),
    findings: findingValues.map(parseFinding),
    outcome,
    ...(typeof latestFrame === 'string' && latestFrame ? { latestFrame } : {}),
    ...(isCursor(cursor) ? { cursor: { x: cursor.x, y: cursor.y } } : {}),
    ...(typeof runError === 'string' && runError ? { error: runError } : {}),
  };
}

function parseRunsPayload(value: unknown): AgentRun[] {
  if (Array.isArray(value)) return value.map(parseAgentRun);
  if (isRecord(value) && Array.isArray(value.runs)) return value.runs.map(parseAgentRun);
  throw new Error('Expected an array of agent runs.');
}

function parseSingleRunPayload(value: unknown): AgentRun {
  if (isRecord(value) && 'run' in value) return parseAgentRun(value.run);
  return parseAgentRun(value);
}

function parseLaunchPayload(value: unknown): LaunchResult {
  const runs: AgentRun[] = [];
  const ids: string[] = [];
  if (Array.isArray(value)) {
    runs.push(...value.map(parseAgentRun));
  } else if (isRecord(value)) {
    if (Array.isArray(value.runs)) runs.push(...value.runs.map(parseAgentRun));
    if (Array.isArray(value.ids)) {
      for (const id of value.ids) if (typeof id === 'string') ids.push(id);
    }
    if (typeof value.id === 'string') ids.push(value.id);
  }
  const runIds = runs.map((run) => run.config.id);
  return { runs, ids: [...new Set([...ids, ...runIds])] };
}

function parseHealthPayload(value: unknown): HealthReport {
  if (!isRecord(value)) throw new Error('The health response is not a JSON object.');
  const entries: HealthEntry[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.ok !== 'boolean') continue;
    entries.push({
      key,
      ok: raw.ok,
      detail: typeof raw.detail === 'string' ? raw.detail : '',
    });
  }
  if (entries.length === 0)
    throw new Error('The health response contained no {ok, detail} checks.');
  const priority = (key: string) => {
    const index = ['backend', 'model'].indexOf(key);
    return index === -1 ? 99 : index;
  };
  entries.sort((a, b) => priority(a.key) - priority(b.key) || a.key.localeCompare(b.key));
  return {
    entries,
    allOk: entries.every((entry) => entry.ok),
    checkedAt: Date.now(),
    origin: typeof value.origin === 'string' ? value.origin : null,
    replicaOrigin: typeof value.replicaOrigin === 'string' ? value.replicaOrigin : null,
  };
}

function parseActivitySummaryPayload(value: unknown): ActivitySummaryPayload {
  if (!isRecord(value)) throw new Error('The activity summary response is not an object.');
  const runId = value.runId;
  const stale = value.stale;
  const canSummarize = value.canSummarize;
  const activityCount = value.activityCount;
  if (typeof runId !== 'string' || !runId)
    throw new Error('The activity summary response is missing its run ID.');
  if (typeof stale !== 'boolean' || typeof canSummarize !== 'boolean')
    throw new Error('The activity summary response has invalid state flags.');
  if (!Number.isInteger(activityCount) || Number(activityCount) < 0)
    throw new Error('The activity summary response has an invalid activity count.');
  const rawSummary = value.summary;
  if (rawSummary === null)
    return {
      runId,
      summary: null,
      stale,
      canSummarize,
      activityCount: Number(activityCount),
    };
  if (!isRecord(rawSummary)) throw new Error('The activity summary payload is not an object.');
  const bullets = rawSummary.bullets;
  if (
    !Array.isArray(bullets) ||
    bullets.length < 1 ||
    bullets.length > 4 ||
    !bullets.every((bullet) => typeof bullet === 'string' && bullet.trim().length > 0)
  )
    throw new Error('The activity summary contains invalid bullets.');
  const generatedAt = rawSummary.generatedAt;
  const sourceActivityCount = rawSummary.sourceActivityCount;
  const elapsedMs = rawSummary.elapsedMs;
  const truncated = rawSummary.truncated;
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt))
    throw new Error('The activity summary has an invalid timestamp.');
  if (!Number.isInteger(sourceActivityCount) || Number(sourceActivityCount) < 0)
    throw new Error('The activity summary has an invalid source count.');
  if (
    typeof elapsedMs !== 'number' ||
    !Number.isFinite(elapsedMs) ||
    typeof truncated !== 'boolean'
  )
    throw new Error('The activity summary has invalid generation metadata.');
  const summary: ActivitySummary = {
    bullets: bullets.map((bullet) => String(bullet).trim()),
    generatedAt,
    sourceActivityCount: Number(sourceActivityCount),
    elapsedMs,
    truncated,
  };
  return {
    runId,
    summary,
    stale,
    canSummarize,
    activityCount: Number(activityCount),
  };
}

function mergeRuns(current: AgentRun[] | null, incoming: AgentRun[]): AgentRun[] {
  if (!current) return incoming;
  const byId = new Map<string, AgentRun>(
    current.map((run): [string, AgentRun] => [run.config.id, run]),
  );
  for (const run of incoming) {
    const existing = byId.get(run.config.id);
    if (!existing || run.updatedAt >= existing.updatedAt) byId.set(run.config.id, run);
  }
  return [...byId.values()];
}

function newestRun(a: AgentRun | null, b: AgentRun | null): AgentRun | null {
  if (!a) return b;
  if (!b) return a;
  return a.updatedAt >= b.updatedAt ? a : b;
}

const STATUS_SORT: Record<Status, number> = {
  running: 0,
  paused: 1,
  queued: 2,
  failed: 3,
  stopped: 4,
  completed: 5,
};

function sortRuns(runs: AgentRun[]): AgentRun[] {
  return runs.toSorted(
    (a, b) => STATUS_SORT[a.status] - STATUS_SORT[b.status] || b.updatedAt - a.updatedAt,
  );
}

function isTerminal(status: Status): boolean {
  return TERMINAL_STATUSES[status] === true;
}

function emptyFrameMessage(run: AgentRun): string {
  if (run.status === 'queued') return 'Queued. Waiting for the first browser observation.';
  if (run.status === 'running' || run.status === 'paused') {
    return 'Waiting for the first browser frame…';
  }
  if (run.status === 'failed') return 'The run failed before a browser frame was recorded.';
  return 'No browser frame was recorded for this run.';
}

function humanizeKey(key: string): string {
  return key
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/\b\w/g, (character) => character.toUpperCase());
}

function agentPath(id: string): string {
  return `/agent/${encodeURIComponent(id)}`;
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '—' : CLOCK_FORMAT.format(date);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeArtifactUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (!url.pathname.startsWith('/artifacts/')) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function validCursor(
  cursor: { x: number; y: number } | undefined,
): cursor is { x: number; y: number } {
  return Boolean(
    cursor &&
    Number.isFinite(cursor.x) &&
    Number.isFinite(cursor.y) &&
    cursor.x >= 0 &&
    cursor.x <= VIEWPORT_WIDTH &&
    cursor.y >= 0 &&
    cursor.y <= VIEWPORT_HEIGHT,
  );
}

function parseRoute(pathname: string): Route {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (!normalized || normalized === '/dashboard') return { kind: 'home', screen: 'runs' };
  if (normalized === '/dashboard/new') return { kind: 'home', screen: 'new' };
  if (normalized === '/dashboard/history') return { kind: 'home', screen: 'history' };
  if (normalized === '/dashboard/settings') return { kind: 'home', screen: 'settings' };
  if (normalized === '/report' || normalized.startsWith('/report/')) return { kind: 'report' };
  const match = /^\/agent\/([^/]+)$/.exec(normalized);
  if (match) {
    try {
      const id = decodeURIComponent(match[1] ?? '');
      if (id) return { kind: 'detail', id };
    } catch {
      return { kind: 'not-found', path: pathname };
    }
  }
  return { kind: 'not-found', path: pathname };
}

class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function requestJson(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (serialized !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: serialized,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    throw new Error(`Could not reach ${path}. ${errorMessage(error)}`, { cause: error });
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const rawDetail =
      isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : isRecord(payload) && typeof payload.detail === 'string'
          ? payload.detail
          : typeof payload === 'string' && payload.trim()
            ? payload.trim()
            : response.statusText || 'Request failed';
    const detail = rawDetail.length > 600 ? `${rawDetail.slice(0, 600)}…` : rawDetail;
    throw new ApiError(`${response.status}: ${detail}`, response.status);
  }

  return payload;
}

const NavigationContext = createContext<(path: string) => void>((path) => {
  window.location.assign(path);
});

function useNavigate(): (path: string) => void {
  return useContext(NavigationContext);
}

type SmartLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string };

function SmartLink({ href, onClick, children, ...rest }: SmartLinkProps) {
  const navigate = useNavigate();

  function handleClick(event: ReactMouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (rest.target === '_blank' || rest.download) return;
    event.preventDefault();
    navigate(href);
  }

  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}

function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Badge({
  tone = 'neutral',
  children,
  title,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <span className="sl-badge" data-tone={tone} title={title} data-testid={testId}>
      {children}
    </span>
  );
}

function StatusBadge({ status, testId }: { status: Status; testId?: string }) {
  const meta = STATUS_META[status];
  return (
    <Badge tone={meta.tone} title={`Applied status: ${meta.label}`} testId={testId}>
      <span className="sl-badge-dot" aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

function CursorOverlay({ cursor }: { cursor: { x: number; y: number } }) {
  if (!validCursor(cursor)) return null;
  return (
    <div
      className="sl-cursor"
      style={{
        left: (cursor.x / VIEWPORT_WIDTH) * 100 + '%',
        top: (cursor.y / VIEWPORT_HEIGHT) * 100 + '%',
      }}
      aria-hidden="true"
    >
      <svg width="24" height="30" viewBox="0 0 24 30">
        <path
          d="M2 2v23l6-6 5 9 4-2-5-9h9L2 2Z"
          fill="var(--agent-color, #9cafff)"
          stroke="white"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

function FrameSurface({
  artifact,
  alt,
  cursor,
  emptyMessage,
  variant,
  testId,
  click,
}: {
  artifact: string | undefined;
  alt: string;
  cursor?: { x: number; y: number };
  emptyMessage: string;
  variant: 'card' | 'viewer';
  testId?: string;
  click?: EvidenceEvent;
}) {
  const href = safeArtifactUrl(artifact);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const point =
    cursor && validCursor(cursor) ? cursor : { x: VIEWPORT_WIDTH / 2, y: VIEWPORT_HEIGHT / 2 };
  const zoom = variant === 'card' ? 2.2 : 1;
  const x = Math.max(0, Math.min(100, (point.x / VIEWPORT_WIDTH) * 100));
  const y = Math.max(0, Math.min(100, (point.y / VIEWPORT_HEIGHT) * 100));
  return (
    <div
      className={'sl-frame sl-frame--' + variant}
      data-testid={testId}
      data-has-frame={!!href && failedSrc !== href}
    >
      {href && failedSrc !== href ? (
        <div
          className="sl-live-plane"
          style={{ transform: 'scale(' + zoom + ')', transformOrigin: x + '% ' + y + '%' }}
        >
          <img src={href} alt={alt} decoding="async" onError={() => setFailedSrc(href)} />
          {cursor && <CursorOverlay cursor={cursor} />}{' '}
          {click &&
            isRecord(click.data?.action) &&
            click.data.action.type === 'click' &&
            typeof click.data.action.x === 'number' &&
            typeof click.data.action.y === 'number' && (
              <span
                key={click.id}
                className="sl-click-pulse"
                style={{
                  left: (click.data.action.x / VIEWPORT_WIDTH) * 100 + '%',
                  top: (click.data.action.y / VIEWPORT_HEIGHT) * 100 + '%',
                }}
              />
            )}
        </div>
      ) : (
        <div className="sl-frame-empty">
          {failedSrc === href && href ? 'Browser image unavailable' : emptyMessage}
        </div>
      )}
    </div>
  );
}

function StreamBanner({
  error,
  onRefresh,
}: {
  error: string;
  onRefresh: () => Promise<AgentRun[] | null>;
}) {
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="sl-alert sl-alert--warning sl-stream-banner" role="alert">
      <div>
        <strong>Live updates need attention.</strong> {error}
      </div>
      <button
        type="button"
        className="sl-btn sl-btn--small"
        onClick={() => {
          void refresh();
        }}
        disabled={refreshing}
      >
        {refreshing ? 'Refreshing…' : 'Refresh runs'}
      </button>
    </div>
  );
}

function runActivitySignature(run: AgentRun): string {
  return [
    run.events.length,
    run.findings.length,
    run.step,
    run.status,
    run.outcome,
    run.error ?? '',
  ].join('|');
}

function useActivitySummary(run: AgentRun) {
  const runId = run.config.id;
  const signature = runActivitySignature(run);
  const [payload, setPayload] = useState<ActivitySummaryPayload | null>(null);
  const [loadedSignature, setLoadedSignature] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const latestRun = useRef(run);
  latestRun.current = run;

  useEffect(() => {
    const requestId = ++request.current;
    const requestedFor = runActivitySignature(latestRun.current);
    setPayload(null);
    setLoadedSignature(null);
    setError(null);
    setLoading(true);
    setGenerating(false);
    // Cache reads do not invoke the summarizer; generation starts when opened.
    void requestJson(`/api/runs/${encodeURIComponent(runId)}/summary`)
      .then((value) => {
        if (request.current !== requestId) return;
        setPayload(parseActivitySummaryPayload(value));
        setLoadedSignature(requestedFor);
      })
      .catch((failure: unknown) => {
        if (request.current === requestId) setError(errorMessage(failure));
      })
      .finally(() => {
        if (request.current === requestId) setLoading(false);
      });
    return () => {
      request.current += 1;
    };
    // The run object changes on every live event; only re-read when the run changes identity.
  }, [runId]);

  const generate = useCallback(async (): Promise<void> => {
    if (generating) return;
    const requestId = request.current;
    const requestedFor = runActivitySignature(latestRun.current);
    setGenerating(true);
    setError(null);
    try {
      const value = await requestJson(`/api/runs/${encodeURIComponent(runId)}/summary`, {
        method: 'POST',
        body: {},
      });
      if (request.current !== requestId) return;
      setPayload(parseActivitySummaryPayload(value));
      setLoadedSignature(requestedFor);
    } catch (failure) {
      if (request.current === requestId) setError(errorMessage(failure));
    } finally {
      if (request.current === requestId) setGenerating(false);
    }
  }, [generating, runId]);

  const summary = payload?.summary ?? null;
  return {
    summary,
    stale: payload ? payload.stale || (summary !== null && loadedSignature !== signature) : false,
    // A payload fetched before the first event must not pin the button off while
    // the run is still producing visible activity.
    canSummarize: payload?.canSummarize === true || run.events.length > 0,
    loading,
    generating,
    error,
    generate,
  };
}

function RunCard({ run }: { run: AgentRun; now: number }) {
  const level =
    run.status === 'failed' ||
    run.error ||
    run.findings.some((f) => f.severity === 'critical' || f.severity === 'major')
      ? 'error'
      : run.findings.some((f) => f.severity === 'minor') || run.status === 'paused'
        ? 'warning'
        : isTerminal(run.status)
          ? 'done'
          : 'running';
  const color =
    [
      '#9baeff',
      '#f5b76d',
      '#cf9cff',
      '#77d2ba',
      '#f191b5',
      '#a1cb79',
      '#76c5ed',
      '#e2d077',
      '#b1a1ec',
      '#b9c4cc',
    ][PROFILE_IDS.indexOf(run.config.profile)] ?? '#9baeff';
  return (
    <article
      className="sl-run-card sl-live-card"
      data-status={run.status}
      data-level={level}
      data-testid="run-card"
      style={{ '--agent-color': color } as CSSProperties}
    >
      <SmartLink
        href={agentPath(run.config.id)}
        className="sl-live-card-link"
        data-testid="run-link"
        aria-label={run.config.name + ' — ' + run.status}
      >
        <FrameSurface
          artifact={run.latestFrame}
          click={run.events.findLast(
            (e) =>
              e.kind === 'action' && isRecord(e.data?.action) && e.data.action.type === 'click',
          )}
          cursor={run.cursor}
          alt={'Live browser for ' + run.config.name}
          emptyMessage={emptyFrameMessage(run)}
          variant="card"
          testId="run-frame"
        />
        <div className="sl-live-caption">
          <span className="sl-agent-dot" />
          {profileMeta(run.config.profile).label}
          <span className="sl-live-status">{run.status}</span>
        </div>
      </SmartLink>
    </article>
  );
}

function ThinkingSummary({ run }: { run: AgentRun }) {
  const state = useActivitySummary(run);
  const { loading, generating, error, canSummarize, summary, stale, generate } = state;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && !loading && !generating && !error && canSummarize && (!summary || stale)) {
      const timer = window.setTimeout(() => {
        void generate();
      }, 1500);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [open, loading, generating, error, canSummarize, summary, stale, generate]);
  return (
    <details
      className="sl-thinking-summary"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Thinking summary {state.generating ? '· Updating…' : ''}</summary>
      <p className="sl-hint">A concise summary of visible decisions, not private reasoning.</p>
      {state.summary ? (
        <ul>
          {state.summary.bullets.map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      ) : (
        <p>{state.error ?? 'Waiting for enough activity.'}</p>
      )}
    </details>
  );
}

function AgentsSection({
  runs,
  error,
  onRefresh,
}: {
  runs: AgentRun[] | null;
  error: string | null;
  onRefresh: () => Promise<AgentRun[] | null>;
}) {
  const now = useNow(10_000);
  const [refreshing, setRefreshing] = useState(false);
  const sorted = useMemo(() => sortRuns(runs ?? []), [runs]);
  const [showAll, setShowAll] = useState(false);
  const visibleRuns = showAll
    ? sorted
    : sorted.filter((run, index) => index < 6 || !isTerminal(run.status));
  const activeCount = sorted.filter((run) => !isTerminal(run.status)).length;
  const total = runs?.length ?? 0;

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="sl-agents" id="agents" aria-labelledby="agents-heading">
      <div className="sl-section-head">
        <div>
          <h2 id="agents-heading">Runs</h2>
        </div>
        <div className="sl-section-actions">
          {runs ? (
            <span className="sl-count" aria-live="polite">
              {activeCount} active · {total} total
            </span>
          ) : null}
          <button
            type="button"
            className="sl-btn sl-btn--small"
            onClick={() => {
              void refresh();
            }}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="sl-alert sl-alert--error" role="alert">
          <div>
            <strong>Agent data could not be refreshed.</strong> {error}
          </div>
        </div>
      ) : null}

      {runs === null && !error ? (
        <div className="sl-run-grid" aria-busy="true" aria-label="Loading agents">
          {[0, 1, 2].map((index) => (
            <div className="sl-skeleton sl-skeleton-card" key={index} aria-hidden="true" />
          ))}
        </div>
      ) : null}

      {runs !== null && runs.length === 0 ? (
        <div className="sl-empty">
          <span className="sl-empty-mark" aria-hidden="true" />
          <h3>No agents yet</h3>
          <p>Start a new run to give the agents a task and collect browser evidence.</p>
          <SmartLink className="sl-btn sl-btn--primary" href="/dashboard/new">
            New run
          </SmartLink>
        </div>
      ) : null}

      {sorted.length > 0 ? (
        <div className="sl-run-grid">
          {visibleRuns.map((run) => (
            <RunCard run={run} now={now} key={run.config.id} />
          ))}
        </div>
      ) : null}
      {sorted.length > 6 ? (
        <button
          className="sl-btn sl-runs-toggle"
          type="button"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? 'Show recent runs' : `Show all ${sorted.length} runs`}
        </button>
      ) : null}
    </section>
  );
}

function ControlRoom({
  runs,
  health,
  healthError,
  onRefreshRuns,
}: {
  runs: AgentRun[] | null;
  health: HealthReport | null;
  healthError: string | null;
  onRefreshRuns: () => Promise<AgentRun[] | null>;
}) {
  const [task, setTask] = useState('');
  const [scenario, setScenario] = useState<Scenario>('shop');
  const [url, setUrl] = useState('');
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('auto');
  const [selectedProfiles, setSelectedProfiles] = useState<Profile[]>([
    ...DEFAULT_PROFILE_SELECTION,
  ]);
  const [verify, setVerify] = useState(false);
  const [defect, setDefect] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setVerify(localStorage.getItem('sightline-default-verify') === 'true');
  }, []);

  const activeCount = runs?.filter((run) => !isTerminal(run.status)).length ?? null;
  const plannedCount =
    selectionMode === 'auto' ? DEFAULT_PROFILE_SELECTION.length : selectedProfiles.length;
  const defaultStartUrl = health?.replicaOrigin ? `${health.replicaOrigin}/${scenario}` : null;
  const modelCheck = health?.entries.find((entry) => entry.key === 'model');
  const backendCheck = health?.entries.find((entry) => entry.key === 'backend');

  function toggleProfile(profile: Profile, checked: boolean) {
    setSelectedProfiles((current) => {
      if (checked) return PROFILE_IDS.filter((item) => item === profile || current.includes(item));
      return current.filter((item) => item !== profile);
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setNotice(null);

    const cleanTask = task.trim();
    if (!cleanTask) {
      setFormError('Enter the task the agents should attempt.');
      taskRef.current?.focus();
      return;
    }
    if (cleanTask.length > MAX_TASK_LENGTH) {
      setFormError(`Task text must be ${MAX_TASK_LENGTH} characters or fewer.`);
      taskRef.current?.focus();
      return;
    }

    if (selectionMode === 'custom' && selectedProfiles.length === 0) {
      setFormError('Select at least one interaction profile for a custom launch.');
      return;
    }

    if (activeCount !== null && activeCount + plannedCount > CONCURRENT_LIMIT) {
      setFormError(
        `${pluralize(activeCount, 'agent')} already active. Sightline allows up to ${CONCURRENT_LIMIT} concurrent agents.`,
      );
      return;
    }

    if (url.trim()) urlRef.current?.closest('details')?.setAttribute('open', '');
    const trimmedUrl = url.trim();
    if (trimmedUrl) {
      if (trimmedUrl.length > MAX_URL_LENGTH) {
        setFormError(`Start URL must be ${MAX_URL_LENGTH} characters or fewer.`);
        urlRef.current?.focus();
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(trimmedUrl);
      } catch {
        setFormError('Start URL must be an absolute URL, or left blank for the scenario default.');
        urlRef.current?.focus();
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setFormError('Start URL must use http or https.');
        urlRef.current?.focus();
        return;
      }
      if (defaultStartUrl && trimmedUrl !== defaultStartUrl) {
        setFormError(`Start URL must be exactly ${defaultStartUrl}, or left blank.`);
        urlRef.current?.focus();
        return;
      }
    }

    const body: CreateRunBody = {
      task: cleanTask,
      scenario,
      verify,
      defect,
    };
    if (trimmedUrl) body.url = trimmedUrl;
    if (selectionMode === 'custom') {
      body.profiles = PROFILE_IDS.filter((profile) => selectedProfiles.includes(profile));
    }

    setSubmitting(true);
    try {
      const payload = await requestJson('/api/runs', { method: 'POST', body });
      let result: LaunchResult = { ids: [], runs: [] };
      try {
        result = parseLaunchPayload(payload);
      } catch {
        // The launch request succeeded; the acknowledgement shape is not the pinned {ids} contract.
        result = { ids: [], runs: [] };
      }

      const refreshed = await onRefreshRuns();
      const launchedCount = result.runs.length || result.ids.length;
      const launchedNames = result.runs.length
        ? result.runs.map((run) => run.config.name)
        : result.ids
            .map((id) => refreshed?.find((run) => run.config.id === id)?.config.name)
            .filter((name): name is string => Boolean(name));

      if (launchedCount === 0) {
        setNotice('Launch accepted. New agents will appear as the live feed updates.');
      } else if (launchedNames.length > 0 && launchedNames.length <= 5) {
        setNotice(`Launched ${pluralize(launchedCount, 'agent')}: ${launchedNames.join(', ')}.`);
      } else {
        setNotice(`Launched ${pluralize(launchedCount, 'agent')}. Their cards are updating below.`);
      }
    } catch (error) {
      setFormError(`Launch failed. ${errorMessage(error)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="sl-hero" aria-labelledby="page-heading">
        <div className="sl-hero-copy">
          <h1 id="page-heading">New run</h1>
          <p>What should your agents try?</p>
        </div>
        <div className="sl-hero-stats" aria-label="Run totals">
          <div className="sl-stat">
            <strong>{activeCount === null ? '—' : activeCount}</strong>
            <span>active</span>
          </div>
          <div className="sl-stat">
            <strong>{runs === null ? '—' : runs.length}</strong>
            <span>total runs</span>
          </div>
        </div>
      </section>

      <div className="sl-workspace">
        <section id="launch" className="sl-panel sl-launch" aria-labelledby="page-heading">
          <form onSubmit={handleSubmit} noValidate>
            <div className="sl-form-grid">
              <div className="sl-field sl-field--wide">
                <label htmlFor="task">Task</label>
                <textarea
                  id="task"
                  ref={taskRef}
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder="Find a product, choose a variant, add it to the cart, and complete checkout with synthetic data."
                  maxLength={MAX_TASK_LENGTH}
                  rows={4}
                  required
                  data-testid="task-input"
                />
                <span className="sl-counter">
                  {task.length}/{MAX_TASK_LENGTH}
                </span>
              </div>

              <fieldset className="sl-fieldset sl-field--wide">
                <legend>Scenario</legend>
                <div className="sl-radio-cards">
                  {SCENARIO_ORDER.map((value) => {
                    const meta = SCENARIO_META[value];
                    return (
                      <label className="sl-radio-card" key={value}>
                        <input
                          type="radio"
                          name="scenario"
                          value={value}
                          checked={scenario === value}
                          onChange={() => setScenario(value)}
                          data-testid={`scenario-${value}`}
                        />
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          aria-hidden="true"
                        >
                          <path
                            d={
                              value === 'shop'
                                ? 'M3 3h2l3 12h10l3-8H6m3 13h.01M18 20h.01'
                                : 'm3 9 9-6 9 6M5 10v10h14V10M9 20v-6h6v6M2 21h20'
                            }
                          />
                        </svg>
                        <span className="sl-choice-title">{meta.label}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <details className="sl-launch-disclosure sl-field--wide">
                <summary>
                  Run settings <span>{plannedCount} agents</span>
                </summary>
                <div className="sl-form-grid">
                  <div className="sl-field">
                    <label htmlFor="start-url">
                      Start URL <span className="sl-optional">optional</span>
                    </label>
                    <input
                      id="start-url"
                      ref={urlRef}
                      type="url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder={defaultStartUrl ?? 'Controlled replica URL'}
                      maxLength={MAX_URL_LENGTH}
                      data-testid="url-input"
                    />
                  </div>

                  <fieldset className="sl-fieldset sl-field--wide">
                    <legend>Interaction profiles</legend>
                    <label className="sl-switch ws-compact-switch">
                      <input
                        type="checkbox"
                        checked={selectionMode === 'custom'}
                        onChange={(event) =>
                          setSelectionMode(event.target.checked ? 'custom' : 'auto')
                        }
                        data-testid="profiles-custom"
                        aria-label="Choose profiles manually"
                      />
                      <span className="sl-switch-track" aria-hidden="true" />
                      <span className="sl-switch-text">
                        <strong>Choose profiles manually</strong>
                      </span>
                    </label>

                    {selectionMode === 'custom' ? (
                      <div className="sl-profile-grid">
                        {PROFILE_IDS.map((profile) => {
                          const meta = profileMeta(profile);
                          return (
                            <label className="sl-check-card" key={profile}>
                              <input
                                type="checkbox"
                                checked={selectedProfiles.includes(profile)}
                                onChange={(event) => toggleProfile(profile, event.target.checked)}
                                data-testid={`profile-${profile}`}
                              />
                              <span>
                                <strong>{meta.label}</strong>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="sl-hint">
                        {DEFAULT_PROFILE_SELECTION.length} agents selected automatically.
                      </p>
                    )}
                  </fieldset>

                  <div className="sl-toggle-grid">
                    <label className="sl-switch">
                      <input
                        type="checkbox"
                        checked={verify}
                        onChange={(event) => setVerify(event.target.checked)}
                        aria-label="Clean rerun verification"
                        data-testid="verify-toggle"
                      />
                      <span className="sl-switch-track" aria-hidden="true" />
                      <span className="sl-switch-text">
                        <strong>Verify with a clean rerun</strong>
                      </span>
                    </label>

                    <label className="sl-switch sl-switch--defect">
                      <input
                        type="checkbox"
                        checked={defect}
                        onChange={(event) => setDefect(event.target.checked)}
                        aria-label="Seed synthetic authored defect"
                        data-testid="defect-toggle"
                      />
                      <span className="sl-switch-track" aria-hidden="true" />
                      <span className="sl-switch-text">
                        <strong>Include a test defect</strong>
                      </span>
                    </label>
                  </div>
                </div>
              </details>
            </div>

            {backendCheck && !backendCheck.ok ? (
              <div className="sl-alert sl-alert--error" role="status" data-testid="backend-warning">
                <div>
                  <strong>Backend unavailable.</strong>{' '}
                  {backendCheck.detail || 'The SpacetimeDB health check failed.'} Launches will fail
                  explicitly until the backend is healthy.
                </div>
              </div>
            ) : null}

            {modelCheck && !modelCheck.ok ? (
              <div className="sl-alert sl-alert--error" role="status" data-testid="model-warning">
                <div>
                  <strong>Model unavailable.</strong> {modelCheck.detail}
                </div>
              </div>
            ) : null}

            {!health && healthError ? (
              <div className="sl-alert sl-alert--warning" role="status">
                <div>
                  <strong>Model status unknown.</strong> The health endpoint could not be reached,
                  so launch attempts cannot be preflighted here. Execution will fail explicitly if
                  the model is not configured.
                </div>
              </div>
            ) : null}

            {formError ? (
              <div className="sl-alert sl-alert--error" role="alert" data-testid="launch-error">
                <div>{formError}</div>
              </div>
            ) : null}

            {notice ? (
              <div className="sl-alert sl-alert--success" role="status" data-testid="launch-notice">
                <div>{notice}</div>
              </div>
            ) : null}

            <div className="sl-form-footer">
              <p className="sl-hint">{plannedCount} agents</p>
              <button
                className="sl-btn sl-btn--primary"
                type="submit"
                disabled={submitting}
                data-testid="launch-agents"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="m8 4 12 8-12 8V4Z" />
                </svg>
                {submitting ? 'Launching…' : 'Launch agents'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}

function DetailLoading() {
  return (
    <div className="sl-detail" aria-busy="true">
      <h1 className="sl-visually-hidden">Loading agent</h1>
      <div className="sl-detail-head">
        <SmartLink className="sl-back" href="/dashboard">
          ← Control room
        </SmartLink>
        <div className="sl-skeleton sl-skeleton-title" aria-hidden="true" />
        <div className="sl-skeleton sl-skeleton-meta" aria-hidden="true" />
      </div>
      <div className="sl-detail-grid">
        <div className="sl-skeleton sl-skeleton-viewer" aria-hidden="true" />
        <div className="sl-skeleton sl-skeleton-side" aria-hidden="true" />
      </div>
    </div>
  );
}

function AgentDetail({
  id,
  runs,
  onRefreshRuns,
}: {
  id: string;
  runs: AgentRun[] | null;
  onRefreshRuns: () => Promise<AgentRun[] | null>;
}) {
  const [fetched, setFetched] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'timeline' | 'info'>('timeline');
  const [message, setMessage] = useState('');
  const [interrupt, setInterrupt] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let disposed = false;
    void requestJson('/api/runs/' + encodeURIComponent(id))
      .then((p) => {
        if (!disposed) setFetched(parseSingleRunPayload(p));
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      });
    return () => {
      disposed = true;
    };
  }, [id]);
  const run = newestRun(runs?.find((r) => r.config.id === id) ?? null, fetched);
  if (!run) return error ? <div role="alert">{error}</div> : <DetailLoading />;
  const terminal = isTerminal(run.status);
  const color = [
    '#9baeff',
    '#f5b76d',
    '#cf9cff',
    '#77d2ba',
    '#f191b5',
    '#a1cb79',
    '#76c5ed',
    '#e2d077',
    '#b1a1ec',
    '#b9c4cc',
  ][PROFILE_IDS.indexOf(run.config.profile)];
  const timeline = run.events.filter(
    (e, i) =>
      i === 0 ||
      [
        'action',
        'finding',
        'error',
        'finished',
        'completed',
        'message_applied',
        'decision',
        'claim',
        'state',
        'control',
        'message',
      ].includes(e.kind),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || sending || terminal) return;
    setSending(true);
    setNotice('');
    try {
      await requestJson('/api/runs/' + encodeURIComponent(id) + '/messages', {
        method: 'POST',
        body: { text: message.trim(), interrupt },
      });
      setMessage('');
      setNotice(interrupt ? 'Interrupt requested.' : 'Message queued.');
      void onRefreshRuns();
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setSending(false);
    }
  }
  return (
    <div
      className="sl-detail sl-browser-workspace"
      data-testid="detail-page"
      style={{ '--agent-color': color } as CSSProperties}
    >
      <section className="sl-browser-stage" aria-label="Agent browser">
        <div className="sl-browser-toolbar">
          <SmartLink href="/dashboard" aria-label="Back to current runs">
            ←
          </SmartLink>
          <span>{profileMeta(run.config.profile).label}</span>
          <span>{run.status}</span>
        </div>
        <div className="sl-browser-viewport" data-completed={run.status === 'completed'}>
          <FrameSurface
            artifact={run.latestFrame}
            click={run.events.findLast(
              (e) =>
                e.kind === 'action' && isRecord(e.data?.action) && e.data.action.type === 'click',
            )}
            cursor={run.cursor}
            alt={'Live browser for ' + run.config.name}
            variant="viewer"
            emptyMessage={emptyFrameMessage(run)}
            testId="detail-frame"
          />
          {run.status === 'completed' && (
            <div className="sl-completed-overlay">
              <span>✓</span>
              <strong>Task done</strong>
            </div>
          )}
        </div>
      </section>
      <aside className="sl-inspector">
        <div className="sl-inspector-tabs" role="tablist" aria-label="Agent information">
          {(['timeline', 'info'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {value === 'timeline' ? 'Timeline' : 'Info'}
            </button>
          ))}
        </div>
        <div className="sl-inspector-content" role="tabpanel">
          {tab === 'timeline' ? (
            <>
              <ThinkingSummary run={run} />
              <ol className="sl-compact-timeline">
                {timeline.map((event) => (
                  <li key={event.id} data-kind={event.kind}>
                    <time>{formatClock(event.at)}</time>
                    <strong>{humanizeKey(event.kind)}</strong>
                    <p>{event.text}</p>
                  </li>
                ))}
              </ol>
              {run.findings.map((f) => (
                <div className="sl-inspector-finding" key={f.id} data-severity={f.severity}>
                  <strong>{f.title}</strong>
                  <p>{f.detail}</p>
                </div>
              ))}
            </>
          ) : (
            <>
              <h2>{run.config.name}</h2>
              <StatusBadge status={run.status} />
              <dl>
                <dt>Task</dt>
                <dd>{run.config.task}</dd>
                <dt>Profile</dt>
                <dd>{profileMeta(run.config.profile).label}</dd>
                <dt>Scenario</dt>
                <dd>{SCENARIO_META[run.config.scenario].label}</dd>
                <dt>Actions</dt>
                <dd>{run.step}</dd>
              </dl>
              {run.outcome && <p>{run.outcome}</p>}
              {run.error && <p role="alert">{run.error}</p>}
              {!terminal && (
                <label className="sl-inspector-control">
                  Execution
                  <select
                    aria-label="Execution"
                    value={run.requested}
                    onChange={(event) => {
                      void requestJson('/api/runs/' + encodeURIComponent(id) + '/control', {
                        method: 'POST',
                        body: { command: event.target.value },
                      })
                        .then(() => onRefreshRuns())
                        .catch((e) => setNotice(errorMessage(e)));
                    }}
                  >
                    <option value="running">Running</option>
                    <option value="paused">Paused</option>
                    <option value="stopped">Stop</option>
                  </select>
                </label>
              )}
            </>
          )}
        </div>
        <form className="sl-inspector-message" onSubmit={submit}>
          <label className="sl-switch">
            <input
              type="checkbox"
              checked={interrupt}
              onChange={(e) => setInterrupt(e.target.checked)}
              disabled={terminal}
              aria-label="Interrupt current action"
            />
            <span className="sl-switch-track" aria-hidden="true" />
            <span>Interrupt</span>
          </label>
          <textarea
            aria-label="Message agent"
            placeholder={terminal ? 'Run finished' : 'Message agent · Enter to send'}
            value={message}
            maxLength={MAX_MESSAGE_LENGTH}
            disabled={terminal || sending}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <span role="status">{notice}</span>
        </form>
      </aside>
    </div>
  );
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="sl-not-found">
      <div className="sl-panel sl-detail-error">
        <p className="sl-kicker">Sightline</p>
        <h1>Page not found</h1>
        <p>
          No route matches <code>{path}</code>.
        </p>
        <SmartLink className="sl-btn sl-btn--primary" href="/dashboard">
          Return to the control room
        </SmartLink>
      </div>
    </div>
  );
}

export default function App() {
  const pathname = usePathname();
  const router = useRouter();
  const route = useMemo(() => parseRoute(pathname), [pathname]);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const sseSeen = useRef(false);

  const navigate = useCallback(
    (path: string) => {
      if (!path.startsWith('/')) {
        window.location.assign(path);
        return;
      }
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin) {
        window.location.assign(url.href);
        return;
      }
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        if (url.hash)
          document.getElementById(url.hash.slice(1))?.scrollIntoView({ block: 'start' });
        return;
      }
      router.push(`${url.pathname}${url.search}${url.hash}`);
    },
    [router],
  );

  useEffect(() => {
    if (route.kind === 'report') return;
    if (route.kind === 'detail') {
      const run = runs?.find((candidate) => candidate.config.id === route.id);
      document.title = run ? `${run.config.name} · Sightline` : 'Agent · Sightline';
    } else if (route.kind === 'not-found') {
      document.title = 'Page not found · Sightline';
    } else {
      document.title = 'Sightline · Visual agent testing lab';
    }
  }, [route, runs]);

  useEffect(() => {
    if (route.kind === 'report') return;
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [route]);

  useEffect(() => {
    let cancelled = false;
    void requestJson('/api/runs')
      .then((payload) => {
        if (cancelled || sseSeen.current) return;
        setRuns(parseRunsPayload(payload));
      })
      .catch((error: unknown) => {
        if (cancelled || sseSeen.current) return;
        setRunsError(`Could not load agents. ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const source = new EventSource('/api/events');

    source.onopen = () => {
      if (disposed) return;
      setFeedError(null);
    };

    source.onerror = () => {
      if (disposed) return;
      setFeedError('The live event stream disconnected. Reconnecting…');
    };

    const onRuns = (rawEvent: Event) => {
      if (disposed) return;
      const event = rawEvent as MessageEvent<unknown>;
      try {
        if (typeof event.data !== 'string') throw new Error('The live update had no data payload.');
        const payload = JSON.parse(event.data) as unknown;
        const nextRuns = parseRunsPayload(payload);
        sseSeen.current = true;
        setRuns(nextRuns);
        setRunsError(null);
        setFeedError(null);
      } catch (error) {
        setFeedError(`Live update could not be read: ${errorMessage(error)}`);
      }
    };

    source.addEventListener('runs', onRuns);
    return () => {
      disposed = true;
      source.removeEventListener('runs', onRuns);
      source.close();
    };
  }, []);

  const refreshRuns = useCallback(async (): Promise<AgentRun[] | null> => {
    try {
      const payload = await requestJson('/api/runs');
      const list = parseRunsPayload(payload);
      setRuns((current) => mergeRuns(current, list));
      setRunsError(null);
      return list;
    } catch (error) {
      setRunsError(`Could not refresh agents. ${errorMessage(error)}`);
      return null;
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const payload = await requestJson('/api/health');
      setHealth(parseHealthPayload(payload));
      setHealthError(null);
    } catch (error) {
      setHealthError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const timer = window.setInterval(() => {
      void refreshHealth();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  if (route.kind === 'report') return null;

  return (
    <NavigationContext.Provider value={navigate}>
      <div className="sl-app ws-app">
        <WorkspaceSidebar
          activeCount={runs?.filter((run) => !isTerminal(run.status)).length ?? 0}
        />
        <a className="sl-skip-link" href="#main">
          Skip to content
        </a>
        <main id="main" className="sl-main">
          <div className="sl-shell">
            {feedError ? <StreamBanner error={feedError} onRefresh={refreshRuns} /> : null}
            {route.kind === 'home' && route.screen !== 'new' ? (
              <>
                <section className="ws-page-head">
                  <div>
                    <h1>
                      {route.screen === 'history'
                        ? 'Run history'
                        : route.screen === 'settings'
                          ? 'Settings'
                          : 'Current runs'}
                    </h1>
                    <p>
                      {route.screen === 'history'
                        ? 'Completed, stopped, and failed journeys. Every run keeps its evidence.'
                        : route.screen === 'settings'
                          ? 'Appearance and defaults for your workspace.'
                          : 'Follow your agents, inspect their browser journeys, and review what they find.'}
                    </p>
                  </div>
                  {route.screen !== 'settings' ? (
                    <SmartLink href="/dashboard/new" className="sl-btn sl-btn--primary">
                      + New run
                    </SmartLink>
                  ) : null}
                </section>
                {route.screen === 'settings' ? (
                  <WorkspaceSettings />
                ) : (
                  <AgentsSection
                    key={route.screen}
                    runs={
                      runs === null
                        ? null
                        : route.screen === 'history'
                          ? runs.filter((run) => isTerminal(run.status))
                          : runs
                    }
                    error={runsError}
                    onRefresh={refreshRuns}
                  />
                )}
              </>
            ) : null}
            {route.kind === 'home' && route.screen === 'new' ? (
              <ControlRoom
                runs={runs}
                health={health}
                healthError={healthError}
                onRefreshRuns={refreshRuns}
              />
            ) : null}
            {route.kind === 'detail' ? (
              <AgentDetail id={route.id} runs={runs} onRefreshRuns={refreshRuns} key={route.id} />
            ) : null}
            {route.kind === 'not-found' ? <NotFound path={route.path} /> : null}
          </div>
        </main>
      </div>
    </NavigationContext.Provider>
  );
}
