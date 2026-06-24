import os from 'node:os';
import path from 'node:path';
import { RuntimeConfig, AuthConfig, InstanceKind, Mode } from './types.js';

function boolFromEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue;
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

function modeFromEnv(value: string | undefined, governanceApiUrl?: string): Mode {
  if (value === 'sdk' || value === 'table' || value === 'governance') return value;
  return governanceApiUrl ? 'governance' : 'table';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = trimTrailingSlash(value.trim());
  if (!trimmed) return undefined;
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function originFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function authFromEnv(): AuthConfig {
  if (process.env.SN_BEARER_TOKEN) {
    return { type: 'bearer', token: process.env.SN_BEARER_TOKEN };
  }
  if (process.env.SN_USER && process.env.SN_PASS) {
    return { type: 'basic', username: process.env.SN_USER, password: process.env.SN_PASS };
  }
  return { type: 'none' };
}

export function authHeader(auth: AuthConfig): string {
  if (auth.type === 'bearer') return `Bearer ${auth.token}`;
  if (auth.type === 'basic') {
    return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  }
  throw new Error('ServiceNow auth is not configured. Run ServiceNow SDK auth, or set SN_BEARER_TOKEN or SN_USER/SN_PASS.');
}

export function detectInstanceKind(instanceUrl?: string, alias?: string): InstanceKind {
  const explicit = (process.env.OZ_INSTANCE_KIND || '').toLowerCase();
  if (['prod', 'production', 'live'].includes(explicit)) return 'production';
  if (['dev', 'test', 'qa', 'subprod', 'sub-production', 'sandbox'].includes(explicit)) return 'subprod';

  const parts: string[] = [];
  if (alias) parts.push(alias);
  if (instanceUrl) {
    try {
      const host = new URL(instanceUrl).hostname.toLowerCase();
      parts.push(host, host.split('.')[0] || '');
    } catch {}
  }

  const joined = parts.join(' ').toLowerCase();
  if (
    /\b(prod|production|live)\b/.test(joined) ||
    /(^|[-_.])prod([-_.]|$)/.test(joined) ||
    parts.some((part) => /^prod\d+/i.test(part))
  ) {
    return 'production';
  }
  if (/\b(dev|test|qa|uat|stage|staging|sandbox|pdi)\b/.test(joined) || /^dev\d+/i.test(joined)) {
    return 'subprod';
  }
  return 'unknown';
}

export function loadConfig(): RuntimeConfig {
  const governanceApiUrl = normalizeUrl(process.env.OZ_GOVERNANCE_API_URL || process.env.SN_API_URL);
  const instanceUrl = normalizeUrl(process.env.OZ_SN_INSTANCE_URL) || originFromUrl(governanceApiUrl);
  const sdkAuthAlias = process.env.OZ_SN_AUTH_ALIAS || process.env.SN_AUTH_ALIAS;
  const mode = modeFromEnv(process.env.OZ_MODE, governanceApiUrl);
  const maxRecordsPerQuery = Number.parseInt(process.env.OZ_MAX_RECORDS_PER_QUERY || '100', 10) || 100;
  const auth = authFromEnv();

  return {
    mode,
    instanceUrl,
    governanceApiUrl,
    sdkAuthAlias,
    instanceKind: detectInstanceKind(instanceUrl, sdkAuthAlias),
    auth,
    authHeader: auth.type === 'none' ? undefined : authHeader(auth),
    storageDir: process.env.OZ_STORAGE_DIR || path.join(os.homedir(), '.operatorzero'),
    telemetryDefault: boolFromEnv(process.env.OZ_TELEMETRY, true),
    maxRecordsPerQuery: Math.max(1, Math.min(maxRecordsPerQuery, 500)),
  };
}

export function publicConfig(config: RuntimeConfig) {
  return {
    mode: config.mode,
    instance_url: config.instanceUrl,
    governance_api_configured: Boolean(config.governanceApiUrl),
    sdk_auth_alias: config.sdkAuthAlias,
    instance_kind: config.instanceKind,
    auth: config.auth.type === 'none'
      ? config.sdkAuthAlias ? 'sdk_alias' : 'sdk_default'
      : config.auth.type,
    storage_dir: config.storageDir,
    telemetry_default: config.telemetryDefault,
    max_records_per_query: config.maxRecordsPerQuery,
  };
}
