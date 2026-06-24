#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { detectInstanceKind, loadConfig, publicConfig } from './config.js';
import {
  evaluateLocalSafety,
  issueApproval,
  summarizeMutation,
  verifyApproval,
} from './safety.js';
import {
  appendHistory,
  appendTelemetry,
  cachedTelemetryEnabled,
  getState,
  readHistory,
  resetInstallId,
  setTelemetryEnabled,
  telemetryEnabled,
} from './storage.js';
import {
  governanceSafetyCheck,
  readViaConfiguredMode,
  recordViaConfiguredMode,
  scriptViaGovernance,
} from './servicenow.js';
import { RecordMutationInput, RuntimeConfig, SafetyDecision, SafetyInput, ScriptExecutionInput } from './types.js';

const execFileAsync = promisify(execFile);
const config = loadConfig();
const publicRuntimeConfig = publicConfig(config);
const serverEntrypoint = fileURLToPath(import.meta.url);
const hasStaticRuntimeConfig = Boolean(config.instanceUrl || config.sdkAuthAlias || config.auth.type !== 'none');
let sdkAuthListCache: Promise<{ available: boolean; output?: string; error?: string }> | undefined;
let effectiveRuntimeConfigCache: Promise<RuntimeConfig> | undefined;
let effectivePublicConfigValue: ReturnType<typeof publicConfig> | undefined;
let effectivePublicConfigCache: Promise<ReturnType<typeof publicConfig>> | undefined;
const telemetryHashCache = new Map<string, string>();
const statusResultCache = new Map<boolean, ReturnType<typeof jsonText>>();
const pendingStatusResultCache = new Map<boolean, Promise<ReturnType<typeof jsonText>>>();
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYS_ID = /^[0-9a-fA-F]{32}$/;
const SAFETY_OPERATIONS = new Set(['query', 'get', 'schema', 'insert', 'update', 'upsert', 'delete', 'script']);
const RECORD_OPERATIONS = new Set(['insert', 'update', 'upsert', 'delete']);
const SCRIPT_MAX_LENGTH = 10000;

function nodeSupportsServiceNowSdk(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > 20 || (major === 20 && minor >= 18);
}

function jsonText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? args as Record<string, unknown> : {};
}

function validationError(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; pattern?: RegExp; minLength?: number; maxLength?: number } = {},
): string | undefined {
  const value = args[key];
  if (value === undefined) {
    if (options.required) validationError(key, 'required');
    return undefined;
  }
  if (typeof value !== 'string') validationError(key, 'expected string');
  if (options.pattern && !options.pattern.test(value)) validationError(key, 'invalid format');
  if (options.minLength !== undefined && value.length < options.minLength) {
    validationError(key, `must be at least ${options.minLength} characters`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    validationError(key, `must be at most ${options.maxLength} characters`);
  }
  return value;
}

function optionalLimit(args: Record<string, unknown>): number | undefined {
  const value = args.limit;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 500) {
    validationError('limit', 'must be an integer between 1 and 500');
  }
  return value;
}

function optionalFields(args: Record<string, unknown>): string[] | undefined {
  const value = args.fields;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) validationError('fields', 'expected array');
  if (value.length > 100) validationError('fields', 'must contain at most 100 items');
  for (const [index, field] of value.entries()) {
    if (typeof field !== 'string' || !FIELD_NAME.test(field)) {
      validationError(`fields.${index}`, 'invalid field name');
    }
  }
  return value as string[];
}

function optionalValues(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.values;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    validationError('values', 'expected object');
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') validationError(key, 'expected boolean');
  return value;
}

function optionalScript(args: Record<string, unknown>, options: { required?: boolean } = {}): string | undefined {
  const value = args.script;
  if (value === undefined) {
    if (options.required) validationError('script', 'required');
    return undefined;
  }
  if (typeof value !== 'string') validationError('script', 'expected string');
  if (value.length < 1) validationError('script', 'required');
  if (value.length > SCRIPT_MAX_LENGTH) validationError('script', `must be at most ${SCRIPT_MAX_LENGTH} characters`);
  return value;
}

