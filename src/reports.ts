import { zipSync } from 'fflate';
import type { AgentRun, EvidenceEvent, Finding, ReportSnapshot, World } from './contracts';

/**
 * Report exports are built from an immutable frozen snapshot. The HTML is a
 * single standalone file: inline CSS, inline vanilla JS, data: image URIs and
 * a restrictive CSP, so it opens through file:// with networking disabled.
 *
 * Assets for reportHtml() are keyed by artifact URL and may be either a data:
 * image URI or raw base64. Assets for reportZip() are keyed by artifact URL and
 * contain the original bytes.
 */

const encoder = new TextEncoder();

const textBytes = (value: string): Uint8Array => encoder.encode(value);

type TextAssets = Record<string, string>;
type ByteAssets = Record<string, Uint8Array>;

interface ReportFrame {
  ref: string;
  dataUri: string;
  label: string;
}

interface FrameCollection {
  frames: ReportFrame[];
  byRef: Map<string, number>;
  missing: Set<string>;
}

interface ModelInfo {
  model?: string;
  requested?: string;
  elapsedMs?: number;
  usage?: string;
  endpoint?: string;
}

interface ErrorSummary {
  infrastructure: string[];
  execution: string[];
}

interface ClaimInfo {
  text: string;
  event?: EvidenceEvent;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function createSnapshot(run: AgentRun, world: World): ReportSnapshot {
  const terminal =
    run.status === 'completed' || run.status === 'failed' || run.status === 'stopped';
  if (!terminal) {
    throw new Error(`Report snapshots require a terminal run; status is ${run.status}.`);
  }
  const snapshot = structuredClone({
    version: 1 as const,
    generatedAt: Date.now(),
    run,
    world,
  });
  return deepFreeze(snapshot);
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === undefined || value === null) return '';
  return prettyJson(value);
}

function esc(value: unknown): string {
  return asText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'invalid timestamp';
  return date.toISOString();
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'not recorded';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[unserializable event data]';
  }
}

function statusTone(status: string): string {
  switch (status) {
    case 'completed':
      return 'tone-ok';
    case 'failed':
      return 'tone-bad';
    case 'running':
      return 'tone-live';
    case 'paused':
      return 'tone-warn';
    default:
      return 'tone-neutral';
  }
}

function severityTone(severity: Finding['severity']): string {
  switch (severity) {
    case 'critical':
      return 'tone-bad';
    case 'major':
      return 'tone-warn';
    case 'minor':
      return 'tone-info';
    default:
      return 'tone-neutral';
  }
}

function kindTone(kind: string): string {
  const normalized = kind.toLowerCase();
  if (normalized.includes('error')) return 'tone-bad';
  if (normalized.includes('finding')) return 'tone-warn';
  if (normalized.includes('observation')) return 'tone-info';
  if (normalized.includes('message')) return 'tone-accent';
  if (normalized.includes('claim')) return 'tone-ok';
  return 'tone-neutral';
}

function safeBase(ref: string): string {
  const clean = ref.replace(/[?#].*$/, '');
  const base = clean
    .slice(clean.lastIndexOf('/') + 1)
    .replaceAll(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  if (base.length === 0 || base === '.' || base === '..') return 'artifact';
  return base.slice(0, 120);
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let counter = 2;
  while (used.has(name)) {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';
    name = `${stem}-${counter}${extension}`;
    counter += 1;
  }
  used.add(name);
  return name;
}

function isImageRef(ref: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i.test(ref);
}

function isTraceRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  return lower.endsWith('.zip') || lower.includes('trace');
}

function isVideoRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  return lower.endsWith('.webm') || lower.endsWith('.mp4');
}

function mimeFor(ref: string): string {
  const name = safeBase(ref).toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1) : '';
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

function toDataUri(ref: string, value: string): string | null {
  const trimmed = value.trim();
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) {
    return trimmed.replaceAll(/\s+/g, '');
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('http:') || trimmed.startsWith('https:'))
    return null;
  const base64 = trimmed.replaceAll(/\s+/g, '');
  if (base64.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(base64)) return null;
  return `data:${mimeFor(ref)};base64,${base64}`;
}

function lookupAsset<T>(assets: Record<string, T>, ref: string): T | undefined {
  if (Object.hasOwn(assets, ref)) return assets[ref];
  const name = safeBase(ref);
  for (const [key, value] of Object.entries(assets)) {
    if (safeBase(key) === name) return value;
  }
  return undefined;
}

function htmlAssetsFromBytes(assets: ByteAssets): TextAssets {
  const result: TextAssets = {};
  for (const [ref, bytes] of Object.entries(assets)) {
    result[ref] = isImageRef(ref)
      ? `data:${mimeFor(ref)};base64,${Buffer.from(bytes).toString('base64')}`
      : '';
  }
  return result;
}

function eventAnchor(event: EvidenceEvent, index: number): string {
  const safeId = event.id.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  return `evidence-${index}-${safeId.length > 0 ? safeId : 'event'}`;
}

