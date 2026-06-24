import { authHeader } from './config.js';
import { fetchWithSdkAuth } from './sdk.js';
import { RecordMutationInput, RuntimeConfig, SafetyDecision, SafetyInput, ScriptExecutionInput } from './types.js';

function requireInstanceUrl(config: RuntimeConfig): string {
  if (!config.instanceUrl) {
    if (config.auth.type === 'none') return '';
    throw new Error('OZ_SN_INSTANCE_URL is required for Table API mode when using Basic/Bearer fallback auth.');
  }
  return config.instanceUrl;
}

function requireGovernanceApiUrl(config: RuntimeConfig): string {
  if (!config.governanceApiUrl) {
    throw new Error('OZ_GOVERNANCE_API_URL or SN_API_URL is required for Governance API mode.');
  }
  return config.governanceApiUrl;
}

function tableQueryParams(query: string, limit: number, maxRecords: number, fields?: string[]): string {
  const out = new URLSearchParams();
  if (query !== '') out.set('sysparm_query', query);
  out.set('sysparm_limit', String(Math.min(limit, maxRecords)));
  if (fields && fields.length > 0) out.set('sysparm_fields', fields.join(','));
  out.set('sysparm_display_value', 'false');
  return `?${out.toString()}`;
}

function tableGetParams(fields?: string[]): string {
  const out = new URLSearchParams();
  if (fields && fields.length > 0) out.set('sysparm_fields', fields.join(','));
  out.set('sysparm_display_value', 'false');
  return `?${out.toString()}`;
}

function responseSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (response.ok && contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      throw new Error('ServiceNow returned non-JSON response');
    }
  }

  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      const detail = responseSnippet(text);
      throw new Error(`ServiceNow returned non-JSON response${detail ? `: ${detail}` : ''}`);
    }
  }
  if (!response.ok) {
    const body = parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : {};
    const error =
      body.error?.message ||
      body.error ||
      body.result?.error ||
      responseSnippet(text) ||
      `ServiceNow HTTP ${response.status}`;
    throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
  }
  return parsed;
}

async function fetchJson(config: RuntimeConfig, url: string, init: RequestInit): Promise<unknown> {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  if (config.auth.type === 'none') {
    return parseResponse(await fetchWithSdkAuth(config, url, { ...init, headers }));
  }

  return parseResponse(await fetch(url, {
    ...init,
    headers: {
      ...headers,
      Authorization: config.authHeader ?? authHeader(config.auth),
    },
  }));
}

function unwrapCustomApi(body: unknown): unknown {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, any>;
    const result = obj.result;
    if (result && typeof result === 'object' && 'success' in result) {
      if (result.success === false) {
        const error = result.error || 'Governance API returned an error';
        const blocked = result.blocked ? ' blocked' : '';
        throw new Error(`${error}${blocked}`);
      }
      return result.result ?? result;
    }
    if (obj.success === false) {
      const error = obj.error || 'Governance API returned an error';
      const blocked = obj.blocked ? ' blocked' : '';
      throw new Error(`${error}${blocked}`);
    }
    return obj.result ?? obj;
  }
  return body;
}

export async function callGovernanceApi(config: RuntimeConfig, payload: Record<string, unknown>): Promise<unknown> {
  const url = requireGovernanceApiUrl(config);
  return unwrapCustomApi(await fetchJson(config, url, {
    method: 'POST',
    body: JSON.stringify(payload),
  }));
}

export async function governanceSafetyCheck(config: RuntimeConfig, input: SafetyInput): Promise<SafetyDecision> {
  const result = await callGovernanceApi(config, {
    action: 'governance_check',
    ...input,
  });
  const obj = result && typeof result === 'object' ? (result as Record<string, any>) : {};
  const decision = obj.decision === 'blocked' || obj.decision === 'warn' ? obj.decision : 'approved';
  return {
    decision,
    source: 'governance',
    reasons: Array.isArray(obj.reasons) ? obj.reasons.map(String) : ['governance_api_approved'],
    warnings: Array.isArray(obj.warnings) ? obj.warnings.map(String) : [],
    governance_decision_id: typeof obj.decision_id === 'string' ? obj.decision_id : undefined,
  };
}

export async function tableQuery(
  config: RuntimeConfig,
  table: string,
  query = '',
  limit = config.maxRecordsPerQuery,
  fields?: string[],
): Promise<unknown> {
  const base = requireInstanceUrl(config);
  const url = `${base}/api/now/table/${encodeURIComponent(table)}${tableQueryParams(query, limit, config.maxRecordsPerQuery, fields)}`;
  const body = await fetchJson(config, url, { method: 'GET' }) as Record<string, unknown>;
  return { table, count: Array.isArray(body.result) ? body.result.length : undefined, records: body.result };
}

export async function tableGet(config: RuntimeConfig, table: string, sysId: string, fields?: string[]): Promise<unknown> {
  const base = requireInstanceUrl(config);
  const url = `${base}/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}${tableGetParams(fields)}`;
  const body = await fetchJson(config, url, { method: 'GET' }) as Record<string, unknown>;
  return { found: Boolean(body.result), table, record: body.result };
}