function operation(
  args: Record<string, unknown>,
  allowed: Set<string>,
  key = 'operation',
): string {
  const value = args[key];
  if (typeof value !== 'string' || !allowed.has(value)) validationError(key, 'invalid operation');
  return value;
}

interface QueryInput extends Record<string, unknown> {
  table: string;
  query?: string;
  limit?: number;
  fields?: string[];
}

interface GetInput extends Record<string, unknown> {
  table: string;
  sys_id: string;
  fields?: string[];
}

function parseQueryInput(args: Record<string, unknown>): QueryInput {
  const input: QueryInput = {
    table: optionalString(args, 'table', { required: true, pattern: TABLE_NAME })!,
  };
  const query = optionalString(args, 'query', { maxLength: 2000 });
  const limit = optionalLimit(args);
  const fields = optionalFields(args);
  if (query !== undefined) input.query = query;
  if (limit !== undefined) input.limit = limit;
  if (fields !== undefined) input.fields = fields;
  return input;
}

function parseGetInput(args: Record<string, unknown>): GetInput {
  const input: GetInput = {
    table: optionalString(args, 'table', { required: true, pattern: TABLE_NAME })!,
    sys_id: optionalString(args, 'sys_id', { required: true, pattern: SYS_ID })!,
  };
  const fields = optionalFields(args);
  if (fields !== undefined) input.fields = fields;
  return input;
}

function parseSchemaInput(args: Record<string, unknown>) {
  return {
    table: optionalString(args, 'table', { required: true, pattern: TABLE_NAME })!,
  };
}

function parseSafetyInput(args: Record<string, unknown>): SafetyInput {
  const input: SafetyInput = {
    operation: operation(args, SAFETY_OPERATIONS) as SafetyInput['operation'],
  };
  const table = optionalString(args, 'table', { pattern: TABLE_NAME });
  const sysId = optionalString(args, 'sys_id', { pattern: SYS_ID });
  const query = optionalString(args, 'query', { maxLength: 2000 });
  const values = optionalValues(args);
  const fields = optionalFields(args);
  const limit = optionalLimit(args);
  const intent = optionalString(args, 'intent', { maxLength: 500 });
  const script = optionalScript(args);
  if (table !== undefined) input.table = table;
  if (sysId !== undefined) input.sys_id = sysId;
  if (query !== undefined) input.query = query;
  if (values !== undefined) input.values = values;
  if (fields !== undefined) input.fields = fields;
  if (limit !== undefined) input.limit = limit;
  if (intent !== undefined) input.intent = intent;
  if (script !== undefined) input.script = script;
  return input;
}

function parseScriptInput(args: Record<string, unknown>): ScriptExecutionInput {
  return {
    operation: 'script',
    script: optionalScript(args, { required: true })!,
    intent: optionalString(args, 'intent', { required: true, minLength: 1, maxLength: 500 })!,
    approval_token: optionalString(args, 'approval_token', { required: true, minLength: 20 })!,
  };
}

function parseRecordInput(args: Record<string, unknown>): RecordMutationInput {
  const input: RecordMutationInput = {
    operation: operation(args, RECORD_OPERATIONS) as RecordMutationInput['operation'],
    table: optionalString(args, 'table', { required: true, pattern: TABLE_NAME })!,
    approval_token: optionalString(args, 'approval_token', { required: true, minLength: 20 })!,
  };
  const sysId = optionalString(args, 'sys_id', { pattern: SYS_ID });
  const query = optionalString(args, 'query', { maxLength: 2000 });
  const values = optionalValues(args);
  const fields = optionalFields(args);
  const limit = optionalLimit(args);
  const workflow = optionalBoolean(args, 'workflow');
  const autoSysFields = optionalBoolean(args, 'auto_sys_fields');
  const intent = optionalString(args, 'intent', { maxLength: 500 });
  if (sysId !== undefined) input.sys_id = sysId;
  if (query !== undefined) input.query = query;
  if (values !== undefined) input.values = values;
  if (fields !== undefined) input.fields = fields;
  if (limit !== undefined) input.limit = limit;
  if (workflow !== undefined) input.workflow = workflow;
  if (autoSysFields !== undefined) input.auto_sys_fields = autoSysFields;
  if (intent !== undefined) input.intent = intent;
  return input;
}

