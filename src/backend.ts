import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  AgentConfig,
  AgentRun,
  Backend,
  Command,
  EvidenceEvent,
  Finding,
  MessageOptions,
  OperatorMessage,
  Profile,
  Scenario,
  Status,
  World,
} from './contracts';
import { isProfile } from './profiles';
import { DbConnection } from '../spacetimedb/bindings/index';
import type {
  SightlineEvent,
  SightlineFinding,
  SightlineRun,
  SightlineWorld,
} from '../spacetimedb/bindings/types';

/**
 * Bun-side SpacetimeDB adapter.
 *
 * The module keeps every raw table private and exposes public views that only
 * return rows to an identity that has claimed the backend. This adapter is that
 * trusted client. It stores its identity token under DATA_DIR so the server and
 * the smoke harness can share one identity.
 */

const DEFAULT_SPACETIME_URL = 'http://127.0.0.1:3000';
const DEFAULT_SPACETIME_DATABASE = 'sightline';
const TOKEN_FILENAME = 'spacetime-token';
const CONNECT_TIMEOUT_MS = 5_000;
const VIEW_READY_TIMEOUT_MS = 5_000;
const WORLD_READY_TIMEOUT_MS = 5_000;
const OVERDUE_GRACE_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 2_000;

const VIEW_QUERIES = [
  'SELECT * FROM run_view',
  'SELECT * FROM event_view',
  'SELECT * FROM finding_view',
  'SELECT * FROM message_view',
  'SELECT * FROM command_view',
  'SELECT * FROM world_view',
  'SELECT * FROM world_transition_view',
];

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

type AgentConfigRuntime = AgentConfig & { defect?: boolean; verificationOf?: string };

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

function toProfile(value: string, runId: string): Profile {
  if (isProfile(value)) return value;
  throw new Error(`run ${runId} has an invalid profile: ${value}`);
}

function toScenario(value: string, runId: string): Scenario {
  if (value === 'shop' || value === 'portal') return value;
  throw new Error(`run ${runId} has an invalid scenario: ${value}`);
}

function toStatus(value: string, runId: string): Status {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'paused' ||
    value === 'stopped' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value;
  }
  throw new Error(`run ${runId} has an invalid status: ${value}`);
}

function toCommand(value: string, runId: string): Command {
  if (value === 'running' || value === 'paused' || value === 'stopped') return value;
  throw new Error(`run ${runId} has an invalid requested command: ${value}`);
}

function toSeverity(value: string, findingId: string): Finding['severity'] {
  if (value === 'info' || value === 'minor' || value === 'major' || value === 'critical') {
    return value;
  }
  throw new Error(`finding ${findingId} has an invalid severity: ${value}`);
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> | undefined {
  if (raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  // Validated above: a non-array object is the contract's data shape.
  return parsed as Record<string, unknown>;
}

function parsePanels(raw: string, agentId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`world ${agentId} has corrupt panel state`);
  }
  if (!Array.isArray(parsed)) throw new Error(`world ${agentId} has corrupt panel state`);
  const panels: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') throw new Error(`world ${agentId} has corrupt panel state`);
    panels.push(item);
  }
  return panels;
}

function mapEvent(row: SightlineEvent): EvidenceEvent {
  const data = parseJsonObject(row.dataJson, `event ${row.id} data`);
  // Older builds persisted the model's private `reasoning` in event data.
  // Strip it at the read boundary so no UI or report can expose hidden
  // chain-of-thought, even for historical rows.
  if (data) delete data.reasoning;
  return {
    id: row.id,
    agentId: row.agentId,
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    text: row.text,
    ...(data ? { data } : {}),
    ...(row.artifact ? { artifact: row.artifact } : {}),
  };
}

function mapFinding(row: SightlineFinding): Finding {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    severity: toSeverity(row.severity, row.id),
    ...(row.observationId ? { observationId: row.observationId } : {}),
    ...(row.verification ? { verification: row.verification } : {}),
  };
}

