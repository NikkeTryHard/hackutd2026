import type { Action, AgentConfig, EvidenceEvent, Finding, ModelDecision } from './contracts';
import { PROFILE_DEFINITIONS, isProfile } from './profiles';

/**
 * Screenshot-only model client for Sightline.
 *
 * The model receives exactly: the current PNG observation, the bounded operator
 * task, profile rules, a bounded textual event history and messages delivered at
 * the action boundary. It never receives DOM/source/accessibility data, world
 * state values, evaluator flags or credentials.
 */

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_SNIPPET = 600;
const DEFAULT_DECISION_TIMEOUT_MS = 90_000;
const PREFLIGHT_TIMEOUT_MS = 45_000;
const HEALTH_SUCCESS_TTL_MS = 5 * 60_000;
const HEALTH_FAILURE_TTL_MS = 30_000;
const MAX_TASK_CHARS = 4000;
const MAX_REASONING_CHARS = 2000;
const MAX_HISTORY_EVENTS = 16;
const MAX_HISTORY_CHARS = 4000;
const MAX_DELIVERED_MESSAGES = 6;
const MAX_DELIVERED_CHARS = 2000;
const MAX_ACTION_TEXT = 500;
const MAX_ARTIFACT_MODEL_OUTPUT = 1200;

const SCENARIOS = ['shop', 'portal'] as const;
const SEVERITIES = ['info', 'minor', 'major', 'critical'] as const;
const MODIFIERS: Record<string, true> = { Shift: true, Control: true, Alt: true, Meta: true };
const MODIFIER_ALIASES: Record<string, string> = {
  shift: 'Shift',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
};
const NAMED_KEYS: Record<string, true> = {
  Enter: true,
  Tab: true,
  Escape: true,
  Backspace: true,
  Delete: true,
  Insert: true,
  Home: true,
  End: true,
  PageUp: true,
  PageDown: true,
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  Space: true,
  F1: true,
  F2: true,
  F3: true,
  F4: true,
  F5: true,
  F6: true,
  F7: true,
  F8: true,
  F9: true,
  F10: true,
  F11: true,
  F12: true,
};

const ACTION_SPEC = `Allowed action objects (return exactly one):
- {"type":"click","x":N,"y":N}
- {"type":"move","x":N,"y":N}
- {"type":"drag","x":N,"y":N,"toX":N,"toY":N}
- {"type":"scroll","dx":N,"dy":N}  // each -4000..4000, not both zero
- {"type":"key","key":"Tab"}  // one key or a modifier combo such as Shift+Tab
- {"type":"type","text":"..."}  // up to 500 printable characters into the focused field
- {"type":"wait","ms":N}  // 1..10000 milliseconds
- {"type":"observe"}
- {"type":"crop","x":N,"y":N,"width":N,"height":N,"scale":N}  // zoom an existing observation; scale 1..4 and the resulting image must be at most 1280x800
- {"type":"report","title":"...","detail":"...","severity":"info|minor|major|critical"}
- {"type":"finish","summary":"..."}`;

export interface ModelHealth {
  ok: boolean;
  detail: string;
  model?: string;
  endpoint?: string;
}

export interface DecisionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface DecisionMeta {
  /** Model ID reported by the provider, or the configured ID when omitted. */
  model: string;
  requestedModel: string;
  elapsedMs: number;
  usage?: DecisionUsage;
  status: number;
  responseId?: string;
}

export interface DecisionResult extends ModelDecision {
  meta: DecisionMeta;
}

export interface DecideOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Observation-to-viewport mapping; used only to label magnified crop prompts. */
  view?: { originX: number; originY: number; scale: number };
}

export interface ViewBox {
  width: number;
  height: number;
}

