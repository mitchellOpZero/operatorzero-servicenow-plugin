export type Mode = 'sdk' | 'table' | 'governance';

export type InstanceKind = 'production' | 'subprod' | 'unknown';

export type AuthConfig =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'none' };

export interface RuntimeConfig {
  mode: Mode;
  instanceUrl?: string;
  governanceApiUrl?: string;
  sdkAuthAlias?: string;
  instanceKind: InstanceKind;
  auth: AuthConfig;
  authHeader?: string;
  storageDir: string;
  telemetryDefault: boolean;
  maxRecordsPerQuery: number;
}

export type RecordOperation = 'insert' | 'update' | 'upsert' | 'delete';
export type ReadOperation = 'query' | 'get' | 'schema';
export type ScriptOperation = 'script';
export type SafetyOperation = ReadOperation | RecordOperation | ScriptOperation;

export interface RecordMutationInput {
  operation: RecordOperation;
  table: string;
  sys_id?: string;
  query?: string;
  values?: Record<string, unknown>;
  fields?: string[];
  limit?: number;
  workflow?: boolean;
  auto_sys_fields?: boolean;
  approval_token?: string;
  intent?: string;
}

export interface SafetyInput {
  operation: SafetyOperation;
  table?: string;
  sys_id?: string;
  query?: string;
  values?: Record<string, unknown>;
  fields?: string[];
  limit?: number;
  intent?: string;
  script?: string;
}

export interface ScriptExecutionInput {
  operation: ScriptOperation;
  script: string;
  intent: string;
  approval_token?: string;
}

export type Decision = 'approved' | 'warn' | 'blocked';

export interface SafetyDecision {
  decision: Decision;
  source: 'local_safety' | 'governance';
  reasons: string[];
  warnings: string[];
  approval_token?: string;
  approval_expires_at?: string;
  governance_decision_id?: string;
}

export interface ApprovalRecord {
  token: string;
  requestHash: string;
  createdAt: string;
  expiresAt: number;
  decision: Decision;
  source: SafetyDecision['source'];
  governanceDecisionId?: string;
  used: boolean;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  event: string;
  mode: Mode;
  outcome: 'success' | 'error' | 'blocked' | 'warn' | 'approved';
  operation?: string;
  table?: string;
  field_names?: string[];
  record_hint?: string;
  decision_source?: SafetyDecision['source'];
  reasons?: string[];
  warnings?: string[];
}