function errorPayload(error: unknown) {
  const message = error instanceof z.ZodError
    ? error.errors.map((item) => `${item.path.join('.')}: ${item.message}`).join('; ')
    : error instanceof Error
      ? error.message
      : String(error);
  return { success: false, error: message };
}

function queueTelemetry(event: Record<string, unknown>): void {
  appendTelemetry(config, event).catch(() => undefined);
}

function createStatusResult(runtimeConfig: ReturnType<typeof publicConfig>, isTelemetryEnabled: boolean) {
  return jsonText({
    success: true,
    config: runtimeConfig,
    telemetry_enabled: isTelemetryEnabled,
    language: config.mode === 'governance' ? 'governance' : 'safety_checks',
  });
}

function explainHistoryEntry(entry: Record<string, any> | undefined) {
  if (!entry) {
    return {
      summary: 'No local OperatorZero history entry was found.',
      details: [],
    };
  }

  const checkType = entry.decision_source === 'governance' ? 'governance' : 'safety checks';
  const target = [entry.table, entry.record_hint].filter(Boolean).join(' / ') || entry.table || 'not recorded';
  const fields = Array.isArray(entry.field_names) && entry.field_names.length > 0
    ? entry.field_names.join(', ')
    : 'none recorded';
  const reasons = Array.isArray(entry.reasons) && entry.reasons.length > 0
    ? entry.reasons.join(', ')
    : 'none recorded';
  const warnings = Array.isArray(entry.warnings) && entry.warnings.length > 0
    ? entry.warnings.join(', ')
    : 'none recorded';

  return {
    summary: `${entry.event || 'action'} ${entry.outcome || 'completed'} in ${entry.mode || 'unknown'} mode.`,
    details: [
      `Event: ${entry.event || 'unknown'}`,
      `Mode: ${entry.mode || 'unknown'}`,
      `Outcome: ${entry.outcome || 'unknown'}`,
      `Operation: ${entry.operation || 'not recorded'}`,
      `Target: ${target}`,
      `Changed/read fields: ${fields}`,
      `Decision path: ${checkType}`,
      `Reasons: ${reasons}`,
      `Warnings: ${warnings}`,
    ],
  };
}

function statusResult(isTelemetryEnabled: boolean): ReturnType<typeof jsonText> | Promise<ReturnType<typeof jsonText>> {
  const cached = statusResultCache.get(isTelemetryEnabled);
  if (cached) return cached;
  const pending = pendingStatusResultCache.get(isTelemetryEnabled);
  if (pending) return pending;

  const runtimeConfig = effectivePublicConfig();
  if (!(runtimeConfig instanceof Promise)) {
    const result = createStatusResult(runtimeConfig, isTelemetryEnabled);
    statusResultCache.set(isTelemetryEnabled, result);
    return result;
  }

  const result = runtimeConfig.then((resolvedConfig) => {
    const status = createStatusResult(resolvedConfig, isTelemetryEnabled);
    statusResultCache.set(isTelemetryEnabled, status);
    pendingStatusResultCache.delete(isTelemetryEnabled);
    return status;
  });
  pendingStatusResultCache.set(isTelemetryEnabled, result);
  return result;
}

