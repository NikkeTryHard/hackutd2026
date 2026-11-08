import type { InferSchema, InferTypeOfRow, ReducerCtx, ViewCtx } from 'spacetimedb/server';
import { ScheduleAt, SenderError, schema, table, t } from 'spacetimedb/server';

/**
 * Sightline SpacetimeDB module.
 *
 * The application server is the only trusted client. Every mutating reducer
 * except the first backend claim and the internal schedule reducer validates
 * that the caller identity was registered by `claim_backend`. Browser clients
 * never connect to this database; the replica server mediates world actions
 * through the application server.
 */

// Mirrors PROFILE_IDS in src/profiles.ts. This module is deployed separately,
// so the allowlist is duplicated at the database validation boundary.
const PROFILES = [
  'baseline',
  'keyboard',
  'pointer',
  'older-adult',
  'child',
  'young-adult',
  'deuteranopia',
  'protanopia',
  'tritanopia',
  'achromatopsia',
] as const;
const SCENARIOS = ['shop', 'portal'] as const;
const STATUSES = ['queued', 'running', 'paused', 'stopped', 'completed', 'failed'] as const;
const COMMANDS = ['running', 'paused', 'stopped'] as const;
const SEVERITIES = ['info', 'minor', 'major', 'critical'] as const;

const VIEW_SCOPE = 'all';

const LIMITS = {
  id: 64,
  name: 80,
  task: 4000,
  url: 2048,
  text: 4000,
  kind: 48,
  artifact: 512,
  dataJson: 32_768,
  outcome: 8000,
  error: 4000,
  reason: 1000,
  findings: 200,
  messages: 100,
  eventsPerRun: 50_000,
  // The step column is a u32. This is a storage bound, not an agent budget.
  maxStep: 4_294_967_295,
  scheduleDelayMs: 10_000,
  scheduleLateGraceMs: 15_000,
} as const;

const SHOP_VARIANTS: Record<string, readonly string[]> = {
  notebook: ['ruled', 'dot-grid'],
  bottle: ['slate', 'sand'],
  backpack: ['black', 'olive'],
  lamp: ['white', 'graphite'],
};

const PORTAL_PANELS: Record<string, true> = {
  calendar: true,
  catalog: true,
  schedule: true,
  grades: true,
  aid: true,
  accounts: true,
  library: true,
  advising: true,
  tutoring: true,
  career: true,
  health: true,
  housing: true,
  parking: true,
  printing: true,
  it: true,
  accessibility: true,
  events: true,
  emergency: true,
};

const WRITABLE_PATCH_FIELDS: Record<string, true> = {
  config: true,
  status: true,
  requested: true,
  step: true,
  outcome: true,
  latestFrame: true,
  cursor: true,
  error: true,
  findings: true,
  events: true,
  createdAt: true,
  updatedAt: true,
};

const run = table(
  { name: 'sightline_run' },
  {
    scope: t.string().index(),
    id: t.string().primaryKey(),
    name: t.string(),
    profile: t.string(),
    task: t.string(),
    scenario: t.string(),
    url: t.string(),
    maxActions: t.u32(), // legacy, never enforced; new rows store 0
    verify: t.bool(),
    defect: t.bool(),
    verificationOf: t.string().default(''),
    status: t.string(),
    requested: t.string(),
    step: t.u32(),
    createdAt: t.f64(),
    updatedAt: t.f64(),
    outcome: t.string(),
    latestFrame: t.string(),
    cursorX: t.u32(),
    cursorY: t.u32(),
    hasCursor: t.bool(),
    error: t.string(),
    nextSeq: t.u32(),
  },
);

const event = table(
  { name: 'sightline_event' },
  {
    scope: t.string().index(),
    id: t.string().primaryKey(),
    agentId: t.string().index(),
    seq: t.u32(),
    at: t.f64(),
    kind: t.string(),
    text: t.string(),
    dataJson: t.string(),
    artifact: t.string(),
  },
);

const finding = table(
  { name: 'sightline_finding' },
  {
    scope: t.string().index(),
    id: t.string().primaryKey(),
    agentId: t.string().index(),
    ordinal: t.u32(),
    title: t.string(),
    detail: t.string(),
    severity: t.string(),
    observationId: t.string(),
    verification: t.string(),
    createdAt: t.f64(),
  },
);

const message = table(
  { name: 'sightline_message' },
  {
    scope: t.string().index(),
    id: t.u64().primaryKey().autoInc(),
    agentId: t.string().index(),
    text: t.string(),
    createdAt: t.f64(),
    deliveredAt: t.f64(),
    interrupt: t.bool().default(false),
  },
);

const command = table(
  { name: 'sightline_command' },
  {
    scope: t.string().index(),
    id: t.u64().primaryKey().autoInc(),
    agentId: t.string().index(),
    command: t.string(),
    at: t.f64(),
    appliedAt: t.f64(),
  },
);