export class ModelError extends Error {
  constructor(
    message: string,
    public readonly stage: 'config' | 'request' | 'response' | 'schema',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

interface ModelEnv {
  baseUrl: string;
  chatUrl: string;
  modelsUrl: string;
  model: string;
  apiKey: string;
  loopback: boolean;
}

interface LimitedText {
  text: string;
  truncated: boolean;
}

const PREFLIGHT_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

let healthCache: { key: string; at: number; result: ModelHealth } | undefined;
let healthInFlight: { key: string; promise: Promise<ModelHealth> } | undefined;

function setupHint(): string {
  return 'Set MODEL_BASE_URL (OpenAI-compatible base URL, including /v1 when required), MODEL_ID and MODEL_API_KEY (required for non-loopback endpoints), then restart Sightline.';
}

function configError(message: string): ModelError {
  return new ModelError(`${message} ${setupHint()}`, 'config');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

function readEnv(): ModelEnv {
  const rawBase = process.env.MODEL_BASE_URL?.trim();
  if (!rawBase) throw configError('MODEL_BASE_URL is not set.');
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw configError('MODEL_BASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw configError('MODEL_BASE_URL must use http or https.');
  if (parsed.username || parsed.password)
    throw configError('MODEL_BASE_URL must not contain embedded credentials.');
  if (parsed.search || parsed.hash)
    throw configError('MODEL_BASE_URL must not contain a query string or fragment.');

  const model = process.env.MODEL_ID?.trim();
  if (!model) throw configError('MODEL_ID is not set.');
  if (model.length > 200 || /\p{Cc}/u.test(model))
    throw configError('MODEL_ID must be a short model identifier without control characters.');

  const apiKey = process.env.MODEL_API_KEY?.trim() ?? '';
  const loopback = isLoopbackHost(parsed.hostname);
  if (!apiKey && !loopback)
    throw configError('MODEL_API_KEY is not set for a non-loopback model endpoint.');

  const baseUrl = rawBase.replace(/\/+$/, '');
  let chatUrl: string;
  let modelsUrl: string;
  const chatSuffix = /\/chat\/completions$/i;
  if (chatSuffix.test(baseUrl)) {
    chatUrl = baseUrl;
    modelsUrl = baseUrl.replace(chatSuffix, '/models');
  } else {
    chatUrl = `${baseUrl}/chat/completions`;
    modelsUrl = `${baseUrl}/models`;
  }

  return { baseUrl, chatUrl, modelsUrl, model, apiKey, loopback };
}

function envFingerprint(env: ModelEnv): string {
  return `${env.chatUrl}\u0000${env.model}\u0000${env.apiKey ? hashString(env.apiKey) : 'no-key'}`;
}

function authHeaders(env: ModelEnv): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (env.apiKey) headers.Authorization = `Bearer ${env.apiKey}`;
  return headers;
}

function redact(value: string, env?: ModelEnv): string {
  let text = value;
  const key = env?.apiKey || process.env.MODEL_API_KEY?.trim();
  if (key && key.length >= 4) text = text.split(key).join('[redacted]');
  return text;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return redact(error.message);
  return redact(String(error));
}

function oneLine(value: string, limit: number): string {
  const collapsed = value.replaceAll(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, Math.max(0, limit - 1))}…` : collapsed;
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function usageFrom(value: unknown): DecisionUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: DecisionUsage = {};
  const prompt = numericField(value.prompt_tokens ?? value.promptTokens);
  const completion = numericField(value.completion_tokens ?? value.completionTokens);
  const total = numericField(value.total_tokens ?? value.totalTokens);
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** True for PNG bytes (signature check only). */
export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/** True for JPEG bytes (signature check only). */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Reads PNG IHDR dimensions and bounds them to a sane screenshot size. */
export function pngDimensions(bytes: Uint8Array): ViewBox {
  if (!isPng(bytes) || bytes.length < 24)
    throw new ModelError('Observation image is not a valid PNG.', 'schema');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096
  ) {
    throw new ModelError(`Observation PNG has invalid dimensions ${width}x${height}.`, 'schema');
  }
  return { width, height };
}

function schemaFailure(message: string): never {
  throw new ModelError(message, 'schema');
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      schemaFailure(`${label} has unexpected field "${oneLine(key, 40)}".`);
  }
}

function numberField(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer = false,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    schemaFailure(`${label} must be a finite number.`);
  if (value < min || value > max) schemaFailure(`${label} must be between ${min} and ${max}.`);
  if (integer && !Number.isInteger(value)) schemaFailure(`${label} must be an integer.`);
  return value;
}

function stringField(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') schemaFailure(`${label} must be a string.`);
  if (value.length < min || value.length > max)
    schemaFailure(`${label} must contain ${min}–${max} characters.`);
  return value;
}

function coordinateField(value: unknown, label: string, limit: number): number {
  const coordinate = numberField(value, label, 0, limit);
  if (coordinate >= limit) schemaFailure(`${label} must be less than ${limit}.`);
  return coordinate;
}

function keyName(value: string): string {
  if (value.length === 1) return value;
  for (const key of Object.keys(NAMED_KEYS)) {
    if (key.toLowerCase() === value.toLowerCase()) return key;
  }
  return value;
}

/** Validates and canonicalizes a single key or modifier combo for Playwright. */
export function normalizeKeyCombo(input: string): string {
  const value = input.trim();
  if (value.length < 1 || value.length > 40) schemaFailure('key must contain 1–40 characters.');
  const parts = value.split('+');
  if (parts.length < 1 || parts.length > 3)
    schemaFailure('key may contain at most two modifiers and one key.');
  const modifiers: string[] = [];
  let base: string | undefined;
  for (const [index, part] of parts.entries()) {
    if (!part) schemaFailure('key contains an empty segment.');
    if (index < parts.length - 1) {
      const candidate = MODIFIER_ALIASES[part.toLowerCase()];
      if (!candidate)
        schemaFailure(`"${oneLine(part, 20)}" is not a modifier (Shift, Control, Alt, Meta).`);
      if (modifiers.includes(candidate)) schemaFailure(`Duplicate modifier "${candidate}".`);
      modifiers.push(candidate);
    } else {
      base = part;
    }
  }
  if (!base) schemaFailure('key is empty.');
  const canonicalBase = keyName(base);
  if (MODIFIERS[canonicalBase]) schemaFailure('A modifier cannot be the final key.');
  const printable =
    canonicalBase.length === 1 && /^[\x20-\x7e]$/.test(canonicalBase) && canonicalBase !== '+';
  if (!printable && !NAMED_KEYS[canonicalBase]) {
    schemaFailure(`Unsupported key "${oneLine(canonicalBase, 30)}".`);
  }
  return [...modifiers, canonicalBase].join('+');
}

/** True when the action is rejected by the keyboard-only profile. */
export function isPointerAction(action: Action): boolean {
  return (
    action.type === 'click' ||
    action.type === 'move' ||
    action.type === 'drag' ||
    action.type === 'scroll'
  );
}

/**
 * Strict runtime validation for one model action. Coordinates are pixels of the
 * current observation (full viewport or a previously requested crop).
 */
export function validateAction(value: unknown, options: { view?: ViewBox } = {}): Action {
  if (!isRecord(value)) schemaFailure('action must be a JSON object.');
  const view = options.view ?? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
  if (
    !Number.isInteger(view.width) ||
    !Number.isInteger(view.height) ||
    view.width < 1 ||
    view.height < 1 ||
    view.width > 4096 ||
    view.height > 4096
  ) {
    schemaFailure('Observation view has invalid dimensions.');
  }
  const type = value.type;
  if (typeof type !== 'string') schemaFailure('action.type must be a string.');

  switch (type) {
    case 'click':
    case 'move': {
      assertOnlyKeys(value, ['type', 'x', 'y'], type);
      return {
        type,
        x: coordinateField(value.x, `${type}.x`, view.width),
        y: coordinateField(value.y, `${type}.y`, view.height),
      };
    }
    case 'drag': {
      assertOnlyKeys(value, ['type', 'x', 'y', 'toX', 'toY'], 'drag');
      return {
        type,
        x: coordinateField(value.x, 'drag.x', view.width),
        y: coordinateField(value.y, 'drag.y', view.height),
        toX: coordinateField(value.toX, 'drag.toX', view.width),
        toY: coordinateField(value.toY, 'drag.toY', view.height),
      };
    }
    case 'scroll': {
      assertOnlyKeys(value, ['type', 'dx', 'dy'], 'scroll');
      const dx = numberField(value.dx, 'scroll.dx', -4000, 4000);
      const dy = numberField(value.dy, 'scroll.dy', -4000, 4000);
      if (dx === 0 && dy === 0) schemaFailure('scroll dx and dy cannot both be zero.');
      return { type, dx, dy };
    }
    case 'key': {
      assertOnlyKeys(value, ['type', 'key'], 'key');
      return { type, key: normalizeKeyCombo(stringField(value.key, 'key.key', 1, 40)) };
    }
    case 'type': {
      assertOnlyKeys(value, ['type', 'text'], 'type');
      const text = stringField(value.text, 'type.text', 1, MAX_ACTION_TEXT);
      for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if ((code < 0x20 && char !== '\n' && char !== '\t') || code === 0x7f) {
          schemaFailure('type.text contains a control character.');
        }
      }
      return { type, text };
    }
    case 'wait': {
      assertOnlyKeys(value, ['type', 'ms'], 'wait');
      return { type, ms: numberField(value.ms, 'wait.ms', 1, 10_000, true) };
    }
    case 'observe': {
      assertOnlyKeys(value, ['type'], 'observe');
      return { type };
    }
    case 'crop': {
      assertOnlyKeys(value, ['type', 'x', 'y', 'width', 'height', 'scale'], 'crop');
      const x = numberField(value.x, 'crop.x', 0, view.width - 1, true);
      const y = numberField(value.y, 'crop.y', 0, view.height - 1, true);
      const width = numberField(value.width, 'crop.width', 1, view.width, true);
      const height = numberField(value.height, 'crop.height', 1, view.height, true);
      const scale = numberField(value.scale, 'crop.scale', 1, 4);
      if (x + width > view.width || y + height > view.height) {
        schemaFailure('crop rectangle must lie inside the current observation.');
      }
      const outWidth = Math.round(width * scale);
      const outHeight = Math.round(height * scale);
      if (
        outWidth < 1 ||
        outHeight < 1 ||
        outWidth > VIEWPORT_WIDTH ||
        outHeight > VIEWPORT_HEIGHT
      ) {
        schemaFailure(
          `crop output would be ${outWidth}x${outHeight}; the maximum is ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}. Crop a smaller region or use a smaller scale.`,
        );
      }
      return { type, x, y, width, height, scale };
    }
    case 'report': {
      assertOnlyKeys(value, ['type', 'title', 'detail', 'severity'], 'report');
      const title = stringField(value.title, 'report.title', 1, 200).trim();
      const detail = stringField(value.detail, 'report.detail', 1, 2000).trim();
      const severity = value.severity;
      if (typeof severity !== 'string' || !SEVERITIES.includes(severity as Finding['severity'])) {
        schemaFailure(`report.severity must be one of ${SEVERITIES.join(', ')}.`);
      }
      if (!title || !detail) schemaFailure('report.title and report.detail cannot be blank.');
      return { type, title, detail, severity: severity as Finding['severity'] };
    }
    case 'finish': {
      assertOnlyKeys(value, ['type', 'summary'], 'finish');
      const summary = stringField(value.summary, 'finish.summary', 1, 1000).trim();
      if (!summary) schemaFailure('finish.summary cannot be blank.');
      return { type, summary };
    }
    default:
      schemaFailure(`Unsupported action type "${oneLine(type, 40)}".`);
  }
}

/** Strict validation for the complete ModelDecision envelope. */
export function validateDecision(value: unknown, options: { view?: ViewBox } = {}): ModelDecision {
  if (!isRecord(value)) schemaFailure('decision must be a JSON object.');
  assertOnlyKeys(value, ['action', 'reasoning'], 'decision');
  const reasoningRaw = value.reasoning;
  if (typeof reasoningRaw !== 'string') schemaFailure('decision.reasoning must be a string.');
  if (reasoningRaw.length > MAX_REASONING_CHARS)
    schemaFailure(`decision.reasoning must be at most ${MAX_REASONING_CHARS} characters.`);
  return {
    action: validateAction(value.action, options),
    reasoning: reasoningRaw.trim(),
  };
}

function validateDecideConfig(config: AgentConfig): void {
  if (!config || typeof config !== 'object')
    throw new ModelError('Agent configuration is missing.', 'config');
  if (
    typeof config.task !== 'string' ||
    !config.task.trim() ||
    config.task.length > MAX_TASK_CHARS
  ) {
    throw new ModelError(`Agent task must contain 1–${MAX_TASK_CHARS} characters.`, 'config');
  }
  if (!isProfile(config.profile))
    throw new ModelError(`Unknown profile "${oneLine(String(config.profile), 40)}".`, 'config');
  if (!SCENARIOS.includes(config.scenario))
    throw new ModelError(`Unknown scenario "${oneLine(String(config.scenario), 40)}".`, 'config');
  if (config.defect !== undefined && typeof config.defect !== 'boolean') {
    throw new ModelError('Agent defect flag must be a boolean when present.', 'config');
  }
}

function systemPrompt(
  config: AgentConfig,
  image: ViewBox,
  env: ModelEnv,
  cropped: boolean,
): string {
  const scenario =
    config.scenario === 'shop'
      ? 'controlled shop replica (search, product, variant, stock, cart, checkout)'
      : 'controlled campus portal replica (18 service tiles, search, schedule, panels)';
  return [
    'You are Sightline, an autonomous screenshot-only web-testing agent operated on a trusted local workstation.',
    `Task from the operator: ${redact(config.task, env)}`,
    `Scenario: ${scenario}.`,
    `Profile: ${config.profile}. Profile rules: ${PROFILE_DEFINITIONS[config.profile].guidance}`,
    'There is no fixed decision budget. Continue observing and acting until the task is visibly complete, you choose finish, or the operator stops the run.',
    `Current screenshot: ${image.width}x${image.height} pixels, origin at the top-left.`,
    cropped
      ? 'This image is a magnified crop of the viewport. Give coordinates in this crop image; they are mapped back to the viewport automatically for pointer actions.'
      : 'Give pointer coordinates in this image.',
    ACTION_SPEC,
    'Hard constraints:',
    '- Base every decision only on the visible screenshot and the bounded history/messages provided.',
    '- You have no DOM, HTML, source, selector, accessibility-tree, JavaScript, network, file or URL tools. Never try to open a URL, address bar, local file or another application.',
    '- You may only interact with the controlled replica page through the listed physical input actions. Other requests are blocked.',
    '- Do not invent findings. Use report for a concrete observed problem and finish only after the screenshots show the task is complete.',
    '- A finish summary is a model claim, not proof; it is checked against evidence later.',
    '- Keep reasoning brief. Return exactly one JSON object and nothing else, with no markdown fences: {"action":{...},"reasoning":"..."}',
  ].join('\n');
}

const HISTORY_KINDS: Record<string, true> = {
  action: true,
  observation: true,
  error: true,
  finding: true,
  claim: true,
  world: true,
};
const SAFE_ERROR_CATEGORIES: Record<string, true> = {
  model: true,
  profile: true,
  security: true,
  browser: true,
};

/**
 * Converts only worker-generated, agent-visible evidence into prompt text.
 * event.data is never serialized; world/observation text is replaced with a
 * fixed phrase so backend transitions or evaluator metadata cannot leak in.
 */
export function historyTextForModel(events: EvidenceEvent[]): string {
  const lines: string[] = [];
  let chars = 0;
  for (const event of events.slice(-MAX_HISTORY_EVENTS).reverse()) {
    if (!HISTORY_KINDS[event.kind]) continue;
    let text: string;
    switch (event.kind) {
      case 'action':
      case 'finding':
      case 'claim':
        text = oneLine(event.text, 260);
        break;
      case 'observation':
        text = 'Observation captured (the current screenshot is authoritative).';
        break;
      case 'world':
        text = 'World state changed; inspect the current screenshot.';
        break;
      case 'error': {
        const category =
          isRecord(event.data) && typeof event.data.category === 'string'
            ? event.data.category
            : '';
        if (!SAFE_ERROR_CATEGORIES[category]) continue;
        text = oneLine(event.text, 260);
        break;
      }
      default:
        text = 'Event recorded.';
    }
    const line = `#${event.seq} ${event.kind}: ${text}`;
    if (chars + line.length > MAX_HISTORY_CHARS) break;
    lines.unshift(line);
    chars += line.length + 1;
  }
  return lines.length > 0 ? lines.join('\n') : 'No previous actions.';
}