function toolList(): Tool[] {
  return [
    {
      name: 'now_status',
      description: 'Show OperatorZero ServiceNow MCP configuration, redacted auth state, mode, instance kind, and telemetry status.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'now_setup_check',
      description: 'Check local setup, including ServiceNow SDK default login status when possible.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'now_doctor',
      description: 'Run setup diagnostics and return actionable pass, warn, and fail checks.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'now_privacy',
      description: 'Show or update anonymous community learning telemetry settings.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['show', 'enable_telemetry', 'disable_telemetry', 'reset_install_id'],
          },
        },
      },
    },
    {
      name: 'now_history',
      description: 'Read sanitized local OperatorZero history. History never stores record values, credentials, scripts, or raw prompts.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'now_show_last',
      description: 'Show the most recent sanitized local OperatorZero history entry.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'now_explain_last',
      description: 'Explain the most recent sanitized local OperatorZero history entry and its safety/governance decision in plain English.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'now_query',
      description: 'Query ServiceNow records through the configured mode. Read operation.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'number' },
          fields: { type: 'array', items: { type: 'string' } },
        },
        required: ['table'],
      },
    },
    {
      name: 'now_get',
      description: 'Get one ServiceNow record by sys_id through the configured mode. Read operation.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          sys_id: { type: 'string' },
          fields: { type: 'array', items: { type: 'string' } },
        },
        required: ['table', 'sys_id'],
      },
    },
    {
      name: 'now_schema',
      description: 'Read table schema through the configured mode. Read operation.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
        },
        required: ['table'],
      },
    },
    {
      name: 'now_safety_check',
      description: 'Evaluate a read or write operation before execution. For writes, returns a short-lived approval token unless blocked.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['query', 'get', 'schema', 'insert', 'update', 'upsert', 'delete', 'script'] },
          table: { type: 'string' },
          sys_id: { type: 'string' },
          query: { type: 'string' },
          values: { type: 'object' },
          fields: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
          intent: { type: 'string' },
          script: { type: 'string' },
        },
        required: ['operation'],
      },
    },
    {
      name: 'now_record',
      description: 'Execute an approved insert, update, upsert, or delete. Requires an approval token from now_safety_check.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['insert', 'update', 'upsert', 'delete'] },
          table: { type: 'string' },
          sys_id: { type: 'string' },
          query: { type: 'string' },
          values: { type: 'object' },
          fields: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
          workflow: { type: 'boolean' },
          auto_sys_fields: { type: 'boolean' },
          approval_token: { type: 'string' },
          intent: { type: 'string' },
        },
        required: ['operation', 'table', 'approval_token'],
      },
    },
    {
      name: 'now_script',
      description: 'Execute approved ServiceNow server-side JavaScript through the governed Scripted REST API. Requires governance mode and an approval token from now_safety_check.',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string' },
          intent: { type: 'string' },
          approval_token: { type: 'string' },
        },
        required: ['script', 'intent', 'approval_token'],
      },
    },
  ];
}

async function sdkAuthList(): Promise<{ available: boolean; output?: string; error?: string }> {
  if (!sdkAuthListCache) sdkAuthListCache = sdkAuthListUncached();
  return sdkAuthListCache;
}

async function sdkAuthListUncached(): Promise<{ available: boolean; output?: string; error?: string }> {
  try {
    const result = await execFileAsync('now-sdk', ['auth', '--list'], { timeout: 5000 });
    return { available: true, output: result.stdout.trim() || result.stderr.trim() };
  } catch (firstError) {
    try {
      const result = await execFileAsync('npx', ['--yes', '@servicenow/sdk@4.8.0', 'auth', '--list'], { timeout: 30_000 });
      return { available: true, output: result.stdout.trim() || result.stderr.trim() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || firstError);
      return { available: false, error: message };
    }
  }
}

function sdkCredentialSections(output?: string): string[] {
  if (!output) return [];
  return output
    .split(/\n(?=\s*\*?\[[^\]]+\])/)
    .map((section) => section.trim())
    .filter((section) => /\*?\[[^\]]+\]/.test(section));
}

function sdkAliases(output?: string): string[] {
  if (!output) return [];
  return [...output.matchAll(/\*?\[([^\]]+)\]/g)].map((match) => match[1]).filter(Boolean);
}