const world = table(
  { name: 'sightline_world' },
  {
    scope: t.string().index(),
    agentId: t.string().primaryKey(),
    scenario: t.string(),
    revision: t.u32(),
    stock: t.u32(),
    notice: t.string(),
    cart: t.u32(),
    selected: t.string(),
    completed: t.bool(),
    panelsJson: t.string(),
    appliedRevision: t.u32(),
    defect: t.bool(),
  },
);

const worldTransition = table(
  { name: 'sightline_world_transition' },
  {
    scope: t.string().index(),
    id: t.string().primaryKey(),
    agentId: t.string().index(),
    kind: t.string(),
    requestedAt: t.f64(),
    scheduledFor: t.f64(),
    executedAt: t.f64(),
    status: t.string(),
    detail: t.string(),
  },
);

// Private table: schedule rows are internal plumbing, not client-visible state.
const worldSchedule = table(
  { name: 'sightline_world_schedule' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    transitionId: t.string().unique(),
    agentId: t.string(),
  },
);

// Private table: only the process that claims the database may write runs,
// evidence, messages, controls and worlds.
const trustedWriter = table(
  { name: 'sightline_trusted_writer' },
  {
    identity: t.identity().primaryKey(),
    label: t.string(),
    createdAt: t.f64(),
  },
);

const spacetimedb = schema(
  {
    run,
    event,
    finding,
    message,
    command,
    world,
    worldTransition,
    worldSchedule,
    trustedWriter,
  },
  {
    env: {
      BACKEND_TOKEN: t.string().optional(),
    },
  },
);

export default spacetimedb;

type ModuleSchema = InferSchema<typeof spacetimedb>;
type Ctx = ReducerCtx<ModuleSchema>;
type ViewContext = ViewCtx<ModuleSchema>;
type RunRow = InferTypeOfRow<typeof run.rowType.row>;
type WorldRow = InferTypeOfRow<typeof world.rowType.row>;
type TransitionRow = InferTypeOfRow<typeof worldTransition.rowType.row>;

function viewTrusted(ctx: ViewContext): boolean {
  return ctx.db.trustedWriter.identity.find(ctx.sender) !== null;
}

// Public views are the only read surface for the application server. They
// return no rows to an identity that has not claimed the backend, so the raw
// tables remain private even though the view names are public.
export const runView = spacetimedb.view(
  { name: 'run_view', public: true },
  t.array(run.rowType),
  (ctx) => (viewTrusted(ctx) ? [...ctx.db.run.scope.filter(VIEW_SCOPE)] : []),
);

export const eventView = spacetimedb.view(
  { name: 'event_view', public: true },
  t.array(event.rowType),
  (ctx) => (viewTrusted(ctx) ? [...ctx.db.event.scope.filter(VIEW_SCOPE)] : []),
);

export const findingView = spacetimedb.view(
  { name: 'finding_view', public: true },
  t.array(finding.rowType),
  (ctx) => (viewTrusted(ctx) ? [...ctx.db.finding.scope.filter(VIEW_SCOPE)] : []),
);

export const messageView = spacetimedb.view(
  { name: 'message_view', public: true },
  t.array(message.rowType),
  (ctx) => (viewTrusted(ctx) ? [...ctx.db.message.scope.filter(VIEW_SCOPE)] : []),
);

export const commandView = spacetimedb.view(
  { name: 'command_view', public: true },
  t.array(command.rowType),
  (ctx) => (viewTrusted(ctx) ? [...ctx.db.command.scope.filter(VIEW_SCOPE)] : []),
);

export const worldView = spacetimedb.view(
  { name: 'world_view', public: true },
  t.array(world.rowType),
  (ctx) => (viewTrusted(ctx) ? [...ctx.db.world.scope.filter(VIEW_SCOPE)] : []),
);

export const worldTransitionView = spacetimedb.view(
  { name: 'world_transition_view', public: true },
  t.array(worldTransition.rowType),
  (ctx) => (viewTrusted(ctx) ? [...ctx.db.worldTransition.scope.filter(VIEW_SCOPE)] : []),
);

function nowMs(ctx: { timestamp: { microsSinceUnixEpoch: bigint } }): number {
  return Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
}

function fail(message: string): never {
  throw new SenderError(message);
}

function requireString(value: string, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) fail(`${label} must not be empty`);
  if (value.length > max) fail(`${label} exceeds ${max} characters`);
  return value;
}

function requireId(value: string, label: string): string {
  requireString(value, label, LIMITS.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail(`${label} must contain only letters, digits, underscore or dash`);
  }
  return value;
}

function requireTransitionId(value: string, label: string): string {
  requireString(value, label, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value)) {
    fail(`${label} contains invalid characters`);
  }
  return value;
}

function requireOneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) fail(`${label} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function isTerminal(status: string): boolean {
  return status === 'stopped' || status === 'completed' || status === 'failed';
}

function assertTrusted(ctx: Ctx): void {
  const sender = ctx.sender;
  const record = ctx.db.trustedWriter.identity.find(sender);
  if (!record) {
    fail('caller is not the trusted Sightline backend; call claim_backend first');
  }
}

function assertInternalSchedule(ctx: Ctx): void {
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) {
    fail('scheduled reducer may only be invoked by the database scheduler');
  }
}

function getRun(ctx: Ctx, agentId: string) {
  const row = ctx.db.run.id.find(agentId);
  if (!row) fail(`unknown agent run: ${agentId}`);
  return row;
}

function getWorld(ctx: Ctx, agentId: string) {
  const row = ctx.db.world.agentId.find(agentId);
  if (!row) fail(`world is missing for agent run: ${agentId}`);
  return row;
}

function defaultWorld(agentId: string, scenario: string, defect: boolean) {
  if (scenario === 'shop') {
    return {
      scope: VIEW_SCOPE,
      agentId,
      scenario,
      revision: 0,
      stock: defect ? 0 : 5,
      notice: defect ? 'Out of stock' : 'In stock',
      cart: 0,
      selected: '',
      completed: false,
      panelsJson: '[]',
      appliedRevision: 0,
      defect,
    };
  }
  return {
    scope: VIEW_SCOPE,
    agentId,
    scenario,
    revision: 0,
    stock: 0,
    notice: defect ? 'Planned maintenance in progress' : 'All systems normal',
    cart: 0,
    selected: '',
    completed: false,
    panelsJson: '[]',
    appliedRevision: 0,
    defect,
  };
}

function parsePanels(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('world panels are corrupt');
  }
  if (!Array.isArray(parsed)) fail('world panels are corrupt');
  const panels: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') fail('world panels are corrupt');
    panels.push(item);
  }
  return panels;
}

function appendRunEvent(
  ctx: Ctx,
  agentId: string,
  kind: string,
  text: string,
  dataJson: string,
  artifact = '',
): { seq: number; at: number } | null {
  const row = ctx.db.run.id.find(agentId);
  if (!row) return null;
  if (row.nextSeq >= LIMITS.eventsPerRun) {
    fail(`agent run ${agentId} exceeded the event limit`);
  }
  const seq = row.nextSeq;
  const at = nowMs(ctx);
  ctx.db.event.insert({
    scope: VIEW_SCOPE,
    id: `${agentId}:${seq}`,
    agentId,
    seq,
    at,
    kind,
    text,
    dataJson,
    artifact,
  });
  row.nextSeq = seq + 1;
  row.updatedAt = at;
  ctx.db.run.id.update(row);
  return { seq, at };
}

function applyScheduleTransition(ctx: Ctx, transition: TransitionRow): void {
  if (transition.status !== 'pending') return;
  const at = nowMs(ctx);
  const runRow = ctx.db.run.id.find(transition.agentId);
  if (!runRow) {
    transition.status = 'failed';
    transition.executedAt = at;
    transition.detail = 'agent run was missing when the scheduled transition ran';
    ctx.db.worldTransition.id.update(transition);
    return;
  }
  if (isTerminal(runRow.status)) {
    transition.status = 'skipped';
    transition.executedAt = at;
    transition.detail = `agent run is terminal (${runRow.status})`;
    ctx.db.worldTransition.id.update(transition);
    return;
  }

  const row = ctx.db.world.agentId.find(transition.agentId);

  transition.executedAt = at;
  if (!row) {
    transition.status = 'failed';
    transition.detail = 'world row was missing when the scheduled transition ran';
    ctx.db.worldTransition.id.update(transition);
    appendRunEvent(
      ctx,
      transition.agentId,
      'error',
      `Scenario infrastructure error: scheduled ${transition.kind} transition ran but the world row was missing.`,
      JSON.stringify({ transitionId: transition.id, kind: transition.kind }),
    );
    return;
  }

  const previous = { stock: row.stock, notice: row.notice };
  if (row.scenario === 'shop') {
    if (row.defect) {
      row.stock = 0;
      row.notice = 'Backorder expected next week';
    } else {
      row.stock = 4;
      row.notice = 'Spring sale ends Friday';
    }
  } else {
    row.notice = row.defect ? 'Maintenance extended' : 'Registration opens Monday';
  }
  row.revision = row.revision + 1;
  ctx.db.world.agentId.update(row);

  transition.status = 'executed';
  transition.detail = `stock=${row.stock}; notice=${row.notice}`;
  ctx.db.worldTransition.id.update(transition);

  appendRunEvent(
    ctx,
    transition.agentId,
    'world',
    `Scheduled ${row.scenario} change applied: ${row.notice}${row.scenario === 'shop' ? ` (stock ${row.stock})` : ''}.`,
    JSON.stringify({
      transitionId: transition.id,
      kind: transition.kind,
      requestedAt: transition.requestedAt,
      scheduledFor: transition.scheduledFor,
      executedAt: at,
      revision: row.revision,
      previous,
      next: { stock: row.stock, notice: row.notice },
    }),
  );
}

function normalizeFinding(
  raw: unknown,
  index: number,
): {
  id: string;
  ordinal: number;
  title: string;
  detail: string;
  severity: string;
  observationId: string;
  verification: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`findings[${index}] must be an object`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string') fail(`findings[${index}].id must be a string`);
  if (typeof value.title !== 'string') fail(`findings[${index}].title must be a string`);
  if (typeof value.detail !== 'string') fail(`findings[${index}].detail must be a string`);
  if (typeof value.severity !== 'string') fail(`findings[${index}].severity must be a string`);
  const severity = requireOneOf(value.severity, SEVERITIES, `findings[${index}].severity`);
  const observationId = typeof value.observationId === 'string' ? value.observationId : '';
  const verification = typeof value.verification === 'string' ? value.verification : '';
  requireId(value.id, `findings[${index}].id`);
  requireString(value.title, `findings[${index}].title`, 200);
  requireString(value.detail, `findings[${index}].detail`, 4000);
  if (observationId.length > LIMITS.id) fail(`findings[${index}].observationId is too long`);
  if (verification.length > 4000) fail(`findings[${index}].verification is too long`);
  return {
    id: value.id,
    ordinal: index,
    title: value.title,
    detail: value.detail,
    severity,
    observationId,
    verification,
  };
}

function validatePartial(run: RunRow, partialJson: string): Record<string, unknown> {
  if (partialJson.length > LIMITS.dataJson) fail('patch payload is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(partialJson);
  } catch {
    fail('patch payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('patch payload must be a JSON object');
  }
  const partial = parsed as Record<string, unknown>;
  for (const key of Object.keys(partial)) {
    if (!WRITABLE_PATCH_FIELDS[key]) fail(`patch field is not writable: ${key}`);
  }

  if ('config' in partial && partial.config !== undefined) {
    const config = partial.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      fail('patch config must be an object');
    }
    const c = config as Record<string, unknown>;
    const checks: Array<[string, unknown, unknown]> = [
      ['id', run.id, c.id],
      ['name', run.name, c.name],
      ['profile', run.profile, c.profile],
      ['task', run.task, c.task],
      ['scenario', run.scenario, c.scenario],
      ['url', run.url, c.url ?? ''],
      ['verify', run.verify, c.verify],
      ['defect', run.defect, c.defect ?? false],
      ['verificationOf', run.verificationOf, c.verificationOf ?? ''],
    ];
    for (const [field, current, proposed] of checks) {
      if (proposed !== current) fail(`run config is immutable; ${field} differs`);
    }
  }

  if ('status' in partial) {
    if (typeof partial.status !== 'string') fail('patch status must be a string');
    requireOneOf(partial.status, STATUSES, 'patch status');
  }
  if ('requested' in partial) {
    if (typeof partial.requested !== 'string') fail('patch requested must be a string');
    requireOneOf(partial.requested, COMMANDS, 'patch requested');
  }
  if ('step' in partial) {
    if (typeof partial.step !== 'number' || !Number.isInteger(partial.step)) {
      fail('patch step must be an integer');
    }
    if (partial.step < 0 || partial.step > LIMITS.maxStep) {
      fail(`patch step must be between 0 and ${LIMITS.maxStep}`);
    }
    if (partial.step < run.step) fail('patch step may not move backwards');
  }
  if ('outcome' in partial) {
    if (typeof partial.outcome !== 'string') fail('patch outcome must be a string');
    if (partial.outcome.length > LIMITS.outcome) fail('patch outcome is too long');
  }
  if ('error' in partial) {
    if (typeof partial.error !== 'string') fail('patch error must be a string');
    if (partial.error.length > LIMITS.error) fail('patch error is too long');
  }
  if ('latestFrame' in partial) {
    const frame = partial.latestFrame;
    if (typeof frame !== 'string') fail('patch latestFrame must be a string');
    if (frame.length > LIMITS.artifact) fail('patch latestFrame is too long');
    if (frame.length > 0 && (!frame.startsWith('/artifacts/') || frame.includes('..'))) {
      fail('patch latestFrame must be an /artifacts/ path');
    }
  }
  if ('cursor' in partial) {
    const cursor = partial.cursor;
    if (cursor !== undefined && cursor !== null) {
      if (typeof cursor !== 'object' || Array.isArray(cursor)) {
        fail('patch cursor must be an object or null');
      }
      const c = cursor as Record<string, unknown>;
      for (const axis of ['x', 'y'] as const) {
        const value = c[axis];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) {
          fail(`patch cursor.${axis} must be a finite non-negative number`);
        }
      }
    }
  }
  if ('findings' in partial) {
    if (!Array.isArray(partial.findings)) fail('patch findings must be an array');
    if (partial.findings.length > LIMITS.findings) fail('too many findings in patch');
  }
  if ('events' in partial && partial.events !== undefined && !Array.isArray(partial.events)) {
    fail('patch events must be an array when provided');
  }
  return partial;
}

export const claimBackend = spacetimedb.reducer({ token: t.string() }, (ctx, { token }) => {
  if (token.length > 256) fail('backend token is too long');
  const expected = ctx.env.get('BACKEND_TOKEN');
  const existing = [...ctx.db.trustedWriter.iter()];
  const already = existing.some((row) => row.identity.isEqual(ctx.sender));
  if (already) return;

  if (expected !== null && expected !== '' && token !== expected) {
    fail('backend token mismatch; set BACKEND_TOKEN to the published value');
  }
  if (existing.length > 0 && (expected === null || expected === '')) {
    fail(
      'backend is already claimed by another identity; restore the saved SpacetimeDB token or publish a fresh database',
    );
  }

  ctx.db.trustedWriter.insert({
    identity: ctx.sender,
    label: 'sightline-backend',
    createdAt: nowMs(ctx),
  });
});

export const createRun = spacetimedb.reducer(
  {
    id: t.string(),
    name: t.string(),
    profile: t.string(),
    task: t.string(),
    scenario: t.string(),
    url: t.string(),
    maxActions: t.u32(),
    verify: t.bool(),
    defect: t.bool(),
    verificationOf: t.string(),
  },
  (ctx, config) => {
    assertTrusted(ctx);
    requireId(config.id, 'config.id');
    requireString(config.name, 'config.name', LIMITS.name);
    const profile = requireOneOf(config.profile, PROFILES, 'config.profile');
    const scenario = requireOneOf(config.scenario, SCENARIOS, 'config.scenario');
    requireString(config.task, 'config.task', LIMITS.task);
    if (config.url.length > LIMITS.url) fail('config.url is too long');
    // `maxActions` remains in the reducer signature and table only so existing
    // published rows and callers keep working. It is never enforced; new runs
    // store zero.
    if (config.verificationOf.length > 0) {
      requireId(config.verificationOf, 'config.verificationOf');
      if (config.verificationOf === config.id) fail('a run cannot verify itself');
    }
    if (ctx.db.run.id.find(config.id)) fail(`agent run already exists: ${config.id}`);
    if (ctx.db.world.agentId.find(config.id)) fail(`world already exists: ${config.id}`);

    const at = nowMs(ctx);
    ctx.db.run.insert({
      scope: VIEW_SCOPE,
      id: config.id,
      name: config.name,
      profile,
      task: config.task,
      scenario,
      url: config.url,
      maxActions: 0,
      verify: config.verify,
      defect: config.defect,
      verificationOf: config.verificationOf,
      status: 'queued',
      requested: 'running',
      step: 0,
      createdAt: at,
      updatedAt: at,
      outcome: '',
      latestFrame: '',
      cursorX: 0,
      cursorY: 0,
      hasCursor: false,
      error: '',
      nextSeq: 0,
    });
    ctx.db.world.insert(defaultWorld(config.id, scenario, config.defect));

    const transitionId = `${config.id}:scheduled-notice`;
    if (transitionId.length > 160) fail('transition id is too long');
    const scheduledFor = at + LIMITS.scheduleDelayMs;
    ctx.db.worldTransition.insert({
      scope: VIEW_SCOPE,
      id: transitionId,
      agentId: config.id,
      kind: 'scheduled_notice',
      requestedAt: at,
      scheduledFor,
      executedAt: 0,
      status: 'pending',
      detail: '',
    });
    ctx.db.worldSchedule.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(BigInt(Math.round(scheduledFor)) * 1000n),
      transitionId,
      agentId: config.id,
    });
  },
);

export const patchRun = spacetimedb.reducer(
  { agentId: t.string(), partialJson: t.string() },
  (ctx, { agentId, partialJson }) => {
    assertTrusted(ctx);
    requireId(agentId, 'agentId');
    const row = getRun(ctx, agentId);
    const partial = validatePartial(row, partialJson);
    const at = nowMs(ctx);

    const frozen = isTerminal(row.status);
    const hasMutation = Object.keys(partial).some(
      (key) => key !== 'config' && key !== 'events' && key !== 'createdAt' && key !== 'updatedAt',
    );
    if (frozen && hasMutation) fail('terminal run evidence is immutable');

    let changed = false;
    if (typeof partial.status === 'string' && partial.status !== row.status) {
      const allowed: Record<string, string[]> = {
        queued: ['running', 'paused', 'stopped', 'failed'],
        running: ['paused', 'stopped', 'completed', 'failed'],
        paused: ['running', 'stopped', 'completed', 'failed'],
        stopped: [],
        completed: [],
        failed: [],
      };
      if (!(allowed[row.status] ?? []).includes(partial.status)) {
        fail(`illegal status transition: ${row.status} -> ${partial.status}`);
      }
      row.status = partial.status;
      row.updatedAt = at;
      changed = true;

      for (const record of ctx.db.command.agentId.filter(agentId)) {
        if (record.appliedAt !== 0) continue;
        if (record.command === partial.status || isTerminal(partial.status)) {
          record.appliedAt = at;
          ctx.db.command.id.update(record);
        }
      }
    }

    if (typeof partial.requested === 'string' && partial.requested !== row.requested) {
      row.requested = partial.requested;
      row.updatedAt = at;
      ctx.db.command.insert({
        scope: VIEW_SCOPE,
        id: 0n,
        agentId,
        command: partial.requested,
        at,
        appliedAt: 0,
      });
      changed = true;
    }

    if (typeof partial.step === 'number' && partial.step !== row.step) {
      row.step = partial.step;
      row.updatedAt = at;
      changed = true;
    }
    if (typeof partial.outcome === 'string' && partial.outcome !== row.outcome) {
      row.outcome = partial.outcome;
      row.updatedAt = at;
      changed = true;
    }
    if (typeof partial.error === 'string' && partial.error !== row.error) {
      row.error = partial.error;
      row.updatedAt = at;
      changed = true;
    }
    if (typeof partial.latestFrame === 'string' && partial.latestFrame !== row.latestFrame) {
      row.latestFrame = partial.latestFrame;
      row.updatedAt = at;
      changed = true;
    }
    if ('cursor' in partial) {
      const cursor = partial.cursor as { x: number; y: number } | null | undefined;
      if (cursor === null || cursor === undefined) {
        if (row.hasCursor) {
          row.hasCursor = false;
          row.cursorX = 0;
          row.cursorY = 0;
          row.updatedAt = at;
          changed = true;
        }
      } else {
        const x = Math.round(cursor.x);
        const y = Math.round(cursor.y);
        if (!row.hasCursor || row.cursorX !== x || row.cursorY !== y) {
          row.hasCursor = true;
          row.cursorX = x;
          row.cursorY = y;
          row.updatedAt = at;
          changed = true;
        }
      }
    }

    if (Array.isArray(partial.findings)) {
      const incoming = partial.findings.map((item, index) => normalizeFinding(item, index));
      const seen = new Set<string>();
      for (const item of incoming) {
        if (seen.has(item.id)) fail(`duplicate finding id in patch: ${item.id}`);
        seen.add(item.id);
      }
      const existing = [...ctx.db.finding.agentId.filter(agentId)];
      const existingById = new Map(existing.map((item) => [item.id, item]));
      for (const current of existing) {
        if (!seen.has(current.id)) {
          ctx.db.finding.id.delete(current.id);
          changed = true;
        }
      }
      for (const item of incoming) {
        const current = existingById.get(item.id);
        if (current) {
          if (
            current.ordinal !== item.ordinal ||
            current.title !== item.title ||
            current.detail !== item.detail ||
            current.severity !== item.severity ||
            current.observationId !== item.observationId ||
            current.verification !== item.verification
          ) {
            current.ordinal = item.ordinal;
            current.title = item.title;
            current.detail = item.detail;
            current.severity = item.severity;
            current.observationId = item.observationId;
            current.verification = item.verification;
            ctx.db.finding.id.update(current);
            changed = true;
          }
        } else {
          ctx.db.finding.insert({
            scope: VIEW_SCOPE,
            id: item.id,
            agentId,
            ordinal: item.ordinal,
            title: item.title,
            detail: item.detail,
            severity: item.severity,
            observationId: item.observationId,
            verification: item.verification,
            createdAt: at,
          });
          changed = true;
        }
      }
    }

    if (changed) ctx.db.run.id.update(row);
  },
);

export const appendEvent = spacetimedb.reducer(
  {
    agentId: t.string(),
    eventId: t.string(),
    kind: t.string(),
    text: t.string(),
    dataJson: t.string(),
    artifact: t.string(),
  },
  (ctx, args) => {
    assertTrusted(ctx);
    requireId(args.agentId, 'agentId');
    requireId(args.eventId, 'eventId');
    requireString(args.kind, 'event.kind', LIMITS.kind);
    requireString(args.text, 'event.text', LIMITS.text, true);
    if (args.dataJson.length > LIMITS.dataJson) fail('event data is too large');
    if (args.dataJson.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.dataJson);
      } catch {
        fail('event data is not valid JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('event data must be a JSON object');
      }
    }
    if (args.artifact.length > LIMITS.artifact || args.artifact.includes('..')) {
      fail('event artifact path is invalid');
    }
    const row = getRun(ctx, args.agentId);
    if (isTerminal(row.status)) fail('cannot append evidence to a terminal run');
    if (row.nextSeq >= LIMITS.eventsPerRun) fail('run exceeded the event limit');
    const at = nowMs(ctx);
    const seq = row.nextSeq;
    ctx.db.event.insert({
      scope: VIEW_SCOPE,
      id: args.eventId,
      agentId: args.agentId,
      seq,
      at,
      kind: args.kind,
      text: args.text,
      dataJson: args.dataJson,
      artifact: args.artifact,
    });
    row.nextSeq = seq + 1;
    row.updatedAt = at;
    ctx.db.run.id.update(row);
  },
);

export const sendMessage = spacetimedb.reducer(
  { agentId: t.string(), text: t.string(), interrupt: t.bool() },
  (ctx, { agentId, text, interrupt }) => {
    assertTrusted(ctx);
    requireId(agentId, 'agentId');
    requireString(text, 'message text', LIMITS.text);
    const row = getRun(ctx, agentId);
    if (isTerminal(row.status)) fail('cannot queue a message for a terminal run');
    let pending = 0;
    for (const record of ctx.db.message.agentId.filter(agentId)) {
      if (record.deliveredAt === 0) pending += 1;
    }
    if (pending >= LIMITS.messages) fail('too many undelivered operator messages');
    const at = nowMs(ctx);
    ctx.db.message.insert({
      scope: VIEW_SCOPE,
      id: 0n,
      agentId,
      text,
      interrupt,
      createdAt: at,
      deliveredAt: 0,
    });
    row.updatedAt = at;
    ctx.db.run.id.update(row);
  },
);

// A procedure is used here instead of a reducer because the caller must see
// exactly which durable messages were consumed. Reading the local replica cache
// before a reducer call would race a message written by a different client.
export const takeMessagesNow = spacetimedb.procedure(
  { agentId: t.string() },
  t.string(),
  (ctx, { agentId }) => {
    requireId(agentId, 'agentId');
    return ctx.withTx((tx) => {
      assertTrusted(tx);
      const run = getRun(tx, agentId);
      if (isTerminal(run.status)) fail('cannot deliver messages to a terminal run');
      const pending = [...tx.db.message.agentId.filter(agentId)]
        .filter((record) => record.deliveredAt === 0)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (pending.length > LIMITS.messages) {
        fail(`agent run has more than ${LIMITS.messages} undelivered messages`);
      }
      const at = nowMs(tx);
      const messages: Array<{ text: string; interrupt: boolean }> = [];
      for (const record of pending) {
        record.deliveredAt = at;
        tx.db.message.id.update(record);
        messages.push({ text: record.text, interrupt: record.interrupt });
      }
      if (pending.length > 0) {
        run.updatedAt = at;
        tx.db.run.id.update(run);
      }
      return JSON.stringify(messages);
    });
  },
);

function touchWorld(row: WorldRow, changed: boolean): void {
  if (changed) row.revision = row.revision + 1;
}

export const worldAction = spacetimedb.reducer(
  { agentId: t.string(), action: t.string(), value: t.string() },
  (ctx, { agentId, action, value }) => {
    assertTrusted(ctx);
    requireId(agentId, 'agentId');
    requireString(action, 'world action', 32);
    if (value.length > 512) fail('world action value is too long');
    const run = getRun(ctx, agentId);
    if (isTerminal(run.status)) fail('cannot mutate the world of a terminal run');
    const row = getWorld(ctx, agentId);
    let changed = false;

    if (row.scenario === 'shop') {
      switch (action) {
        case 'search': {
          if (value.length > 200) fail('search query is too long');
          break;
        }
        case 'select': {
          if (!Object.hasOwn(SHOP_VARIANTS, value)) {
            fail(`unknown shop product: ${value}`);
          }
          if (row.selected !== value) {
            row.selected = value;
            changed = true;
          }
          break;
        }
        case 'variant': {
          if (!row.selected) {
            fail('select a product before choosing a variant');
          }
          const product = row.selected.split('/')[0];
          if (product === undefined) {
            fail('select a product before choosing a variant');
          }
          const variants = SHOP_VARIANTS[product];
          if (!variants || !variants.includes(value)) {
            fail(`invalid variant ${value} for ${product}`);
          }
          const next = `${product}/${value}`;
          if (row.selected !== next) {
            row.selected = next;
            changed = true;
          }
          break;
        }
        case 'addToCart': {
          if (row.completed) fail('checkout is already complete');
          if (!row.selected || !row.selected.includes('/')) {
            fail('select a product and variant before adding to cart');
          }
          if (value !== row.selected.split('/')[0]) {
            fail('addToCart value must match the selected product');
          }
          if (row.stock <= 0) fail('selected product is out of stock');
          row.cart = row.cart + 1;
          changed = true;
          break;
        }
        case 'checkout': {
          if (row.completed) fail('checkout is already complete');
          if (row.cart <= 0) fail('cart is empty');
          row.completed = true;
          changed = true;
          break;
        }
        default:
          fail(`unsupported shop world action: ${action}`);
      }
    } else {
      switch (action) {
        case 'panel': {
          if (!PORTAL_PANELS[value]) fail(`unknown portal panel: ${value}`);
          const panels = parsePanels(row.panelsJson);
          if (!panels.includes(value)) {
            panels.push(value);
            row.panelsJson = JSON.stringify(panels);
            changed = true;
          }
          break;
        }
        case 'closePanel': {
          if (!PORTAL_PANELS[value]) fail(`unknown portal panel: ${value}`);
          const panels = parsePanels(row.panelsJson);
          const index = panels.indexOf(value);
          if (index >= 0) {
            panels.splice(index, 1);
            row.panelsJson = JSON.stringify(panels);
            changed = true;
          }
          break;
        }
        case 'search': {
          if (value.length > 200) fail('search query is too long');
          break;
        }
        case 'schedule': {
          const parts = value.split('|');
          if (parts.length !== 3) fail('schedule value must be YYYY-MM-DD|HH:MM|slot');
          const [date, time, slot] = parts;
          if (date === undefined || time === undefined || slot === undefined) {
            fail('schedule value must be YYYY-MM-DD|HH:MM|slot');
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
            fail('schedule date or time is malformed');
          }
          if (!Number.isFinite(Date.parse(`${date}T${time}:00Z`))) {
            fail('schedule date or time is not a real calendar value');
          }
          requireString(slot, 'schedule slot', 80);
          if (value.length > 200) fail('schedule value is too long');
          const data = JSON.stringify({ date, time, slot });
          appendRunEvent(
            ctx,
            agentId,
            'world',
            `Portal schedule requested for ${date} ${time} (${slot}).`,
            data,
          );
          changed = true;
          break;
        }
        default:
          fail(`unsupported portal world action: ${action}`);
      }
    }

    // A no-op action (search/idempotent panel) must not create a new revision.
    touchWorld(row, changed);
    if (changed) {
      row.appliedRevision = Math.min(row.appliedRevision, row.revision);
      ctx.db.world.agentId.update(row);
      run.updatedAt = nowMs(ctx);
      ctx.db.run.id.update(run);
    }
  },
);

export const acknowledgeWorld = spacetimedb.reducer(
  { agentId: t.string(), revision: t.u32() },
  (ctx, { agentId, revision }) => {
    assertTrusted(ctx);
    requireId(agentId, 'agentId');
    const run = getRun(ctx, agentId);
    const row = getWorld(ctx, agentId);
    if (revision > row.revision) {
      fail(`cannot acknowledge revision ${revision}; world is at ${row.revision}`);
    }
    // A late render ack must not move a frozen terminal world.
    if (isTerminal(run.status)) return;
    if (revision > row.appliedRevision) {
      row.appliedRevision = revision;
      ctx.db.world.agentId.update(row);
    }
  },
);

export const failWorldTransition = spacetimedb.reducer(
  { transitionId: t.string(), reason: t.string() },
  (ctx, { transitionId, reason }) => {
    assertTrusted(ctx);
    requireTransitionId(transitionId, 'transitionId');
    requireString(reason, 'transition failure reason', LIMITS.reason);
    const transition = ctx.db.worldTransition.id.find(transitionId);
    if (!transition) fail(`unknown world transition: ${transitionId}`);
    if (transition.status !== 'pending') return;
    const at = nowMs(ctx);
    const run = ctx.db.run.id.find(transition.agentId);
    if (!run || isTerminal(run.status)) {
      transition.status = 'skipped';
      transition.executedAt = at;
      transition.detail = !run ? 'agent run is missing' : `agent run is terminal (${run.status})`;
      ctx.db.worldTransition.id.update(transition);
      return;
    }
    transition.status = 'failed';
    transition.executedAt = at;
    transition.detail = reason;
    ctx.db.worldTransition.id.update(transition);
    appendRunEvent(
      ctx,
      transition.agentId,
      'error',
      `Scenario infrastructure error: scheduled ${transition.kind} transition did not execute. ${reason}`,
      JSON.stringify({
        transitionId,
        kind: transition.kind,
        requestedAt: transition.requestedAt,
        scheduledFor: transition.scheduledFor,
        failedAt: at,
      }),
    );
  },
);

export const runWorldSchedule = spacetimedb.reducer(
  { onSchedule: worldSchedule },
  { arg: worldSchedule.rowType },
  (ctx, { arg }) => {
    assertInternalSchedule(ctx);
    const transition = ctx.db.worldTransition.id.find(arg.transitionId);
    if (!transition) return;
    applyScheduleTransition(ctx, transition);
  },
);
