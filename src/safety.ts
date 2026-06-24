import crypto from 'node:crypto';
import { z } from 'zod';
import { consumeApproval, storeApproval } from './storage.js';
import {
  ApprovalRecord,
  RecordMutationInput,
  RuntimeConfig,
  SafetyDecision,
  SafetyInput,
  ScriptExecutionInput,
} from './types.js';

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYS_ID = /^[0-9a-fA-F]{32}$/;

const dangerousTables = [
  /^sys_user$/,
  /^sys_user_/,
  /^sys_security_acl$/,
  /^sys_properties$/,
  /^sys_auth_/,
  /^oauth_/,
  /^sys_certificate/,
  /^sys_encryption/,
  /^sys_script_fix$/,
  /^sys_scope_privilege$/,
];

const sensitiveField = /(password|passwd|secret|token|credential|private_key|client_secret|access_token|refresh_token)/i;
const READ_REASONS = ['read_operation'];
const LOCAL_PASS_REASONS = ['local_safety_check_passed'];
const EMPTY_WARNINGS: string[] = [];
const EMPTY_FIELD_NAMES: string[] = [];

export const safetyInputSchema = z.object({
  operation: z.enum(['query', 'get', 'schema', 'insert', 'update', 'upsert', 'delete', 'script']),
  table: z.string().regex(TABLE_NAME).optional(),
  sys_id: z.string().regex(SYS_ID).optional(),
  query: z.string().max(2000).optional(),
  values: z.record(z.unknown()).optional(),
  fields: z.array(z.string().regex(FIELD_NAME)).max(100).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  intent: z.string().max(500).optional(),
  script: z.string().max(10000).optional(),
});

export const recordInputSchema = z.object({
  operation: z.enum(['insert', 'update', 'upsert', 'delete']),
  table: z.string().regex(TABLE_NAME),
  sys_id: z.string().regex(SYS_ID).optional(),
  query: z.string().max(2000).optional(),
  values: z.record(z.unknown()).optional(),
  fields: z.array(z.string().regex(FIELD_NAME)).max(100).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  workflow: z.boolean().optional(),
  auto_sys_fields: z.boolean().optional(),
  approval_token: z.string().min(20),
  intent: z.string().max(500).optional(),
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ',';
      out += stableStringify(value[i]);
    }
    return `${out}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    if (keys.length > 1) keys.sort();

    let out = '{';
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (i > 0) out += ',';
      out += `${JSON.stringify(key)}:${stableStringify(obj[key])}`;
    }
    return `${out}}`;
  }
  return JSON.stringify(value);
}

export function requestHash(input: SafetyInput | RecordMutationInput | ScriptExecutionInput): string {
  const obj = input as any;
  const parts = [
    hashPart(input.operation),
    hashPart(obj.table),
    hashPart(obj.sys_id),
    hashPart(obj.query),
    hashPart(obj.values ? stableStringify(obj.values) : undefined),
    hashPart(obj.fields ? stableStringify(obj.fields) : undefined),
    hashPart(obj.limit),
    hashPart(obj.workflow),
    hashPart(obj.auto_sys_fields),
    hashPart(obj.script),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function hashPart(value: unknown): string {
  if (value === undefined) return '-';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `${text.length}:${text}`;
}

function isWrite(operation: SafetyInput['operation']): boolean {
  return operation === 'insert' || operation === 'update' || operation === 'upsert' || operation === 'delete' || operation === 'script';
}

function tableBlocked(table: string | undefined): boolean {
  if (!table) return false;
  return dangerousTables.some((pattern) => pattern.test(table));
}

function fieldNames(values?: Record<string, unknown>): string[] {
  if (!values) return EMPTY_FIELD_NAMES;
  const names = Object.keys(values);
  if (names.length > 1) names.sort();
  return names;
}

export function summarizeMutation(input: Pick<RecordMutationInput, 'operation' | 'table' | 'sys_id' | 'query' | 'values'>) {
  return {
    operation: input.operation,
    table: input.table,
    record_hint: input.sys_id || (input.query ? 'encoded_query' : undefined),
    field_names: fieldNames(input.values),
  };
}

function localDecision(config: RuntimeConfig, input: SafetyInput): SafetyDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (!isWrite(input.operation)) {
    return {
      decision: 'approved',
      source: 'local_safety',
      reasons: READ_REASONS,
      warnings: EMPTY_WARNINGS,
    };
  }

  if (input.operation === 'script') {
    return {
      decision: 'blocked',
      source: 'local_safety',
      reasons: ['script_execution_requires_governance_mode'],
      warnings,
    };
  }

  if (config.instanceKind === 'production') {
    reasons.push('production_instances_are_read_only_by_default');
  }

  if (!input.table) reasons.push('table_required_for_write');
  if (tableBlocked(input.table)) reasons.push('table_is_blocked_for_free_local_writes');

  const names = fieldNames(input.values);
  if (input.operation !== 'delete' && names.length === 0) {
    reasons.push('values_required_for_insert_update_or_upsert');
  }
  if (names.some((name) => sensitiveField.test(name))) {
    reasons.push('sensitive_credential_like_field_write_blocked');
  }
  if (input.operation === 'delete') {
    warnings.push('delete_operation_requires_extra_confirmation');
    if (!input.sys_id) reasons.push('delete_requires_sys_id_in_table_mode');
  }
  if (input.operation === 'upsert' && !input.sys_id && !input.query) {
    reasons.push('upsert_requires_sys_id_or_query');
  }
  if (config.instanceKind === 'unknown') {
    warnings.push('instance_type_unknown_verify_this_is_dev_or_subprod_before_approval');
  }

  if (reasons.length > 0) {
    return { decision: 'blocked', source: 'local_safety', reasons, warnings };
  }

  return {
    decision: warnings.length > 0 ? 'warn' : 'approved',
    source: 'local_safety',
    reasons: LOCAL_PASS_REASONS,
    warnings: warnings.length > 0 ? warnings : EMPTY_WARNINGS,
  };
}

export function issueApproval(input: SafetyInput, decision: SafetyDecision): SafetyDecision {
  if (!isWrite(input.operation) || decision.decision === 'blocked') return decision;

  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000;
  const approvalExpiresAt = new Date(expiresAt).toISOString();
  const record: ApprovalRecord = {
    token: crypto.randomUUID(),
    requestHash: requestHash(input),
    createdAt: new Date(now).toISOString(),
    expiresAt,
    decision: decision.decision,
    source: decision.source,
    governanceDecisionId: decision.governance_decision_id,
    used: false,
  };
  storeApproval(record);

  return {
    ...decision,
    approval_token: record.token,
    approval_expires_at: approvalExpiresAt,
  };
}

export function evaluateLocalSafety(config: RuntimeConfig, input: SafetyInput): SafetyDecision {
  return issueApproval(input, localDecision(config, input));
}

export function verifyApproval(input: RecordMutationInput | ScriptExecutionInput): ApprovalRecord {
  const token = input.approval_token;
  const approval = token ? consumeApproval(token) : undefined;
  if (!approval) {
    throw new Error('Missing, expired, or already used approval token. Run now_safety_check and ask for explicit approval first.');
  }
  const actualHash = requestHash(input);
  if (approval.requestHash !== actualHash) {
    throw new Error('Approval token does not match the requested operation. Run now_safety_check again for this exact change.');
  }
  if (approval.decision === 'blocked') {
    throw new Error('Blocked safety decisions cannot be executed.');
  }
  return approval;
}