function sdkDefaultLogin(output?: string): { alias?: string; host?: string } {
  const sections = sdkCredentialSections(output);
  const preferred = sections.find((section) => /^\*\[/.test(section))
    || sections.find((section) => /default\s*=\s*yes/i.test(section))
    || (sections.length === 1 ? sections[0] : undefined);
  if (!preferred) return {};
  return {
    alias: preferred.match(/\*?\[([^\]]+)\]/)?.[1],
    host: preferred.match(/host\s*=\s*(\S+)/i)?.[1],
  };
}

function sdkDefaultAlias(output?: string): string | undefined {
  return sdkDefaultLogin(output).alias;
}

function redactSdkAuthOutput(output?: string): string | undefined {
  if (!output) return output;
  return output
    .split(/\r?\n/)
    .filter((line) => !/^\s*(username|password|pass|token|access_token|refresh_token|client_secret|private_key)\s*=/i.test(line))
    .join('\n');
}

function publicSdkAuthList(sdk: { available: boolean; output?: string; error?: string }) {
  return {
    ...sdk,
    output: redactSdkAuthOutput(sdk.output),
  };
}

function effectiveRuntimeConfig(): RuntimeConfig | Promise<RuntimeConfig> {
  if (hasStaticRuntimeConfig) return config;
  if (effectiveRuntimeConfigCache) return effectiveRuntimeConfigCache;

  effectiveRuntimeConfigCache = sdkAuthList().then((sdk) => {
    const login = sdkDefaultLogin(sdk.output);
    if (!login.alias && !login.host) return config;

    return {
      ...config,
      instanceUrl: login.host,
      instanceKind: detectInstanceKind(login.host, login.alias),
    };
  });
  return effectiveRuntimeConfigCache;
}

function effectivePublicConfig(): ReturnType<typeof publicConfig> | Promise<ReturnType<typeof publicConfig>> {
  if (effectivePublicConfigValue) return effectivePublicConfigValue;
  if (effectivePublicConfigCache) return effectivePublicConfigCache;

  const runtimeConfig = effectiveRuntimeConfig();
  if (!(runtimeConfig instanceof Promise)) {
    effectivePublicConfigValue = publicConfig(runtimeConfig);
    return effectivePublicConfigValue;
  }

  effectivePublicConfigCache = runtimeConfig.then((resolvedConfig) => {
    effectivePublicConfigValue = publicConfig(resolvedConfig);
    return effectivePublicConfigValue;
  });
  return effectivePublicConfigCache;
}

function generatedMcpConfig() {
  return {
    mcpServers: {
      'operatorzero-servicenow-plugin': {
        command: 'node',
        args: [serverEntrypoint],
      },
    },
  };
}