export function formatDeliveredMessages(messages: string[]): string {
  const lines: string[] = [];
  let chars = 0;
  for (const message of messages.slice(-MAX_DELIVERED_MESSAGES).reverse()) {
    const line = `- ${oneLine(message, 500)}`;
    if (chars + line.length > MAX_DELIVERED_CHARS) break;
    lines.unshift(line);
    chars += line.length + 1;
  }
  return lines.length > 0 ? lines.join('\n') : 'None.';
}

function userPrompt(history: EvidenceEvent[], messages: string[], image: ViewBox): string {
  return [
    'Operator messages delivered at this action boundary:',
    formatDeliveredMessages(messages),
    '',
    'Recent bounded event history:',
    historyTextForModel(history),
    '',
    `Current screenshot is ${image.width}x${image.height}. Choose the single next action. Return JSON only.`,
  ].join('\n');
}

function extractContent(message: Record<string, unknown>): { content: string; refusal?: string } {
  const content = message.content;
  if (typeof content === 'string') return { content };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if ((part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string')
        parts.push(part.text);
    }
    return { content: parts.join('\n') };
  }
  if (typeof message.refusal === 'string') return { content: '', refusal: message.refusal };
  return { content: '' };
}

function extractDecisionJson(content: string): unknown {
  const trimmed = content.trim();
  const candidates: string[] = [];
  if (trimmed) candidates.push(trimmed);
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = match[1]?.trim();
    if (fenced) candidates.push(fenced);
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate, then fail explicitly below.
    }
  }
  throw new ModelError(
    `Model did not return parseable decision JSON. Response excerpt: ${oneLine(redact(trimmed), 240) || '(empty)'}`,
    'schema',
  );
}