function mapWorld(row: SightlineWorld): World {
  return {
    agentId: row.agentId,
    scenario: toScenario(row.scenario, row.agentId),
    revision: row.revision,
    stock: row.stock,
    notice: row.notice,
    cart: row.cart,
    selected: row.selected,
    completed: row.completed,
    panels: parsePanels(row.panelsJson, row.agentId),
    appliedRevision: row.appliedRevision,
    defect: row.defect,
  };
}

function mapRun(row: SightlineRun, events: EvidenceEvent[], findings: Finding[]): AgentRun {
  const config: AgentConfigRuntime = {
    id: row.id,
    name: row.name,
    profile: toProfile(row.profile, row.id),
    task: row.task,
    scenario: toScenario(row.scenario, row.id),
    verify: row.verify,
    defect: row.defect,
  };
  if (row.url) config.url = row.url;
  if (row.verificationOf) config.verificationOf = row.verificationOf;

  return {
    config,
    status: toStatus(row.status, row.id),
    requested: toCommand(row.requested, row.id),
    step: row.step,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    events,
    findings,
    outcome: row.outcome,
    ...(row.latestFrame ? { latestFrame: row.latestFrame } : {}),
    ...(row.hasCursor ? { cursor: { x: row.cursorX, y: row.cursorY } } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function sortEvents(rows: SightlineEvent[]): SightlineEvent[] {
  return rows.sort((a, b) => a.seq - b.seq);
}

function sortFindings(rows: SightlineFinding[]): SightlineFinding[] {
  return rows.sort((a, b) => a.ordinal - b.ordinal);
}

function groupEvents(rows: Iterable<SightlineEvent>): Map<string, SightlineEvent[]> {
  const grouped = new Map<string, SightlineEvent[]>();
  for (const row of rows) {
    const list = grouped.get(row.agentId);
    if (list) list.push(row);
    else grouped.set(row.agentId, [row]);
  }
  return grouped;
}

function groupFindings(rows: Iterable<SightlineFinding>): Map<string, SightlineFinding[]> {
  const grouped = new Map<string, SightlineFinding[]>();
  for (const row of rows) {
    const list = grouped.get(row.agentId);
    if (list) list.push(row);
    else grouped.set(row.agentId, [row]);
  }
  return grouped;
}

function expectedWorldRevision(row: SightlineWorld, action: string, value: string): number {
  if (action === 'search') return row.revision;
  if (row.scenario === 'shop') {
    if (action === 'select') return row.selected === value ? row.revision : row.revision + 1;
    if (action === 'variant') {
      const product = row.selected.split('/')[0];
      if (product === undefined) return row.revision + 1;
      const variants = SHOP_VARIANTS[product];
      if (!variants || !variants.includes(value)) return row.revision + 1;
      return row.selected === `${product}/${value}` ? row.revision : row.revision + 1;
    }
    if (action === 'addToCart' || action === 'checkout') {
      return row.revision + 1;
    }
    return row.revision + 1;
  }
  if (action === 'panel') {
    if (!PORTAL_PANELS[value]) return row.revision + 1;
    return parsePanels(row.panelsJson, row.agentId).includes(value)
      ? row.revision
      : row.revision + 1;
  }
  if (action === 'closePanel') {
    if (!PORTAL_PANELS[value]) return row.revision + 1;
    return parsePanels(row.panelsJson, row.agentId).includes(value)
      ? row.revision + 1
      : row.revision;
  }
  if (action === 'schedule') return row.revision + 1;
  return row.revision + 1;
}

class SpacetimeBackend implements Backend {
  private readonly uri: string;
  private readonly database: string;
  private readonly tokenPath: string;
  private readonly envToken: string | undefined;
  private readonly claimToken: string;

  private connection: DbConnection | undefined;
  private connected = false;
  private ready = false;
  private tokenSaved = false;
  private closed = false;
  private token: string | undefined;
  private lastError: string | undefined;
  private generation = 0;
  private connectPromise: Promise<void> | undefined;
  private reconnectTimer: Timer | undefined;
  private watchdog: Timer | undefined;
  private retryDelayMs = 1_000;
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<() => void>();
  private readonly failingTransitions = new Set<string>();

  constructor() {
    const dataDir = resolve(process.env.DATA_DIR ?? './data');
    this.uri = (process.env.SPACETIME_URL ?? DEFAULT_SPACETIME_URL).replace(/\/+$/, '');
    this.database = process.env.SPACETIME_DATABASE ?? DEFAULT_SPACETIME_DATABASE;
    this.tokenPath = join(dataDir, TOKEN_FILENAME);
    const envToken = process.env.SPACETIME_TOKEN;
    this.envToken = envToken?.length ? envToken : undefined;
    this.claimToken = process.env.BACKEND_TOKEN ?? '';
  }

  async init(): Promise<void> {
    if (this.envToken) {
      this.token = this.envToken;
    } else {
      try {
        this.token = await this.readToken();
      } catch (error) {
        this.lastError = `cannot read SpacetimeDB identity token: ${formatError(error)}`;
      }
    }

    try {
      await this.connectAttempt();
    } catch {
      // The backend remains usable as a health surface; data methods fail
      // explicitly until a connection succeeds.
    }
    this.startWatchdog();
  }

  health(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve().then(() => {
      if (this.closed) return { ok: false, detail: 'Sightline backend is closed' };
      if (this.ready && this.connection) {
        const runs = [...this.connection.db.runView.iter()].length;
        return {
          ok: true,
          detail: `SpacetimeDB ${this.uri} database ${this.database}: connected and trusted; ${runs} run(s)`,
        };
      }
      if (this.connected) {
        return {
          ok: false,
          detail: `SpacetimeDB ${this.uri} database ${this.database}: connected but views are not ready${this.lastError ? `: ${this.lastError}` : ''}`,
        };
      }
      return {
        ok: false,
        detail: `SpacetimeDB ${this.uri} database ${this.database} is unavailable: ${this.lastError ?? 'not connected'}`,
      };
    });
  }

  list(): Promise<AgentRun[]> {
    return Promise.resolve().then(() => {
      const connection = this.requireReady();
      const eventGroups = groupEvents(connection.db.eventView.iter());
      const findingGroups = groupFindings(connection.db.findingView.iter());
      const runs = [...connection.db.runView.iter()].map((row) => {
        const events = sortEvents(eventGroups.get(row.id) ?? []).map(mapEvent);
        const findings = sortFindings(findingGroups.get(row.id) ?? []).map(mapFinding);
        return mapRun(row, events, findings);
      });
      return runs.sort((a, b) => b.createdAt - a.createdAt);
    });
  }

  get(id: string): Promise<AgentRun | undefined> {
    return Promise.resolve().then(() => {
      const connection = this.requireReady();
      const row = connection.db.runView.id.find(id);
      if (!row) return undefined;
      const events = sortEvents(
        [...connection.db.eventView.iter()].filter((item) => item.agentId === id),
      ).map(mapEvent);
      const findings = sortFindings(
        [...connection.db.findingView.iter()].filter((item) => item.agentId === id),
      ).map(mapFinding);
      return mapRun(row, events, findings);
    });
  }

  async create(config: AgentConfig): Promise<AgentRun> {
    const connection = this.requireReady();
    if (typeof config.id !== 'string' || config.id.length === 0) {
      throw new Error('create requires AgentConfig.id');
    }
    const runtimeConfig = config as AgentConfigRuntime;
    await connection.reducers.createRun({
      id: config.id,
      name: config.name,
      profile: config.profile,
      task: config.task,
      scenario: config.scenario,
      url: config.url ?? '',
      // The database column is a legacy, never-enforced field. Existing rows
      // keep their old value; new runs store zero and are unbounded.
      maxActions: 0,
      verify: config.verify,
      defect: runtimeConfig.defect === true,
      verificationOf: runtimeConfig.verificationOf ?? '',
    });
    await this.waitForValue(
      () => connection.db.runView.id.find(config.id) ?? undefined,
      VIEW_READY_TIMEOUT_MS,
      `run ${config.id} to appear`,
    );
    const run = await this.get(config.id);
    if (!run) throw new Error(`run ${config.id} was created but is not visible`);
    return run;
  }

  async patch(id: string, partial: Partial<AgentRun>): Promise<void> {
    const connection = this.requireReady();
    const encoded = JSON.stringify(partial, (key, value: unknown) =>
      key === 'events' ? undefined : value,
    );
    if (encoded === '{}') return;
    await connection.reducers.patchRun({ agentId: id, partialJson: encoded });
  }

  async append(
    id: string,
    event: Omit<EvidenceEvent, 'id' | 'agentId' | 'seq' | 'at'>,
  ): Promise<EvidenceEvent> {
    const connection = this.requireReady();
    const eventId = randomUUID();
    const dataJson = event.data ? JSON.stringify(event.data) : '';
    await connection.reducers.appendEvent({
      agentId: id,
      eventId,
      kind: event.kind,
      text: event.text,
      dataJson,
      artifact: event.artifact ?? '',
    });
    const row = await this.waitForValue(
      () => connection.db.eventView.id.find(eventId) ?? undefined,
      VIEW_READY_TIMEOUT_MS,
      `event ${eventId} to appear`,
    );
    return mapEvent(row);
  }

  async message(id: string, text: string, options: MessageOptions = {}): Promise<void> {
    const connection = this.requireReady();
    await connection.reducers.sendMessage({
      agentId: id,
      text,
      interrupt: options.interrupt === true,
    });
  }

  async takeMessages(id: string): Promise<OperatorMessage[]> {
    const connection = this.requireReady();
    const raw = await connection.procedures.takeMessagesNow({ agentId: id });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('takeMessagesNow returned invalid JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('takeMessagesNow returned a non-array result');
    const messages: OperatorMessage[] = [];
    for (const item of parsed) {
      // Older published modules returned bare strings. Keep consuming those
      // rows without interrupting anything; new rows carry the flag.
      if (typeof item === 'string') {
        messages.push({ text: item, interrupt: false });
        continue;
      }
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error('takeMessagesNow returned a non-message item');
      }
      const record = item as Record<string, unknown>;
      if (typeof record.text !== 'string') {
        throw new Error('takeMessagesNow returned a message without text');
      }
      messages.push({
        text: record.text,
        interrupt: record.interrupt === true,
      });
    }
    return messages;
  }

  world(id: string): Promise<World> {
    return Promise.resolve().then(() => {
      const connection = this.requireReady();
      return mapWorld(this.requireWorld(connection, id));
    });
  }

  async worldAction(id: string, action: string, value?: string): Promise<World> {
    const connection = this.requireReady();
    const before = this.requireWorld(connection, id);
    const expectedRevision = expectedWorldRevision(before, action, value ?? '');
    await connection.reducers.worldAction({
      agentId: id,
      action,
      value: value ?? '',
    });
    if (expectedRevision > before.revision) {
      await this.waitForValue(
        () => {
          const row = connection.db.worldView.agentId.find(id);
          return (row?.revision ?? -1) >= expectedRevision ? (row ?? undefined) : undefined;
        },
        WORLD_READY_TIMEOUT_MS,
        `world ${id} revision ${expectedRevision} to appear`,
      );
    }
    return mapWorld(this.requireWorld(connection, id));
  }

  async acknowledge(id: string, revision: number): Promise<void> {
    const connection = this.requireReady();
    if (!Number.isInteger(revision) || revision < 0 || revision > 4_294_967_295) {
      throw new Error('acknowledge requires an unsigned 32-bit revision');
    }
    await connection.reducers.acknowledgeWorld({ agentId: id, revision });
  }

  subscribe(listener: () => void): () => void {
    if (this.closed) throw new Error('Sightline backend is closed');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.closed) return;
      this.closed = true;
      this.generation += 1;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      if (this.watchdog) {
        clearInterval(this.watchdog);
        this.watchdog = undefined;
      }
      const connection = this.connection;
      this.connection = undefined;
      this.connected = false;
      this.ready = false;
      this.listeners.clear();
      this.waiters.clear();
      if (connection) connection.disconnect();
    });
  }

  private requireReady(): DbConnection {
    if (this.closed) throw new Error('SpacetimeDB backend is closed');
    if (!this.connection || !this.ready) {
      throw new Error(
        `SpacetimeDB is not ready at ${this.uri} database ${this.database}: ${this.lastError ?? 'connection pending'}`,
      );
    }
    return this.connection;
  }

  private requireWorld(connection: DbConnection, id: string): SightlineWorld {
    const row = connection.db.worldView.agentId.find(id);
    if (!row) throw new Error(`world is missing for run ${id}`);
    return row;
  }

  private async connectAttempt(): Promise<void> {
    if (this.closed) throw new Error('SpacetimeDB backend is closed');
    if (this.ready) return;
    if (this.connectPromise) return this.connectPromise;

    const generation = ++this.generation;
    const deferred = Promise.withResolvers<void>();
    const attempt = deferred.promise;
    this.connectPromise = attempt;

    let settled = false;
    let timer: Timer | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (this.connectPromise === attempt) this.connectPromise = undefined;
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      deferred.resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      this.lastError = formatError(error);
      deferred.reject(error instanceof Error ? error : new Error(this.lastError));
    };

    timer = setTimeout(() => {
      if (settled) return;
      this.generation += 1;
      this.lastError = `connection timed out after ${CONNECT_TIMEOUT_MS}ms`;
      const connection = this.connection;
      this.connection = undefined;
      this.connected = false;
      this.ready = false;
      if (connection) connection.disconnect();
      fail(new Error(this.lastError));
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    const builder = DbConnection.builder()
      .withUri(this.uri)
      .withDatabaseName(this.database)
      .withAutomaticReconnect({ minDelayMs: 500, maxDelayMs: 15_000 })
      .onConnect((connection, _identity, token) => {
        void this.handleConnected(connection, token, generation)
          .then(succeed)
          .catch((error) => {
            this.lastError = formatError(error);
            this.scheduleReconnect();
            fail(error);
          });
      })
      .onConnectError((_ctx, error, nextReconnectAttempt) => {
        if (generation !== this.generation) return;
        this.connected = false;
        this.ready = false;
        this.lastError = formatError(error);
        this.notify();
        if (nextReconnectAttempt === undefined) this.scheduleReconnect();
        fail(error);
      })
      .onAutomaticReconnect((connection, _identity, token) => {
        if (generation !== this.generation) return;
        this.connected = true;
        this.ready = true;
        this.token = token;
        this.lastError = undefined;
        this.retryDelayMs = 1_000;
        void this.saveToken(token);
        void connection.reducers
          .claimBackend({ token: this.claimToken })
          .catch((error: unknown) => {
            this.ready = false;
            this.lastError = `reconnected but could not claim the backend: ${formatError(error)}`;
            this.notify();
            this.scheduleReconnect();
          });
        this.notify();
      })
      .onDisconnect((_ctx, error, nextReconnectAttempt) => {
        if (generation !== this.generation) return;
        this.connected = false;
        this.ready = false;
        this.lastError = error ? formatError(error) : 'connection closed';
        this.notify();
        if (nextReconnectAttempt === undefined) this.scheduleReconnect();
      });

    if (this.token) builder.withToken(this.token);
    this.connection = builder.build();
    await attempt;
  }

  private async handleConnected(
    connection: DbConnection,
    token: string,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) throw new Error('stale SpacetimeDB connection attempt');
    this.connection = connection;
    this.connected = true;
    this.ready = false;
    this.token = token;
    this.registerTableCallbacks(connection);

    try {
      await connection.reducers.claimBackend({ token: this.claimToken });
    } catch (error) {
      const message = formatError(error);
      if (message.includes('already claimed')) {
        const sharedToken = await this.waitForSharedToken(1_500);
        if (sharedToken && sharedToken !== token) {
          this.token = sharedToken;
          connection.disconnect();
          throw new Error(
            'backend identity belongs to another process; retrying with the shared DATA_DIR token',
            { cause: error },
          );
        }
      }
      throw error;
    }

    const subscription = Promise.withResolvers<void>();
    connection
      .subscriptionBuilder()
      .onApplied(() => {
        if (generation !== this.generation) {
          subscription.reject(new Error('stale SpacetimeDB subscription'));
          return;
        }
        this.lastError = undefined;
        this.retryDelayMs = 1_000;
        if (this.tokenSaved) {
          this.ready = true;
          this.notify();
        }
        subscription.resolve();
      })
      .onError((errorContext) => {
        subscription.reject(errorContext.event ?? new Error('subscription failed'));
      })
      .subscribe(VIEW_QUERIES);
    await subscription.promise;

    await this.saveToken(token);
    this.tokenSaved = true;
    this.ready = true;
    this.notify();
  }

  private registerTableCallbacks(connection: DbConnection): void {
    const onChange = () => this.notify();
    for (const handle of [
      connection.db.runView,
      connection.db.eventView,
      connection.db.findingView,
      connection.db.messageView,
      connection.db.commandView,
      connection.db.worldView,
      connection.db.worldTransitionView,
    ]) {
      handle.onInsert(onChange);
      handle.onDelete(onChange);
      handle.onUpdate(onChange);
    }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('Sightline backend listener failed:', formatError(error));
      }
    }
  }

  private waitForValue<T>(
    get: () => T | undefined,
    timeoutMs: number,
    description: string,
  ): Promise<T> {
    const immediate = get();
    if (immediate !== undefined) return Promise.resolve(immediate);
    const deferred = Promise.withResolvers<T>();
    let timer: Timer | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      this.waiters.delete(check);
    };
    const check = () => {
      const value = get();
      if (value === undefined) return;
      cleanup();
      deferred.resolve(value);
    };
    timer = setTimeout(() => {
      cleanup();
      deferred.reject(new Error(`timed out after ${timeoutMs}ms waiting for ${description}`));
    }, timeoutMs);
    this.waiters.add(check);
    check();
    return deferred.promise;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.ready) return;
    const delayMs = Math.min(this.retryDelayMs, 15_000);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectAttempt().catch((error: unknown) => {
        this.lastError = formatError(error);
        this.notify();
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      void this.failOverdueTransitions();
    }, WATCHDOG_INTERVAL_MS);
  }

  private async failOverdueTransitions(): Promise<void> {
    if (this.closed || !this.ready || !this.connection) return;
    const now = Date.now();
    const connection = this.connection;
    for (const transition of connection.db.worldTransitionView.iter()) {
      if (transition.status !== 'pending') continue;
      if (transition.scheduledFor + OVERDUE_GRACE_MS > now) continue;
      if (this.failingTransitions.has(transition.id)) continue;
      this.failingTransitions.add(transition.id);
      try {
        await connection.reducers.failWorldTransition({
          transitionId: transition.id,
          reason: `transition did not execute by ${new Date(transition.scheduledFor).toISOString()} (${OVERDUE_GRACE_MS}ms grace)`,
        });
      } catch (error) {
        this.lastError = `scenario watchdog could not record an overdue transition: ${formatError(error)}`;
        this.notify();
      } finally {
        this.failingTransitions.delete(transition.id);
      }
    }
  }

  private async readToken(): Promise<string | undefined> {
    try {
      const token = (await Bun.file(this.tokenPath).text()).trim();
      try {
        await chmod(this.tokenPath, 0o600);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      return token.length > 0 ? token : undefined;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async saveToken(token: string): Promise<void> {
    if (!token) return;
    await mkdir(dirname(this.tokenPath), { recursive: true });
    const temporary = `${this.tokenPath}.${randomUUID()}.tmp`;
    // Exclusive create with 0600 from the outset; never widen via umask/chmod.
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(token, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.tokenPath);
  }

  private async waitForSharedToken(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const token = await this.readToken();
      if (token && token !== this.token) return token;
      await Bun.sleep(100);
    }
    return undefined;
  }
}

export async function createBackend(): Promise<Backend> {
  const backend = new SpacetimeBackend();
  await backend.init();
  return backend;
}