function setupChecks(sdk: { available: boolean; output?: string; error?: string }) {
  const defaultLogin = sdkDefaultLogin(sdk.output);
  const defaultAlias = defaultLogin.alias;
  const aliases = sdkAliases(sdk.output);
  const sdkAliasRegistered = Boolean(config.sdkAuthAlias && aliases.includes(config.sdkAuthAlias));
  const sdkReady = sdk.available && (config.sdkAuthAlias ? sdkAliasRegistered : Boolean(defaultAlias));
  const authReady = config.auth.type !== 'none' || sdkReady;
  const effectiveKind = config.instanceKind === 'unknown' && sdkReady
    ? detectInstanceKind(defaultLogin.host, config.sdkAuthAlias || defaultAlias)
    : config.instanceKind;
  const checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string; fix?: string }> = [
    {
      name: 'node_version',
      status: nodeSupportsServiceNowSdk() ? 'pass' : 'fail',
      detail: `Node ${process.versions.node}`,
      fix: 'Install Node 20.18.0 or newer; the ServiceNow SDK auth CLI requires it.',
    },
    {
      name: 'mcp_entrypoint',
      status: path.basename(serverEntrypoint) === 'index.js' ? 'pass' : 'warn',
      detail: serverEntrypoint,
      fix: 'Run npm run build, then point MCP clients at dist/index.js.',
    },
    {
      name: 'servicenow_instance_url',
      status: config.instanceUrl || sdkReady ? 'pass' : 'fail',
      detail: config.instanceUrl || (sdkReady ? `provided by SDK ${config.sdkAuthAlias ? `alias ${config.sdkAuthAlias}` : `default ${defaultAlias}`}` : 'not configured'),
      fix: 'Run ServiceNow SDK auth, or set OZ_SN_INSTANCE_URL=https://<instance>.service-now.com for Basic/Bearer fallback auth.',
    },
    {
      name: 'servicenow_auth',
      status: authReady ? 'pass' : 'fail',
      detail: config.auth.type !== 'none'
        ? `${config.auth.type} configured`
        : sdkReady
          ? `SDK ${config.sdkAuthAlias ? `alias ${config.sdkAuthAlias}` : `default ${defaultAlias}`} configured`
          : 'not configured',
      fix: 'Run ServiceNow SDK auth. Basic/Bearer env auth is only a fallback.',
    },
    {
      name: 'sdk_default_login',
      status: sdkReady ? 'pass' : sdk.available ? 'warn' : 'fail',
      detail: config.sdkAuthAlias
        ? sdkAliasRegistered
          ? `using override alias ${config.sdkAuthAlias}`
          : `override alias ${config.sdkAuthAlias} was not found`
        : defaultAlias
          ? `using default ${defaultAlias}`
          : 'no default SDK login found',
      fix: 'Run npx --yes @servicenow/sdk@4.8.0 auth --add <instance_url>. If you have multiple logins, use now-sdk auth --use <alias>.',
    },
    {
      name: 'sdk_auth_override',
      status: config.sdkAuthAlias ? sdkAliasRegistered ? 'pass' : 'fail' : 'pass',
      detail: config.sdkAuthAlias
        ? sdkAliasRegistered
          ? `override alias ${config.sdkAuthAlias} found`
          : `override alias ${config.sdkAuthAlias} not found`
        : 'not set; using SDK default login',
      fix: 'Unset OZ_SN_AUTH_ALIAS to use the SDK default, or set it to an alias from now-sdk auth --list.',
    },
    {
      name: 'sdk_auth_list',
      status: sdk.available ? 'pass' : 'warn',
      detail: sdk.available ? 'ServiceNow SDK auth list is available.' : (sdk.error || 'ServiceNow SDK auth list is unavailable.'),
      fix: 'Run npx --yes @servicenow/sdk@4.8.0 auth --list once after signing in.',
    },
    {
      name: 'governance_api',
      status: config.governanceApiUrl ? 'pass' : 'warn',
      detail: config.governanceApiUrl || 'not configured; local safety checks will be used.',
      fix: 'Install the ServiceNow governance artifacts, then set OZ_MODE=governance and OZ_GOVERNANCE_API_URL=<url>.',
    },
    {
      name: 'instance_kind',
      status: effectiveKind === 'subprod' ? 'pass' : 'warn',
      detail: effectiveKind,
      fix: 'Use a dev/sub-prod instance for write validation. Production instances are read-only by default.',
    },
  ];

  return checks;
}