async function readLimited(response: Response, limit: number): Promise<LimitedText> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = limit - total;
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined);
        return { text: new TextDecoder().decode(concatenate(chunks)), truncated: true };
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        await reader.cancel().catch(() => undefined);
        return { text: new TextDecoder().decode(concatenate(chunks)), truncated: true };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: new TextDecoder().decode(concatenate(chunks)), truncated: false };
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function abortScope(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    },
  };
}

async function modelRequest(
  env: ModelEnv,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ data: unknown; text: LimitedText; status: number }> {
  const scope = abortScope(signal, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(env.chatUrl, {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify(body),
        signal: scope.signal,
      });
    } catch (error) {
      if (signal?.aborted)
        throw new ModelError('Model request was aborted by the worker.', 'request');
      if (scope.signal.aborted)
        throw new ModelError(`Model request timed out after ${timeoutMs} ms.`, 'request');
      throw new ModelError(`Model request failed: ${errorMessage(error)}`, 'request');
    }
    let text: LimitedText;
    try {
      text = await readLimited(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (signal?.aborted)
        throw new ModelError('Model response body was aborted by the worker.', 'request');
      if (scope.signal.aborted)
        throw new ModelError(
          `Model response body read timed out after ${timeoutMs} ms.`,
          'request',
        );
      throw new ModelError(
        `Model response body read failed: ${errorMessage(error)}`,
        'response',
        response.status,
      );
    }
    if (!response.ok) {
      const excerpt = oneLine(redact(text.text, env), MAX_ERROR_SNIPPET);
      throw new ModelError(
        `Model endpoint returned HTTP ${response.status}${response.statusText ? ` ${oneLine(response.statusText, 80)}` : ''}${excerpt ? `: ${excerpt}` : ''}`,
        'response',
        response.status,
      );
    }
    if (text.truncated)
      throw new ModelError(
        `Model response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
        'response',
        response.status,
      );
    let data: unknown;
    try {
      data = JSON.parse(text.text);
    } catch {
      throw new ModelError(
        `Model endpoint returned malformed JSON: ${oneLine(redact(text.text, env), MAX_ERROR_SNIPPET)}`,
        'response',
        response.status,
      );
    }
    if (isRecord(data) && data.error) {
      const providerError = isRecord(data.error)
        ? typeof data.error.message === 'string'
          ? data.error.message
          : (JSON.stringify(data.error) ?? 'unknown error')
        : typeof data.error === 'string'
          ? data.error
          : (JSON.stringify(data.error) ?? 'unknown error');
      throw new ModelError(
        `Model endpoint error: ${oneLine(redact(providerError, env), MAX_ERROR_SNIPPET)}`,
        'response',
        response.status,
      );
    }
    return { data, text, status: response.status };
  } finally {
    scope.cleanup();
  }
}

/**
 * Sends the current observation and bounded context to an OpenAI-compatible
 * /chat/completions endpoint. Invalid responses and actions throw ModelError;
 * this function never guesses or repairs a malformed decision.
 */
export async function decide(
  image: Uint8Array,
  config: AgentConfig,
  history: EvidenceEvent[],
  messages: string[],
  options: DecideOptions = {},
): Promise<DecisionResult> {
  const started = performance.now();
  validateDecideConfig(config);
  if (!(image instanceof Uint8Array))
    throw new ModelError('Observation must be PNG bytes.', 'config');
  if (image.byteLength < 24 || image.byteLength > MAX_IMAGE_BYTES) {
    throw new ModelError(
      `Observation PNG must be between 24 bytes and ${MAX_IMAGE_BYTES} bytes.`,
      'config',
    );
  }
  if (!isPng(image)) throw new ModelError('Observation must be a PNG image.', 'config');
  const view = pngDimensions(image);
  if (!Array.isArray(history)) throw new ModelError('Model history must be an array.', 'config');
  if (!Array.isArray(messages))
    throw new ModelError('Delivered messages must be an array.', 'config');

  const env = readEnv();
  const cropped = options.view
    ? options.view.originX !== 0 || options.view.originY !== 0 || options.view.scale !== 1
    : view.width !== VIEWPORT_WIDTH || view.height !== VIEWPORT_HEIGHT;
  const body = {
    model: env.model,
    temperature: 0,
    max_tokens: MAX_ARTIFACT_MODEL_OUTPUT,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt(config, view, env, cropped) },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: redact(
              userPrompt(
                history,
                messages.filter((message): message is string => typeof message === 'string'),
                view,
              ),
              env,
            ),
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${Buffer.from(image).toString('base64')}` },
          },
        ],
      },
    ],
  };

  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS, 5_000),
    180_000,
  );
  const { data, status } = await modelRequest(env, body, timeoutMs, options.signal);
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new ModelError('Model response did not contain choices[0].', 'response', status);
  }
  const choice: unknown = data.choices[0];
  if (!isRecord(choice))
    throw new ModelError('Model choice was not an object.', 'response', status);
  const message = choice.message;
  if (!isRecord(message))
    throw new ModelError('Model choice did not contain a message object.', 'response', status);
  const extracted = extractContent(message);
  if (extracted.refusal && !extracted.content.trim()) {
    throw new ModelError(
      `Model refused the decision request: ${oneLine(redact(extracted.refusal), 400)}`,
      'response',
      status,
    );
  }
  if (!extracted.content.trim()) {
    const finish =
      typeof choice.finish_reason === 'string'
        ? ` (finish_reason: ${oneLine(choice.finish_reason, 40)})`
        : '';
    throw new ModelError(`Model returned empty content${finish}.`, 'response', status);
  }

  let parsed: unknown;
  try {
    parsed = extractDecisionJson(extracted.content);
  } catch (error) {
    const finish =
      typeof choice.finish_reason === 'string'
        ? ` (finish_reason: ${oneLine(choice.finish_reason, 40)})`
        : '';
    if (error instanceof ModelError)
      throw new ModelError(`${error.message}${finish}`, 'schema', status);
    throw error;
  }
  let decision: ModelDecision;
  try {
    decision = validateDecision(parsed, { view });
  } catch (error) {
    const messageText = error instanceof Error ? redact(error.message) : 'invalid decision';
    throw new ModelError(
      `Model returned an invalid action decision: ${messageText}. Response excerpt: ${oneLine(redact(extracted.content), 240)}`,
      'schema',
      status,
    );
  }

  const responseModel =
    isRecord(data) && typeof data.model === 'string' && data.model.length <= 200
      ? data.model
      : env.model;
  const responseId =
    isRecord(data) && typeof data.id === 'string' && data.id.length <= 200 ? data.id : undefined;
  const meta: DecisionMeta = {
    model: responseModel,
    requestedModel: env.model,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    status,
  };
  const usage = isRecord(data) ? usageFrom(data.usage) : undefined;
  if (usage) meta.usage = usage;
  if (responseId) meta.responseId = responseId;
  return { action: decision.action, reasoning: decision.reasoning, meta };
}