function collectFrames(
  events: EvidenceEvent[],
  run: AgentRun,
  assets: TextAssets,
): FrameCollection {
  const frames: ReportFrame[] = [];
  const byRef = new Map<string, number>();
  const missing = new Set<string>();
  const processed = new Set<string>();

  for (const event of events) {
    const ref = event.artifact;
    if (!ref) continue;
    const supplied = lookupAsset(assets, ref);
    if (supplied === undefined) {
      missing.add(ref);
      continue;
    }
    if (!isImageRef(ref) || processed.has(ref)) continue;
    processed.add(ref);
    const dataUri = toDataUri(ref, supplied);
    if (!dataUri) {
      missing.add(ref);
      continue;
    }
    byRef.set(ref, frames.length);
    frames.push({
      ref,
      dataUri,
      label: `Frame ${frames.length + 1} · ${formatTime(event.at)} · ${event.kind} · event #${event.seq}`,
    });
  }

  if (run.latestFrame) {
    const ref = run.latestFrame;
    const supplied = lookupAsset(assets, ref);
    if (supplied === undefined) {
      missing.add(ref);
    } else if (frames.length === 0 && !processed.has(ref) && isImageRef(ref)) {
      processed.add(ref);
      const dataUri = toDataUri(ref, supplied);
      if (dataUri) {
        byRef.set(ref, frames.length);
        frames.push({
          ref,
          dataUri,
          label: `Latest frame · ${formatTime(run.updatedAt)}`,
        });
      } else {
        missing.add(ref);
      }
    }
  }

  return { frames, byRef, missing };
}

function findClaim(events: EvidenceEvent[]): ClaimInfo {
  const claims = events.filter((event) => event.kind === 'claim');
  const last = claims.at(-1);
  if (last) {
    const summary = stringField(last.data, 'summary');
    return { text: summary ?? last.text, event: last };
  }
  for (const event of events) {
    if (event.kind !== 'action') continue;
    const action = record(event.data?.action);
    if (action?.type !== 'finish') continue;
    const summary = action.summary;
    if (typeof summary === 'string' && summary.length > 0) return { text: summary, event };
  }
  return { text: '' };
}

function collectModelInfo(events: EvidenceEvent[]): ModelInfo {
  const info: ModelInfo = {};
  for (const event of events) {
    const model = stringField(event.data, 'model');
    if (model) info.model = model;
    const requested = stringField(event.data, 'requestedModel');
    if (requested) info.requested = requested;
    const elapsed = event.data?.elapsedMs;
    if (typeof elapsed === 'number' && Number.isFinite(elapsed)) info.elapsedMs = elapsed;
    if (event.data?.usage !== undefined) {
      const usage = compactJson(event.data.usage);
      if (usage) info.usage = usage;
    }
    const endpoint = stringField(event.data, 'endpoint');
    if (endpoint) info.endpoint = endpoint;
  }
  return info;
}

function collectErrors(events: EvidenceEvent[]): ErrorSummary {
  const infrastructure: string[] = [];
  const execution: string[] = [];
  const infrastructureCategories: Record<string, true> = {
    scenario: true,
    browser: true,
    artifact: true,
    backend: true,
    security: true,
  };
  for (const event of events) {
    if (event.kind !== 'error') continue;
    const category = stringField(event.data, 'category') ?? 'unknown';
    const line = `[${category}] ${event.text}`;
    if (infrastructureCategories[category]) infrastructure.push(line);
    else execution.push(line);
  }
  return { infrastructure, execution };
}

function verificationText(run: AgentRun): string {
  const notes = run.findings
    .map((finding) => finding.verification)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const parts: string[] = [];
  if (run.config.verificationOf) {
    parts.push(
      `Linked original run: ${run.config.verificationOf}. This is a verification run and never modifies the original frozen evidence.`,
    );
  }
  if (run.config.verify) {
    parts.push(
      'Verification was requested. Verification is a separate linked run and never modifies this frozen evidence.',
    );
  } else if (!run.config.verificationOf) {
    parts.push('Verification was not requested for this run.');
  }
  if (notes.length > 0) parts.push(`Finding verification notes: ${notes.join(' | ')}`);
  return parts.join(' ');
}

function observedText(world: World, events: EvidenceEvent[]): string {
  const base = world.completed
    ? 'Scenario world reports completed.'
    : 'Scenario world reports not completed.';
  const observation = events
    .filter(
      (event) => event.kind === 'observation' && stringField(event.data, 'observed') !== undefined,
    )
    .at(-1);
  if (!observation) return base;
  const observed = stringField(observation.data, 'observed');
  return observed ? `${base} Observation event: ${observed}.` : base;
}