function setupReport(sdk: { available: boolean; output?: string; error?: string }) {
  const checks = setupChecks(sdk);
  const failures = checks.filter((check) => check.status === 'fail');
  const defaultLogin = sdkDefaultLogin(sdk.output);
  const effectiveConfig = {
    ...publicRuntimeConfig,
    instance_url: publicRuntimeConfig.instance_url || defaultLogin.host,
    instance_kind: publicRuntimeConfig.instance_kind === 'unknown' && (defaultLogin.host || defaultLogin.alias)
      ? detectInstanceKind(defaultLogin.host, defaultLogin.alias)
      : publicRuntimeConfig.instance_kind,
    auth: publicRuntimeConfig.auth === 'sdk_default' && defaultLogin.alias ? 'sdk_default' : publicRuntimeConfig.auth,
  };
  return {
    success: failures.length === 0,
    ready: failures.length === 0,
    config: effectiveConfig,
    sdk_auth_alias_configured: Boolean(config.sdkAuthAlias),
    sdk_default_alias: sdkDefaultAlias(sdk.output),
    sdk_auth_list: publicSdkAuthList(sdk),
    mcp_config: generatedMcpConfig(),
    checks,
    setup_notes: [
      'Run npm run setup to generate .operatorzero/mcp.config.json with an absolute dist/index.js path.',
      'Use npx --yes @servicenow/sdk@4.8.0 auth --add <instance_url> to sign in with the ServiceNow SDK.',
      'OperatorZero uses the SDK default login for live ServiceNow calls. OZ_SN_AUTH_ALIAS is only an optional override.',
      'SN_BEARER_TOKEN or SN_USER/SN_PASS are optional fallback auth methods.',
      'Set OZ_MODE=governance and OZ_GOVERNANCE_API_URL to make ServiceNow-side policy decisions authoritative.',
    ],
    next_commands: [
      'npm run setup',
      'npm run build',
    ],
  };
}

function safetyCheck(input: SafetyInput): SafetyDecision | Promise<SafetyDecision> {
  if (config.mode === 'governance') {
    return governanceSafetyCheck(config, input).then((governanceDecision) => issueApproval(input, governanceDecision));
  }
  const runtimeConfig = effectiveRuntimeConfig();
  return runtimeConfig instanceof Promise
    ? runtimeConfig.then((resolvedConfig) => evaluateLocalSafety(resolvedConfig, input))
    : evaluateLocalSafety(runtimeConfig, input);
}

