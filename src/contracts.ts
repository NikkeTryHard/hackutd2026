export type Profile =
  | 'baseline'
  | 'keyboard'
  | 'pointer'
  | 'older-adult'
  | 'child'
  | 'young-adult'
  | 'deuteranopia'
  | 'protanopia'
  | 'tritanopia'
  | 'achromatopsia';
export type Scenario = 'shop' | 'portal';
export type Status = 'queued' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
export type Command = 'running' | 'paused' | 'stopped';
export interface AgentConfig {
  id: string;
  name: string;
  profile: Profile;
  task: string;
  scenario: Scenario;
  url?: string;
  verify: boolean;
  defect?: boolean;
  verificationOf?: string;
}
export interface EvidenceEvent {
  id: string;
  agentId: string;
  seq: number;
  at: number;
  kind: string;
  text: string;
  data?: Record<string, unknown>;
  artifact?: string;
}
export interface Finding {
  id: string;
  title: string;
  detail: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
  observationId?: string;
  verification?: string;
}
export interface AgentRun {
  config: AgentConfig;
  status: Status;
  requested: Command;
  step: number;
  createdAt: number;
  updatedAt: number;
  events: EvidenceEvent[];
  findings: Finding[];
  outcome: string;
  latestFrame?: string;
  cursor?: { x: number; y: number };
  error?: string;
}
export interface World {
  agentId: string;
  scenario: Scenario;
  revision: number;
  stock: number;
  notice: string;
  cart: number;
  selected: string;
  completed: boolean;
  panels: string[];
  appliedRevision: number;
  defect: boolean;
}
export type Action =
  | { type: 'click' | 'move'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number }
  | { type: 'scroll'; dx: number; dy: number }
  | { type: 'key'; key: string }
  | { type: 'type'; text: string }
  | { type: 'wait'; ms: number }
  | { type: 'observe' }
  | { type: 'crop'; x: number; y: number; width: number; height: number; scale: number }
  | { type: 'report'; title: string; detail: string; severity: Finding['severity'] }
  | { type: 'finish'; summary: string };
export interface ModelDecision {
  action: Action;
  reasoning: string;
}
/**
 * One durable operator message as consumed at an action boundary. `interrupt`
 * records that the operator requested the model call in flight to be aborted
 * so this message is seen before the next decision.
 */
export interface OperatorMessage {
  text: string;
  interrupt: boolean;
}
export interface MessageOptions {
  interrupt?: boolean;
}
export interface ReportSnapshot {
  version: 1;
  generatedAt: number;
  run: AgentRun;
  world: World;
}
export interface Backend {
  health(): Promise<{ ok: boolean; detail: string }>;
  list(): Promise<AgentRun[]>;
  get(id: string): Promise<AgentRun | undefined>;
  create(config: AgentConfig): Promise<AgentRun>;
  patch(id: string, partial: Partial<AgentRun>): Promise<void>;
  append(
    id: string,
    event: Omit<EvidenceEvent, 'id' | 'agentId' | 'seq' | 'at'>,
  ): Promise<EvidenceEvent>;
  message(id: string, text: string, options?: MessageOptions): Promise<void>;
  takeMessages(id: string): Promise<OperatorMessage[]>;
  world(id: string): Promise<World>;
  worldAction(id: string, action: string, value?: string): Promise<World>;
  acknowledge(id: string, revision: number): Promise<void>;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}
export interface WorkerHooks {
  origin: string;
  replicaOrigin: string;
  artifactDir: string;
  onFrame: (id: string, bytes: Uint8Array, at: number) => Promise<string>;
}