export async function tableSchema(config: RuntimeConfig, table: string): Promise<unknown> {
  const dictionary = await tableQuery(
    config,
    'sys_dictionary',
    `name=${table}^elementISNOTEMPTY^internal_type!=collection`,
    config.maxRecordsPerQuery,
    ['element', 'column_label', 'internal_type', 'mandatory', 'reference', 'max_length', 'name'],
  ) as Record<string, any>;
  const records = Array.isArray(dictionary.records) ? dictionary.records : [];
  return {
    table,
    field_count: records.length,
    fields: records.map((record: Record<string, unknown>) => ({
      name: record.element,
      label: record.column_label,
      type: record.internal_type,
      mandatory: record.mandatory,
      reference: record.reference || null,
      max_length: record.max_length,
      source_table: record.name,
    })),
  };
}

async function tableInsert(config: RuntimeConfig, input: RecordMutationInput): Promise<unknown> {
  const base = requireInstanceUrl(config);
  const body = await fetchJson(config, `${base}/api/now/table/${encodeURIComponent(input.table)}`, {
    method: 'POST',
    body: JSON.stringify(input.values || {}),
  }) as Record<string, unknown>;
  return { operation: 'insert', table: input.table, record: body.result };
}

async function tableUpdate(config: RuntimeConfig, input: RecordMutationInput): Promise<unknown> {
  if (!input.sys_id) throw new Error('sys_id is required for table update.');
  const base = requireInstanceUrl(config);
  const body = await fetchJson(config, `${base}/api/now/table/${encodeURIComponent(input.table)}/${encodeURIComponent(input.sys_id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input.values || {}),
  }) as Record<string, unknown>;
  return { operation: 'update', table: input.table, record: body.result };
}

async function tableDelete(config: RuntimeConfig, input: RecordMutationInput): Promise<unknown> {
  if (!input.sys_id) throw new Error('sys_id is required for table delete.');
  const base = requireInstanceUrl(config);
  await fetchJson(config, `${base}/api/now/table/${encodeURIComponent(input.table)}/${encodeURIComponent(input.sys_id)}`, {
    method: 'DELETE',
  });
  return { operation: 'delete', table: input.table, sys_id: input.sys_id, deleted: true };
}

async function tableUpsert(config: RuntimeConfig, input: RecordMutationInput): Promise<unknown> {
  if (input.sys_id) return tableUpdate(config, { ...input, operation: 'update' });
  if (!input.query) return tableInsert(config, { ...input, operation: 'insert' });

  const existing = await tableQuery(config, input.table, input.query, 2, ['sys_id']) as Record<string, any>;
  const records = Array.isArray(existing.records) ? existing.records : [];
  if (records.length > 1) throw new Error('Upsert query matched more than one record.');
  if (records.length === 1 && records[0]?.sys_id) {
    return tableUpdate(config, { ...input, operation: 'update', sys_id: String(records[0].sys_id) });
  }
  return tableInsert(config, { ...input, operation: 'insert' });
}

export async function tableRecord(config: RuntimeConfig, input: RecordMutationInput): Promise<unknown> {
  if (input.operation === 'insert') return tableInsert(config, input);
  if (input.operation === 'update') return tableUpdate(config, input);
  if (input.operation === 'delete') return tableDelete(config, input);
  return tableUpsert(config, input);
}

export async function readViaConfiguredMode(
  config: RuntimeConfig,
  action: 'query' | 'get' | 'schema',
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (config.mode === 'governance') {
    return callGovernanceApi(config, { action, ...payload });
  }

  if (action === 'query') {
    return tableQuery(
      config,
      String(payload.table),
      typeof payload.query === 'string' ? payload.query : '',
      typeof payload.limit === 'number' ? payload.limit : config.maxRecordsPerQuery,
      Array.isArray(payload.fields) ? payload.fields as string[] : undefined,
    );
  }
  if (action === 'get') {
    return tableGet(
      config,
      String(payload.table),
      String(payload.sys_id),
      Array.isArray(payload.fields) ? payload.fields as string[] : undefined,
    );
  }
  return tableSchema(config, String(payload.table));
}

export async function recordViaConfiguredMode(config: RuntimeConfig, input: RecordMutationInput): Promise<unknown> {
  if (config.mode === 'governance') {
    return callGovernanceApi(config, {
      action: 'record',
      operation: input.operation,
      table: input.table,
      sys_id: input.sys_id,
      query: input.query,
      values: input.values,
      fields: input.fields,
      limit: input.limit,
      workflow: input.workflow,
      auto_sys_fields: input.auto_sys_fields,
    });
  }
  return tableRecord(config, input);
}

export async function scriptViaGovernance(config: RuntimeConfig, input: ScriptExecutionInput): Promise<unknown> {
  if (config.mode !== 'governance') {
    throw new Error('Server-side script execution requires OZ_MODE=governance and OZ_GOVERNANCE_API_URL.');
  }
  return callGovernanceApi(config, {
    action: 'script',
    operation: input.operation,
    script: input.script,
    intent: input.intent,
  });
}