function modelIdsFrom(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') ids.push(item);
      else if (isRecord(item) && typeof item.id === 'string') ids.push(item.id);
      else if (isRecord(item) && typeof item.name === 'string') ids.push(item.name);
    }
    return ids;
  }
  if (isRecord(value)) {
    if (Array.isArray(value.data)) return modelIdsFrom(value.data);
    if (Array.isArray(value.models)) return modelIdsFrom(value.models);
  }
  return undefined;
}

async function checkModelList(env: ModelEnv): Promise<{ fatal?: string; note: string }> {
  const scope = abortScope(undefined, 12_000);
  try {
    let response: Response;
    try {
      response = await fetch(env.modelsUrl, {
        method: 'GET',
        headers: authHeaders(env),
        signal: scope.signal,
      });
    } catch (error) {
      if (scope.signal.aborted)
        return {
          fatal: `Model endpoint did not answer the model-list preflight within 12000 ms.`,
          note: '',
        };
      return {
        fatal: `Cannot reach the model endpoint for preflight: ${errorMessage(error)}`,
        note: '',
      };
    }
    let text: LimitedText;
    try {
      text = await readLimited(response, 512 * 1024);
    } catch (error) {
      if (scope.signal.aborted)
        return {
          fatal: 'Model endpoint did not answer the model-list body within 12000 ms.',
          note: '',
        };
      return {
        fatal: `Could not read the model-list response: ${errorMessage(error)}`,
        note: '',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        fatal: `Model endpoint rejected credentials while checking the exact model (HTTP ${response.status}). Check MODEL_API_KEY.`,
        note: '',
      };
    }
    if (!response.ok) {
      return {
        note: `model-list endpoint returned HTTP ${response.status}; exact-model listing could not be verified, so the image/action probe is authoritative`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      return {
        note: 'model-list endpoint did not return JSON; exact-model listing could not be verified',
      };
    }
    const ids = modelIdsFrom(parsed);
    if (!ids)
      return {
        note: 'model-list response shape was not recognized; exact-model listing could not be verified',
      };
    if (ids.length === 0)
      return { note: 'model-list was empty; the image/action probe is authoritative' };
    if (!ids.includes(env.model)) {
      return {
        fatal: `Configured MODEL_ID "${env.model}" is not present in the endpoint model list (${ids.length} model${ids.length === 1 ? '' : 's'} reported).`,
        note: '',
      };
    }
    return { note: 'exact model found in the endpoint model list' };
  } finally {
    scope.cleanup();
  }
}

async function probeHealth(env: ModelEnv): Promise<ModelHealth> {
  const started = performance.now();
  let list: { fatal?: string; note: string };
  try {
    list = await checkModelList(env);
  } catch (error) {
    return {
      ok: false,
      detail: `Model endpoint preflight failed while checking the model list: ${errorMessage(error)}`,
      model: env.model,
      endpoint: env.chatUrl,
    };
  }
  if (list.fatal) return { ok: false, detail: list.fatal, model: env.model, endpoint: env.chatUrl };

  const preflight: AgentConfig = {
    id: 'model-preflight',
    name: 'Model preflight',
    profile: 'baseline',
    scenario: 'shop',
    task: 'Preflight only. The attached image is the screenshot. Reply with exactly one decision JSON object using the observe action.',
    verify: false,
  };
  try {
    const result = await decide(PREFLIGHT_PNG, preflight, [], [], {
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    const elapsed = Math.max(1, Math.round(performance.now() - started));
    return {
      ok: true,
      detail: `Image-format and action-schema preflight passed for MODEL_ID "${env.model}" in ${elapsed} ms (${list.note}; response model: ${result.meta.model}). This probe only verifies endpoint acceptance of image input and the decision JSON schema; it does not evaluate model quality, coordinate accuracy, or hidden-fixture behavior.`,
      model: env.model,
      endpoint: env.chatUrl,
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      ok: false,
      detail: `Model image-format/action-schema preflight failed: ${message}`,
      model: env.model,
      endpoint: env.chatUrl,
    };
  }
}

/**
 * Cached endpoint preflight. Checks environment configuration, exact model
 * availability when the endpoint exposes /models, and performs one tiny real
 * image + action-schema completion with the supplied credentials.
 */
export async function modelHealth(options: { force?: boolean } = {}): Promise<ModelHealth> {
  let env: ModelEnv;
  try {
    env = readEnv();
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
  const key = envFingerprint(env);
  const now = Date.now();
  if (!options.force && healthCache && healthCache.key === key) {
    const ttl = healthCache.result.ok ? HEALTH_SUCCESS_TTL_MS : HEALTH_FAILURE_TTL_MS;
    if (now - healthCache.at < ttl) return healthCache.result;
  }
  if (healthInFlight && healthInFlight.key === key) return healthInFlight.promise;

  const promise = probeHealth(env);
  healthInFlight = { key, promise };
  try {
    const result = await promise;
    healthCache = { key, at: Date.now(), result };
    return result;
  } finally {
    if (healthInFlight?.promise === promise) healthInFlight = undefined;
  }
}