async function handleTool(name: string, rawArgs: unknown) {
  const args = objectArgs(rawArgs);

  if (name === 'now_status') {
    return statusResult(cachedTelemetryEnabled(config) ?? await telemetryEnabled(config));
  }

  if (name === 'now_setup_check') {
    const sdk = await sdkAuthList();
    return jsonText(setupReport(sdk));
  }

  if (name === 'now_doctor') {
    const sdk = await sdkAuthList();
    return jsonText({ ...setupReport(sdk), doctor: true });
  }

  if (name === 'now_privacy') {
    const operation = typeof args.operation === 'string' ? args.operation : 'show';
    if (operation === 'enable_telemetry') await setTelemetryEnabled(config, true);
    if (operation === 'disable_telemetry') await setTelemetryEnabled(config, false);
    if (operation === 'reset_install_id') await resetInstallId(config);
    const state = await getState(config);
    return jsonText({
      success: true,
      telemetry_enabled: state.telemetryEnabled ?? config.telemetryDefault,
      anonymous_install_id: state.installId,
      collected: [
        'command type',
        'execution mode',
        'success/failure/block/warn outcome',
        'generic error codes',
        'anonymized dependency counts',
        'governance decision type',
        'governance bypass attempts',
      ],
      never_collected: [
        'credentials',
        'raw prompts',
        'record values',
        'customer names',
        'user names',
        'script bodies',
        'business logic',
        'raw metadata dumps',
      ],
    });
  }

  if (name === 'now_history') {
    const limit = typeof args.limit === 'number' ? args.limit : 20;
    return jsonText({ success: true, entries: await readHistory(config, limit) });
  }

  if (name === 'now_show_last') {
    const [entry] = await readHistory(config, 1);
    return jsonText({
      success: Boolean(entry),
      entry: entry || null,
      message: entry ? undefined : 'No local OperatorZero history entry was found.',
    });
  }

  if (name === 'now_explain_last') {
    const [entry] = await readHistory(config, 1);
    return jsonText({
      success: Boolean(entry),
      entry: entry || null,
      explanation: explainHistoryEntry(entry),
    });
  }

  if (name === 'now_query') {
    const input = parseQueryInput(args);
    const result = await readViaConfiguredMode(config, 'query', input);
    await appendHistory(config, {
      event: 'query',
      mode: config.mode,
      outcome: 'success',
      operation: 'query',
      table: input.table,
    });
    queueTelemetry({
      event: 'query',
      mode: config.mode,
      outcome: 'success',
      table_hash: input.table ? hashForTelemetry(input.table) : undefined,
    });
    return jsonText({ success: true, result });
  }

  if (name === 'now_get') {
    const input = parseGetInput(args);
    const result = await readViaConfiguredMode(config, 'get', input);
    await appendHistory(config, {
      event: 'get',
      mode: config.mode,
      outcome: 'success',
      operation: 'get',
      table: input.table,
      record_hint: input.sys_id,
    });
    queueTelemetry({ event: 'get', mode: config.mode, outcome: 'success' });
    return jsonText({ success: true, result });
  }

  if (name === 'now_schema') {
    const input = parseSchemaInput(args);
    const result = await readViaConfiguredMode(config, 'schema', input);
    await appendHistory(config, {
      event: 'schema',
      mode: config.mode,
      outcome: 'success',
      operation: 'schema',
      table: input.table,
    });
    queueTelemetry({ event: 'schema', mode: config.mode, outcome: 'success' });
    return jsonText({ success: true, result });
  }

  if (name === 'now_safety_check') {
    const input = parseSafetyInput(args);
    const decisionResult = safetyCheck(input);
    const decision = decisionResult instanceof Promise ? await decisionResult : decisionResult;
    const fieldNames = Object.keys(input.values || {}).sort();
    await appendHistory(config, {
      event: 'safety_check',
      mode: config.mode,
      outcome: decision.decision,
      operation: input.operation,
      table: input.table,
      field_names: fieldNames,
      record_hint: input.sys_id || (input.query ? 'encoded_query' : undefined),
      decision_source: decision.source,
      reasons: decision.reasons,
      warnings: decision.warnings,
    });
    queueTelemetry({
      event: 'safety_check',
      mode: config.mode,
      outcome: decision.decision,
      operation: input.operation,
      decision_source: decision.source,
      field_count: fieldNames.length,
    });
    return jsonText({ success: decision.decision !== 'blocked', ...decision });
  }

  if (name === 'now_record') {
    const input = parseRecordInput(args);
    const approval = verifyApproval(input);
    const result = await recordViaConfiguredMode(config, input);
    const summary = summarizeMutation(input);
    const history = await appendHistory(config, {
      event: 'record',
      mode: config.mode,
      outcome: 'success',
      decision_source: approval.source,
      ...summary,
    });
    queueTelemetry({
      event: 'record',
      mode: config.mode,
      outcome: 'success',
      operation: input.operation,
      decision_source: approval.source,
      field_count: summary.field_names.length,
    });
    return jsonText({ success: true, history_id: history.id, result });
  }

  if (name === 'now_script') {
    const input = parseScriptInput(args);
    const approval = verifyApproval(input);
    const result = await scriptViaGovernance(config, input);
    const history = await appendHistory(config, {
      event: 'script',
      mode: config.mode,
      outcome: 'success',
      operation: 'script',
      decision_source: approval.source,
    });
    queueTelemetry({
      event: 'script',
      mode: config.mode,
      outcome: 'success',
      operation: 'script',
      decision_source: approval.source,
    });
    return jsonText({ success: true, history_id: history.id, result });
  }

  return jsonText({ success: false, error: `Unknown tool: ${name}` }, true);
}

function hashForTelemetry(value: string): string {
  const existing = telemetryHashCache.get(value);
  if (existing) return existing;
  const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  telemetryHashCache.set(value, hash);
  return hash;
}

const server = new Server(
  { name: 'operatorzero-servicenow-plugin', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleTool(request.params.name, request.params.arguments);
  } catch (error) {
    const payload = errorPayload(error);
    queueTelemetry({
      event: 'tool_error',
      mode: config.mode,
      outcome: 'error',
      generic_error: payload.error.split(':')[0],
    });
    return jsonText(payload, true);
  }
});

async function main() {
  console.error('OperatorZero ServiceNow MCP running on stdio');
  console.error(`Mode: ${config.mode}`);
  console.error(`Instance kind: ${config.instanceKind}`);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