function severityCounts(findings: Finding[]): string {
  const counts = { info: 0, minor: 0, major: 0, critical: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return `info ${counts.info}, minor ${counts.minor}, major ${counts.major}, critical ${counts.critical}`;
}

function renderMetadata(rows: Array<[string, string]>): string {
  const body = rows
    .map(([label, value]) => `<tr><th scope="row">${esc(label)}</th><td>${esc(value)}</td></tr>`)
    .join('');
  return `<table class="metadata"><tbody>${body}</tbody></table>`;
}

function renderFindings(findings: Finding[], anchors: Map<string, string>): string {
  if (findings.length === 0) return '<p class="empty">No findings were recorded.</p>';
  return findings
    .map((finding) => {
      const anchor = finding.observationId ? anchors.get(finding.observationId) : undefined;
      const evidence = anchor
        ? `<a href="#${esc(anchor)}">Evidence event</a>`
        : finding.observationId
          ? `Evidence event <code>${esc(finding.observationId)}</code> was not found in this snapshot.`
          : 'No observation was linked.';
      const verification =
        (finding.verification?.trim().length ?? 0) > 0
          ? esc(finding.verification)
          : 'No verification recorded.';
      return `<article class="finding ${severityTone(finding.severity)}">
      <div class="finding-head"><span class="badge ${severityTone(finding.severity)}">${esc(finding.severity)}</span><h3>${esc(finding.title)}</h3></div>
      <p>${esc(finding.detail)}</p>
      <p class="meta">Evidence: ${evidence} · Verification: ${verification} · Finding <code>${esc(finding.id)}</code></p>
    </article>`;
    })
    .join('');
}

function renderArtifact(ref: string, framesByRef: Map<string, number>): string {
  if (isTraceRef(ref)) {
    return `<p class="artifact">Trace artifact <code>${esc(ref)}</code>. Traces are sensitive and are not embedded in this HTML. When present in the ZIP bundle, open the copy with <code>bunx playwright show-trace trace/trace.zip</code>; the viewer needs its local HTTP server, not file://.</p>`;
  }
  if (isVideoRef(ref)) {
    return `<p class="artifact">Video artifact <code>${esc(ref)}</code> is not played in this standalone HTML. The original file is included in the ZIP evidence bundle when present.</p>`;
  }
  if (isImageRef(ref)) {
    const frameIndex = framesByRef.get(ref);
    if (frameIndex !== undefined) {
      return `<button type="button" class="frame-link no-print" data-frame-index="${frameIndex}">View observation frame ${frameIndex + 1}</button>`;
    }
    return `<p class="artifact missing">Image artifact referenced but not included in this export: <code>${esc(ref)}</code></p>`;
  }
  return `<p class="artifact">Artifact <code>${esc(ref)}</code> is not embedded in this HTML.</p>`;
}

function renderTimelineEvent(
  event: EvidenceEvent,
  anchor: string,
  framesByRef: Map<string, number>,
): string {
  const artifact = event.artifact ? renderArtifact(event.artifact, framesByRef) : '';
  const data =
    event.data === undefined ? '' : `<pre class="data">${esc(prettyJson(event.data))}</pre>`;
  return `<li class="event ${kindTone(event.kind)}" id="${esc(anchor)}">
    <div class="event-head"><span class="kind">${esc(event.kind)}</span><span class="seq">#${event.seq}</span><time datetime="${esc(formatTime(event.at))}">${esc(formatTime(event.at))}</time></div>
    <p class="event-text">${esc(event.text || '(no text)')}</p>
    ${artifact}
    ${data}
  </li>`;
}

function renderTimeline(
  events: EvidenceEvent[],
  anchors: Map<string, string>,
  framesByRef: Map<string, number>,
): string {
  if (events.length === 0) return '<p class="empty">No evidence events were recorded.</p>';
  return events
    .map((event) =>
      renderTimelineEvent(event, anchors.get(event.id) ?? `event-${event.seq}`, framesByRef),
    )
    .join('');
}

function renderGallery(frames: ReportFrame[]): string {
  if (frames.length === 0) {
    return `<section class="card" id="observations" aria-labelledby="observations-heading">
      <h2 id="observations-heading">Observation history</h2>
      <p class="empty">No observation images were included in this snapshot.</p>
    </section>`;
  }
  const options = frames
    .map((frame, index) => `<option value="${index}">${esc(frame.label)}</option>`)
    .join('');
  const figures = frames
    .map(
      (
        frame,
        index,
      ) => `<figure class="frame" data-frame="${index}"${index === frames.length - 1 ? '' : ' hidden'}>
    <img src="${esc(frame.dataUri)}" alt="${esc(frame.label)}">
    <figcaption>${esc(frame.label)}</figcaption>
  </figure>`,
    )
    .join('');
  return `<section class="card" id="observations" aria-labelledby="observations-heading">
    <h2 id="observations-heading">Observation history</h2>
    <p class="hint no-print">Select an observation frame. All images are inlined data URIs; no network request is made.</p>
    <div class="gallery-controls no-print">
      <label for="frame-select">Frame</label>
      <select id="frame-select">${options}</select>
      <button id="frame-prev" type="button">Previous</button>
      <button id="frame-next" type="button">Next</button>
      <span id="frame-caption" class="caption" role="status" aria-live="polite"></span>
    </div>
    <div class="frames">${figures}</div>
  </section>`;
}

function renderMissingAssets(missing: Set<string>): string {
  if (missing.size === 0) return '';
  const items = [...missing].map((ref) => `<li><code>${esc(ref)}</code></li>`).join('');
  return `<section class="card missing" aria-labelledby="missing-heading">
    <h2 id="missing-heading">Missing evidence assets</h2>
    <p>These artifacts are recorded by the snapshot but were not supplied to this export. They are listed explicitly instead of rendered as broken links. Technical assets such as traces and video are unavailable in the standalone HTML unless the bundle supplies them.</p>
    <ul>${items}</ul>
  </section>`;
}

function renderErrorList(errors: string[]): string {
  if (errors.length === 0) return '<p class="empty">None recorded.</p>';
  return `<ul class="error-list">${errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul>`;
}

function reportStyles(): string {
  return `<style>
:root {
  --ink: #182431;
  --muted: #5b6b7d;
  --line: #d6dfe8;
  --bg: #eef2f6;
  --card: #ffffff;
  --ok: #0b6e4f;
  --warn: #8a4b00;
  --bad: #a51d2d;
  --info: #235e8a;
  --accent: #5b3e96;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
.report-head {
  background: #102a43;
  color: #f4f7fa;
  padding: 22px 26px;
}
.report-head .inner { max-width: 1120px; margin: 0 auto; display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.eyebrow { margin: 0 0 4px; font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: #a9c3d8; }
h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: -.02em; }
.subtitle { margin: 6px 0 0; max-width: 720px; color: #cddae6; }
.actions { display: flex; gap: 8px; align-items: center; }
.print-button {
  min-height: 38px; padding: 7px 14px; border-radius: 8px; border: 1px solid #a9c3d8;
  background: transparent; color: #f4f7fa; font: inherit; font-weight: 700; cursor: pointer;
}
.print-button:hover { background: rgba(255, 255, 255, .1); }
main { max-width: 1120px; margin: 0 auto; padding: 20px 26px 46px; }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 18px; margin: 0 0 16px;
}
h2 { margin: 0 0 12px; font-size: 19px; }
h3 { margin: 0; font-size: 16px; }
.meta, .muted { color: var(--muted); }
.hint { margin: -4px 0 12px; color: var(--muted); font-size: 14px; }
.empty { color: var(--muted); font-style: italic; }
.grid-two { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.metadata { width: 100%; border-collapse: collapse; font-size: 14px; }
.metadata th, .metadata td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid #e7edf3; }
.metadata th { width: 42%; color: var(--muted); font-weight: 650; }
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase;
  border: 1px solid currentColor;
}
.status { display: inline-block; padding: 5px 12px; border-radius: 999px; border: 1px solid #a9c3d8; font-weight: 750; font-size: 13px; }
.tone-ok { color: var(--ok); }
.tone-warn { color: var(--warn); }
.tone-bad { color: var(--bad); }
.tone-info { color: var(--info); }
.tone-accent { color: var(--accent); }
.tone-live { color: #0b6e4f; }
.tone-neutral { color: var(--muted); }
.finding { border-left: 4px solid var(--line); padding: 10px 14px; margin: 0 0 12px; background: #fbfcfd; border-radius: 0 8px 8px 0; }
.finding.tone-bad { border-left-color: var(--bad); }
.finding.tone-warn { border-left-color: var(--warn); }
.finding.tone-info { border-left-color: var(--info); }
.finding.tone-neutral { border-left-color: var(--line); }
.finding-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 4px; flex-wrap: wrap; }
.finding p { margin: 4px 0; }
.gallery-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
select, button { font: inherit; }
select { min-height: 38px; padding: 6px 10px; border: 1px solid #b7c3d1; border-radius: 8px; background: #fff; color: var(--ink); }
.gallery-controls button, .frame-link {
  min-height: 38px; padding: 6px 12px; border-radius: 8px; border: 1px solid #b7c3d1;
  background: #fff; color: var(--ink); font-weight: 650; cursor: pointer;
}
.gallery-controls button:hover, .frame-link:hover { background: #eef3f8; }
.caption { color: var(--muted); font-size: 13px; }
.frames { display: grid; gap: 14px; }
.frame { margin: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: #fff; }
.frame img { display: block; width: 100%; height: auto; background: #fff; }
.frame figcaption { padding: 8px 10px; font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); }
.timeline { list-style: none; margin: 0; padding: 0; }
.event { border-left: 4px solid var(--line); padding: 10px 14px; margin: 0 0 12px; background: #fbfcfd; border-radius: 0 8px 8px 0; }
.event.tone-bad { border-left-color: var(--bad); }
.event.tone-warn { border-left-color: var(--warn); }
.event.tone-info { border-left-color: var(--info); }
.event.tone-accent { border-left-color: var(--accent); }
.event.tone-ok { border-left-color: var(--ok); }
.event-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.kind { font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--ink); }
.seq { font-variant-numeric: tabular-nums; }
.event-text { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.artifact { margin: 6px 0; font-size: 14px; }
.artifact.missing { color: var(--bad); font-weight: 650; }
.data {
  margin: 8px 0 0; padding: 10px; max-height: 300px; overflow: auto;
  background: #f1f5f9; border: 1px solid #e1e8ef; border-radius: 8px;
  font-size: 12px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: .92em; }
.error-list { margin: 6px 0 0; padding-left: 20px; }
.error-list li { margin: 4px 0; }
.missing { border-color: #e4a9b0; }
footer { color: var(--muted); font-size: 13px; margin-top: 8px; }
a { color: #0b5c8a; }
@media (max-width: 860px) {
  .grid-two { grid-template-columns: 1fr; }
  main { padding: 14px 14px 34px; }
  .report-head { padding: 18px 14px; }
}
@media print {
  @page { margin: 14mm; }
  body { background: #fff; color: #000; font-size: 11pt; }
  .report-head { background: #fff; color: #000; border-bottom: 2px solid #000; padding: 0 0 10px; }
  .report-head .inner { max-width: none; }
  .eyebrow, .subtitle { color: #333; }
  .no-print, .gallery-controls { display: none !important; }
  main { max-width: none; padding: 0; }
  .card { border: 1px solid #777; box-shadow: none; break-inside: avoid; }
  .finding, .event { break-inside: avoid; }
  .frame { break-inside: avoid; }
  .frame[hidden] { display: block !important; }
  .data { max-height: none; overflow: visible; border: 1px solid #999; }
  a { color: #000; text-decoration: underline; }
  .status, .badge { border: 1px solid #000; }
}
</style>`;
}

export function reportHtml(snapshot: ReportSnapshot, assets: Record<string, string>): string {
  const run = snapshot.run;
  const world = snapshot.world;
  const events = run.events.toSorted((left, right) => left.seq - right.seq || left.at - right.at);
  const anchors = new Map<string, string>();
  for (const [index, event] of events.entries()) anchors.set(event.id, eventAnchor(event, index));
  const collection = collectFrames(events, run, assets);
  const framesByRef = collection.byRef;
  const claim = findClaim(events);
  const model = collectModelInfo(events);
  const errors = collectErrors(events);
  const counts = severityCounts(run.findings);
  const runError = run.error?.trim() ?? '';

  const metadataRows: Array<[string, string]> = [
    ['Agent', run.config.name],
    ['Agent ID', run.config.id],
    ['Scenario', run.config.scenario],
    ['Profile', run.config.profile],
    ['Status', run.status],
    ['Requested command', run.requested],
    ['Step', String(run.step)],
    ['Verification requested', run.config.verify ? 'yes' : 'no'],
    ['Created', formatTime(run.createdAt)],
    ['Last updated', formatTime(run.updatedAt)],
    ['Snapshot generated', formatTime(snapshot.generatedAt)],
    ['Outcome', run.outcome || '(empty)'],
    ['World revision', String(world.revision)],
    ['World stock', String(world.stock)],
    ['World cart', String(world.cart)],
    ['World selected', world.selected || '(none)'],
    ['World completed', world.completed ? 'yes' : 'no'],
    ['World seeded defect (evaluator-only)', world.defect ? 'yes' : 'no'],
    ['Latest frame artifact', run.latestFrame ?? '(none)'],
  ];
  if (run.config.verificationOf)
    metadataRows.push(['Linked original run', run.config.verificationOf]);
  if (model.model) metadataRows.push(['Actual model', model.model]);
  if (model.requested) metadataRows.push(['Requested model', model.requested]);
  if (model.elapsedMs !== undefined)
    metadataRows.push(['Last model latency', formatDuration(model.elapsedMs)]);
  if (model.usage) metadataRows.push(['Token usage', model.usage]);
  if (model.endpoint) metadataRows.push(['Model endpoint', model.endpoint]);

  const summaryRows: Array<[string, string]> = [
    ['Model claim', claim.text || 'No model completion claim recorded.'],
    ['Observed outcome', observedText(world, events)],
    ['Findings', `${run.findings.length} recorded (${counts})`],
    [
      'Infrastructure failure',
      errors.infrastructure.length > 0 ? errors.infrastructure.join(' | ') : 'None recorded.',
    ],
    [
      'Execution / model error',
      runError.length > 0
        ? runError
        : errors.execution.length > 0
          ? errors.execution.join(' | ')
          : 'None recorded.',
    ],
    ['Verification', verificationText(run)],
  ];

  const errorSections =
    errors.infrastructure.length === 0 && errors.execution.length === 0
      ? ''
      : `<section class="card" aria-labelledby="errors-heading">
      <h2 id="errors-heading">Failure evidence</h2>
      <h3>Infrastructure-classified errors</h3>
      ${renderErrorList(errors.infrastructure)}
      <h3>Execution and model errors</h3>
      ${renderErrorList(errors.execution)}
    </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light">
<title>Sightline report — ${esc(run.config.name)}</title>
${reportStyles()}
</head>
<body>
<header class="report-head">
  <div class="inner">
    <div>
      <p class="eyebrow">Sightline evidence report</p>
      <h1>${esc(run.config.name)}</h1>
      <p class="subtitle">${esc(run.config.task)}</p>
      <p class="subtitle">${esc(run.config.scenario)} · ${esc(run.config.profile)} · run ${esc(run.config.id)}</p>
    </div>
    <div class="actions">
      <span class="status ${statusTone(run.status)}">${esc(run.status)}</span>
      <button id="print-button" class="print-button no-print" type="button">Print report</button>
    </div>
  </div>
</header>
<main>
  <div class="grid-two">
    <section class="card" aria-labelledby="metadata-heading">
      <h2 id="metadata-heading">Run metadata</h2>
      ${renderMetadata(metadataRows)}
    </section>
    <section class="card" aria-labelledby="summary-heading">
      <h2 id="summary-heading">Result summary</h2>
      ${renderMetadata(summaryRows)}
    </section>
  </div>
  <section class="card" aria-labelledby="findings-heading">
    <h2 id="findings-heading">Findings</h2>
    ${renderFindings(run.findings, anchors)}
  </section>
  ${renderGallery(collection.frames)}
  <section class="card" aria-labelledby="evidence-heading">
    <h2 id="evidence-heading">Ordered evidence</h2>
    <ol class="timeline">${renderTimeline(events, anchors, framesByRef)}</ol>
  </section>
  ${errorSections}
  ${renderMissingAssets(collection.missing)}
  <footer>
    Frozen ReportSnapshot version ${snapshot.version}. Generated ${esc(formatTime(snapshot.generatedAt))}.
    This standalone file makes no external requests; images are inline data URIs.
    Verification results, when requested, belong to a separate linked run and never alter this evidence.
  </footer>
</main>
<script>
(function () {
  'use strict';
  const printButton = document.getElementById('print-button');
  if (printButton) printButton.addEventListener('click', () => { window.print(); });
  const select = document.getElementById('frame-select');
  if (!select) return;
  const frames = Array.from(document.querySelectorAll('.frame'));
  if (frames.length === 0) return;
  const caption = document.getElementById('frame-caption');
  const previous = document.getElementById('frame-prev');
  const next = document.getElementById('frame-next');
  const showFrame = (index) => {
    const clamped = Math.max(0, Math.min(frames.length - 1, index));
    frames.forEach((frame, position) => { frame.hidden = position !== clamped; });
    select.value = String(clamped);
    const option = select.options[select.selectedIndex];
    if (caption) caption.textContent = option ? option.textContent : '';
  };
  select.addEventListener('change', () => { showFrame(Number(select.value)); });
  if (previous) previous.addEventListener('click', () => { showFrame(Number(select.value) - 1); });
  if (next) next.addEventListener('click', () => { showFrame(Number(select.value) + 1); });
  for (const button of document.querySelectorAll('.frame-link')) {
    button.addEventListener('click', () => {
      showFrame(Number(button.getAttribute('data-frame-index')));
      document.getElementById('observations')?.scrollIntoView({ block: 'start' });
    });
  }
  showFrame(frames.length - 1);
})();
</script>
</body>
</html>`;
}

function mdInline(value: unknown): string {
  return asText(value)
    .replaceAll(/\r?\n/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
}

function mdCell(value: unknown): string {
  return mdInline(value).replaceAll(/\|/g, '\\|');
}

function mdCode(value: string): string {
  const text = value
    .replaceAll(/\r?\n/g, ' ')
    .replaceAll('`', '\\`')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `\`${text}\``;
}

function urlPart(value: string): string {
  return encodeURIComponent(value).replaceAll(/\(/g, '%28').replaceAll(/\)/g, '%29');
}

function mdLink(label: string, url: string): string {
  return `[${mdInline(label)}](${url})`;
}

function mdMetadata(rows: Array<[string, string]>): string {
  const header = '| Field | Value |\n| --- | --- |';
  const body = rows.map(([label, value]) => `| ${mdCell(label)} | ${mdCell(value)} |`).join('\n');
  return `${header}\n${body}`;
}

function mdArtifact(ref: string): string {
  const target = `/artifacts/${urlPart(safeBase(ref))}`;
  if (isTraceRef(ref)) {
    return `- Trace artifact ${mdCode(ref)}: ${mdLink('hosted artifact', target)}. This trace is sensitive and requires \`bunx playwright show-trace trace/trace.zip\` from the bundle; the viewer needs its local HTTP server, not file://.`;
  }
  if (isVideoRef(ref)) {
    return `- Video artifact ${mdCode(ref)}: ${mdLink('hosted artifact', target)}. Video is not rendered in Markdown; the ZIP bundle carries the file.`;
  }
  return `- Artifact ${mdCode(ref)}: ${mdLink('hosted artifact', target)}.`;
}

export function reportMarkdown(snapshot: ReportSnapshot): string {
  const run = snapshot.run;
  const world = snapshot.world;
  const events = run.events.toSorted((left, right) => left.seq - right.seq || left.at - right.at);
  const anchors = new Map<string, string>();
  for (const [index, event] of events.entries()) anchors.set(event.id, eventAnchor(event, index));
  const claim = findClaim(events);
  const model = collectModelInfo(events);
  const errors = collectErrors(events);
  const counts = severityCounts(run.findings);
  const runError = run.error?.trim() ?? '';
  const reportPath = `/report/${urlPart(run.config.id)}`;

  const metadataRows: Array<[string, string]> = [
    ['Agent', run.config.name],
    ['Agent ID', run.config.id],
    ['Scenario', run.config.scenario],
    ['Profile', run.config.profile],
    ['Status', run.status],
    ['Requested command', run.requested],
    ['Step', String(run.step)],
    ['Verification requested', run.config.verify ? 'yes' : 'no'],
    ['Created', formatTime(run.createdAt)],
    ['Last updated', formatTime(run.updatedAt)],
    ['Snapshot generated', formatTime(snapshot.generatedAt)],
    ['Outcome', run.outcome || '(empty)'],
    ['World revision', String(world.revision)],
    ['World stock', String(world.stock)],
    ['World cart', String(world.cart)],
    ['World selected', world.selected || '(none)'],
    ['World completed', world.completed ? 'yes' : 'no'],
    ['World seeded defect (evaluator-only)', world.defect ? 'yes' : 'no'],
  ];
  if (run.config.verificationOf)
    metadataRows.push(['Linked original run', run.config.verificationOf]);
  if (model.model) metadataRows.push(['Actual model', model.model]);
  if (model.requested) metadataRows.push(['Requested model', model.requested]);
  if (model.elapsedMs !== undefined)
    metadataRows.push(['Last model latency', formatDuration(model.elapsedMs)]);
  if (model.usage) metadataRows.push(['Token usage', model.usage]);
  if (model.endpoint) metadataRows.push(['Model endpoint', model.endpoint]);

  const findingBlocks =
    run.findings.length === 0
      ? 'No findings were recorded.'
      : run.findings
          .map((finding) => {
            const anchor = finding.observationId ? anchors.get(finding.observationId) : undefined;
            const evidence = anchor
              ? mdLink('evidence event', `${reportPath}#${anchor}`)
              : finding.observationId
                ? `evidence event ${mdCode(finding.observationId)} was not found in this snapshot`
                : 'no observation was linked';
            const verification =
              (finding.verification?.trim().length ?? 0) > 0
                ? mdInline(finding.verification)
                : 'No verification recorded.';
            return `### ${mdInline(finding.severity.toUpperCase())}: ${mdInline(finding.title)}

${mdInline(finding.detail)}

- Evidence: ${evidence}
- Verification: ${verification}
- Finding ID: ${mdCode(finding.id)}`;
          })
          .join('\n\n');

  const eventBlocks =
    events.length === 0
      ? 'No evidence events were recorded.'
      : events
          .map((event) => {
            const anchor = anchors.get(event.id) ?? `event-${event.seq}`;
            const lines = [
              `#### #${event.seq} — ${mdInline(event.kind)} — ${mdInline(formatTime(event.at))}`,
              '',
              mdInline(event.text || '(no text)'),
              '',
              `- Hosted evidence: ${mdLink(`event #${event.seq}`, `${reportPath}#${anchor}`)}`,
            ];
            if (event.artifact) lines.push(mdArtifact(event.artifact));
            return lines.join('\n');
          })
          .join('\n\n');

  const errorBlocks =
    errors.infrastructure.length === 0 && errors.execution.length === 0
      ? ''
      : `## Failure evidence

### Infrastructure-classified errors

${errors.infrastructure.length === 0 ? 'None recorded.' : errors.infrastructure.map((line) => `- ${mdInline(line)}`).join('\n')}

### Execution and model errors

${errors.execution.length === 0 ? 'None recorded.' : errors.execution.map((line) => `- ${mdInline(line)}`).join('\n')}

`;

  const tracePresent = events.some(
    (event) =>
      event.kind === 'artifact' && event.artifact !== undefined && isTraceRef(event.artifact),
  );

  return `# Sightline evidence report: ${mdInline(run.config.name)}

**Task:** ${mdInline(run.config.task)}

${mdMetadata(metadataRows)}

## Result summary

| Field | Value |
| --- | --- |
| Model claim | ${mdCell(claim.text || 'No model completion claim recorded.')} |
| Observed outcome | ${mdCell(observedText(world, events))} |
| Findings | ${mdCell(`${run.findings.length} recorded (${counts})`)} |
| Infrastructure failure | ${mdCell(errors.infrastructure.length > 0 ? errors.infrastructure.join(' | ') : 'None recorded.')} |
| Execution / model error | ${mdCell(
    runError.length > 0
      ? runError
      : errors.execution.length > 0
        ? errors.execution.join(' | ')
        : 'None recorded.',
  )} |
| Verification | ${mdCell(verificationText(run))} |

## Findings

${findingBlocks}

${errorBlocks}## Evidence

${eventBlocks}

## Hosted and offline copies

- Hosted report: ${mdLink('open the report', reportPath)}
- Standalone offline HTML: \`report.html\` in this bundle contains every evidence image inline and works through file:// with networking disabled.
- Offline evidence files: \`evidence/\` in the ZIP bundle contains the original artifacts. Links in this Markdown are root-relative to the Sightline control server and do not render local ZIP images on GitHub.
- Structured data: \`report.json\` is the frozen ReportSnapshot; \`manifest.json\` and \`sha256sums.txt\` carry SHA-256 integrity data.
- Linked original run: ${run.config.verificationOf ? mdLink(run.config.verificationOf, `/report/${urlPart(run.config.verificationOf)}`) : 'this is not a verification run.'}
- Trusted/local: this bundle may contain evaluator-only setup and sensitive trace or screenshot data. Do not treat it as public-safe or sanitized.
- Trace: ${tracePresent ? 'this run recorded a trace sidecar. The sensitive trace is opened with `bunx playwright show-trace trace/trace.zip`; the viewer requires its local HTTP server and does not run from file://.' : 'no trace artifact was recorded for this run.'}

Verification, when requested, is a separate linked run. It never changes the evidence in this snapshot. Missing artifacts are labeled explicitly in the standalone HTML rather than shown as broken links.
`;
}

function readmeText(
  snapshot: ReportSnapshot,
  traceTargets: string[],
  missingTraceRefs: string[],
  assetMap: Record<string, string>,
): string {
  const run = snapshot.run;
  const world = snapshot.world;
  const lines = [
    'Sightline evidence bundle',
    '=========================',
    '',
    `Agent: ${run.config.name} (${run.config.id})`,
    `Scenario: ${run.config.scenario}`,
    `Profile: ${run.config.profile}`,
    `Status: ${run.status}`,
    `Outcome: ${run.outcome || '(empty)'}`,
    `World revision: ${world.revision}; completed: ${world.completed ? 'yes' : 'no'}`,
    `Snapshot generated: ${formatTime(snapshot.generatedAt)}`,
    '',
    'Contents',
    '--------',
    'report.html  Standalone offline report with inline evidence images. Open directly through file://.',
    'report.md    Issue-ready Markdown. Root-relative links target the Sightline control server, not GitHub.',
    'report.json  Frozen ReportSnapshot version 1.',
    'evidence/    Original evidence artifacts from this bundle (names are sanitized).',
    traceTargets.length > 0
      ? `trace/       Sensitive Playwright trace sidecar: ${traceTargets.join(', ')}`
      : missingTraceRefs.length > 0
        ? `trace/       Trace unavailable in this bundle: ${missingTraceRefs.join(', ')}`
        : 'trace/       No trace artifact was recorded for this run.',
    'manifest.json  SHA-256 hash for every payload file in this bundle (this manifest is not self-referenced).',
    'sha256sums.txt  sha256sum-compatible checksums for every payload file.',
    '',
    'Inspect',
    '-------',
    '1. Open report.html in a browser. It makes no network requests and makes no external asset requests.',
    '2. report.md explains hosted versus offline links; do not expect local images to render on GitHub.',
    traceTargets.length > 0
      ? `3. Inspect the trace with: bunx playwright show-trace ${traceTargets.at(0) ?? 'trace/trace.zip'}. The Playwright trace viewer needs its local HTTP server; it does not support file://.`
      : missingTraceRefs.length > 0
        ? `3. Trace inspection unavailable: ${missingTraceRefs.join(', ')} was referenced but not supplied to this bundle.`
        : '3. No trace inspection step applies to this run.',
    '4. Verify integrity from the bundle root: sha256sum -c sha256sums.txt',
    '',
    'Notes',
    '-----',
    'This bundle is trusted local evidence. It may contain evaluator-only setup and sensitive screenshots, URLs, timestamps or page state.',
    'The trace is sensitive and may include screenshots, URLs, timestamps and page state.',
    'Missing artifacts are labeled explicitly in report.html; they are never replaced with fabricated data.',
    'Verification results belong to a separate linked run and never mutate this frozen snapshot.',
    '',
    `Artifacts: ${Object.keys(assetMap).length}`,
    ...Object.entries(assetMap).map(([ref, target]) => `  ${ref} -> ${target}`),
  ];
  return `${lines.join('\n')}\n`;
}

function findMissingTraceRefs(
  assetMap: Record<string, string>,
  snapshot: ReportSnapshot,
): string[] {
  const refs = new Set<string>();
  for (const event of snapshot.run.events) {
    if (event.artifact && isTraceRef(event.artifact)) refs.add(event.artifact);
  }
  return [...refs].filter((ref) => lookupAsset(assetMap, ref) === undefined);
}

export function reportZip(
  snapshot: ReportSnapshot,
  assets: Record<string, Uint8Array>,
): Uint8Array {
  const run = snapshot.run;
  const html = reportHtml(snapshot, htmlAssetsFromBytes(assets));
  const markdown = reportMarkdown(snapshot);
  const json = prettyJson(snapshot);

  const payloads: Record<string, Uint8Array> = {
    'report.html': textBytes(html),
    'report.md': textBytes(markdown),
    'report.json': textBytes(json),
  };
  const assetMap: Record<string, string> = {};
  const usedEvidenceNames = new Set<string>();
  const traceTargets: string[] = [];
  let traceCount = 0;

  for (const [ref, bytes] of Object.entries(assets)) {
    if (isTraceRef(ref)) {
      traceCount += 1;
      const target = traceCount === 1 ? 'trace/trace.zip' : `trace/trace-${traceCount}.zip`;
      payloads[target] = bytes;
      traceTargets.push(target);
      assetMap[ref] = target;
    } else {
      const name = uniqueName(safeBase(ref), usedEvidenceNames);
      const target = `evidence/${name}`;
      payloads[target] = bytes;
      assetMap[ref] = target;
    }
  }

  payloads['README.txt'] = textBytes(
    readmeText(snapshot, traceTargets, findMissingTraceRefs(assetMap, snapshot), assetMap),
  );

  const hashes: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(payloads)) {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(bytes);
    hashes[path] = hasher.digest('hex');
  }
  const fileEntries = Object.entries(hashes).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const files = Object.fromEntries(fileEntries);
  const sums = fileEntries.map(([path, hash]) => `${hash}  ${path}`).join('\n');
  const manifest = {
    version: 1,
    generatedAt: snapshot.generatedAt,
    algorithm: 'SHA-256',
    agentId: run.config.id,
    runStatus: run.status,
    files,
    assets: assetMap,
    trace: traceTargets,
  };

  const zipFiles: Record<string, Uint8Array> = {
    ...payloads,
    'manifest.json': textBytes(prettyJson(manifest)),
    'sha256sums.txt': textBytes(`${sums}\n`),
  };
  return zipSync(zipFiles, { level: 6 });
}
