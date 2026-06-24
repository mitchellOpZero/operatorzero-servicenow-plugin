#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const command = process.argv[2] || 'doctor';
const jsonOutput = process.argv.includes('--json');
const shouldWriteConfig = command === 'setup' || command === 'doctor' || command === 'mcp-config';
const distEntrypoint = path.join(root, 'dist', 'index.js');
const generatedDir = path.join(root, '.operatorzero');
const generatedMcpConfigPath = path.join(generatedDir, 'mcp.config.json');

function normalizeUrl(value) {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function originFromUrl(value) {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function detectInstanceKind(instanceUrl, alias) {
  const explicit = (process.env.OZ_INSTANCE_KIND || '').toLowerCase();
  if (['prod', 'production', 'live'].includes(explicit)) return 'production';
  if (['dev', 'test', 'qa', 'subprod', 'sub-production', 'sandbox'].includes(explicit)) return 'subprod';

  const parts = [];
  if (alias) parts.push(alias);
  if (instanceUrl) {
    try {
      const host = new URL(instanceUrl).hostname.toLowerCase();
      parts.push(host, host.split('.')[0] || '');
    } catch {
      // Best-effort setup hint only.
    }
  }

  const joined = parts.join(' ').toLowerCase();
  if (/\b(prod|production|live)\b/.test(joined) || /(^|[-_.])prod([-_.]|$)/.test(joined) || parts.some((part) => /^prod\d+/i.test(part))) {
    return 'production';
  }
  if (/\b(dev|test|qa|uat|stage|staging|sandbox|pdi)\b/.test(joined) || parts.some((part) => /^dev\d+/i.test(part))) {
    return 'subprod';
  }
  return 'unknown';
}

function runtimeConfigFromEnv() {
  const governanceApiUrl = normalizeUrl(process.env.OZ_GOVERNANCE_API_URL || process.env.SN_API_URL);
  const instanceUrl = normalizeUrl(process.env.OZ_SN_INSTANCE_URL) || originFromUrl(governanceApiUrl);
  const mode = ['sdk', 'table', 'governance'].includes(process.env.OZ_MODE)
    ? process.env.OZ_MODE
    : governanceApiUrl
      ? 'governance'
      : 'table';
  const sdkAuthAlias = process.env.OZ_SN_AUTH_ALIAS || process.env.SN_AUTH_ALIAS;
  const auth = process.env.SN_BEARER_TOKEN
    ? 'bearer'
    : process.env.SN_USER && process.env.SN_PASS
      ? 'basic'
      : 'not_configured';
  return {
    mode,
    instance_url: instanceUrl,
    governance_api_configured: Boolean(governanceApiUrl),
    governance_api_url: governanceApiUrl,
    sdk_auth_alias: sdkAuthAlias,
    instance_kind: detectInstanceKind(instanceUrl, sdkAuthAlias),
    auth,
    storage_dir: process.env.OZ_STORAGE_DIR || path.join(os.homedir(), '.operatorzero'),
    telemetry_default: !['0', 'false', 'off', 'no'].includes(String(process.env.OZ_TELEMETRY || 'true').toLowerCase()),
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function canResolve(moduleName) {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

async function sdkAuthList() {
  try {
    const result = await execFileAsync('now-sdk', ['auth', '--list'], { timeout: 5000 });
    return { available: true, command: 'now-sdk auth --list', output: (result.stdout || result.stderr).trim() };
  } catch {
    try {
      const result = await execFileAsync('npx', ['--yes', '@servicenow/sdk@4.8.0', 'auth', '--list'], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return {
        available: true,
        command: 'npx --yes @servicenow/sdk@4.8.0 auth --list',
        output: (result.stdout || result.stderr).trim(),
      };
    } catch (error) {
      return {
        available: false,
        command: 'npx --yes @servicenow/sdk@4.8.0 auth --list',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function sdkAliases(output) {
  if (!output) return [];
  return [...output.matchAll(/\*?\[([^\]]+)\]/g)].map((match) => match[1]).filter(Boolean);
}

function sdkDefaultAlias(output) {
  if (!output) return undefined;
  const starred = output.match(/\*\[([^\]]+)\]/)?.[1];
  if (starred) return starred;

  const sections = output.split(/\n(?=\s*\*?\[[^\]]+\])/);
  for (const section of sections) {
    if (/default\s*=\s*yes/i.test(section)) return section.match(/\*?\[([^\]]+)\]/)?.[1];
  }

  const aliases = sdkAliases(output);
  return aliases.length === 1 ? aliases[0] : undefined;
}

function redactSdkAuthOutput(output) {
  if (!output) return output;
  return output
    .split(/\r?\n/)
    .filter((line) => !/^\s*(username|password|pass|token|access_token|refresh_token|client_secret|private_key)\s*=/i.test(line))
    .join('\n');
}

function publicSdkAuthList(sdk) {
  return {
    ...sdk,
    output: redactSdkAuthOutput(sdk.output),
  };
}

async function buildIfPossible() {
  if (await exists(distEntrypoint)) {
    return { attempted: false, success: true, reason: 'dist/index.js already exists' };
  }

  const localTsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (!(await exists(localTsc))) {
    return {
      attempted: false,
      success: false,
      reason: 'dist/index.js is missing and local TypeScript is not installed',
    };
  }

  try {
    await execFileAsync('npm', ['run', 'build'], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { attempted: true, success: true, reason: 'npm run build completed' };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function mcpConfig() {
  return {
    mcpServers: {
      'operatorzero-servicenow-plugin': {
        command: 'node',
        args: [distEntrypoint],
        cwd: root,
      },
    },
  };
}

async function writeMcpConfig() {
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.writeFile(generatedMcpConfigPath, `${JSON.stringify(mcpConfig(), null, 2)}\n`, { mode: 0o600 });
}

function check(name, status, detail, fix) {
  return { name, status, detail, ...(fix ? { fix } : {}) };
}

function nodeSupportsServiceNowSdk() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > 20 || (major === 20 && minor >= 18);
}

async function buildReport() {
  const config = runtimeConfigFromEnv();
  const build = command === 'setup' || command === 'doctor'
    ? await buildIfPossible()
    : { attempted: false, success: true, reason: 'build not requested' };
  const sdk = await sdkAuthList();
  const defaultLogin = { alias: sdkDefaultAlias(sdk.output), host: undefined };
  if (sdk.output) {
    const sections = sdk.output
      .split(/\n(?=\s*\*?\[[^\]]+\])/)
      .map((section) => section.trim())
      .filter((section) => /\*?\[[^\]]+\]/.test(section));
    const preferred = sections.find((section) => /^\*\[/.test(section))
      || sections.find((section) => /default\s*=\s*yes/i.test(section))
      || (sections.length === 1 ? sections[0] : undefined);
    if (preferred) defaultLogin.host = preferred.match(/host\s*=\s*(\S+)/i)?.[1];
  }
  const defaultAlias = defaultLogin.alias;
  const aliases = sdkAliases(sdk.output);
  const sdkAliasRegistered = Boolean(config.sdk_auth_alias && aliases.includes(config.sdk_auth_alias));
  const sdkReady = sdk.available && (config.sdk_auth_alias ? sdkAliasRegistered : Boolean(defaultAlias));
  const authReady = config.auth !== 'not_configured' || sdkReady;
  const effectiveKind = config.instance_kind === 'unknown' && sdkReady
    ? detectInstanceKind(defaultLogin.host, config.sdk_auth_alias || defaultAlias)
    : config.instance_kind;
  const dependenciesReady =
    canResolve('@modelcontextprotocol/sdk/server/index.js') &&
    canResolve('@modelcontextprotocol/sdk/server/stdio.js') &&
    canResolve('@modelcontextprotocol/sdk/types.js') &&
    canResolve('zod');
  const buildExists = await exists(distEntrypoint);

  if (shouldWriteConfig) await writeMcpConfig();
  const generatedConfigExists = await exists(generatedMcpConfigPath);

  const checks = [
    check(
      'node_version',
      nodeSupportsServiceNowSdk() ? 'pass' : 'fail',
      `Node ${process.versions.node}`,
      'Install Node 20.18.0 or newer; the ServiceNow SDK auth CLI requires it.',
    ),
    check(
      'dependencies',
      dependenciesReady ? 'pass' : 'fail',
      dependenciesReady ? 'runtime dependencies are resolvable' : 'runtime dependencies are not resolvable',
      'Run npm install.',
    ),
    check(
      'build_output',
      buildExists ? 'pass' : 'fail',
      buildExists ? distEntrypoint : 'dist/index.js missing',
      'Run npm run build.',
    ),
    check(
      'generated_mcp_config',
      generatedConfigExists ? 'pass' : 'warn',
      generatedConfigExists ? generatedMcpConfigPath : 'not generated yet',
      'Run npm run setup.',
    ),
    check(
      'servicenow_instance_url',
      config.instance_url || sdkReady ? 'pass' : 'fail',
      config.instance_url || (sdkReady ? `provided by SDK ${config.sdk_auth_alias ? `alias ${config.sdk_auth_alias}` : `default ${defaultAlias}`}` : 'not configured'),
      'Run ServiceNow SDK auth, or set OZ_SN_INSTANCE_URL=https://<instance>.service-now.com for Basic/Bearer fallback auth.',
    ),
    check(
      'servicenow_auth',
      authReady ? 'pass' : 'fail',
      config.auth !== 'not_configured'
        ? config.auth
        : sdkReady
          ? `SDK ${config.sdk_auth_alias ? `alias ${config.sdk_auth_alias}` : `default ${defaultAlias}`}`
          : 'not configured',
      'Run ServiceNow SDK auth. Basic/Bearer env auth is only a fallback.',
    ),
    check(
      'sdk_default_login',
      sdkReady ? 'pass' : sdk.available ? 'warn' : 'fail',
      config.sdk_auth_alias
        ? sdkAliasRegistered
          ? `using override alias ${config.sdk_auth_alias}`
          : `override alias ${config.sdk_auth_alias} was not found`
        : defaultAlias
          ? `using default ${defaultAlias}`
          : 'no default SDK login found',
      'Run npx --yes @servicenow/sdk@4.8.0 auth --add <instance_url>. If you have multiple logins, use now-sdk auth --use <alias>.',
    ),
    check(
      'sdk_auth_override',
      config.sdk_auth_alias ? sdkAliasRegistered ? 'pass' : 'fail' : 'pass',
      config.sdk_auth_alias
        ? sdkAliasRegistered
          ? `override alias ${config.sdk_auth_alias} found`
          : `override alias ${config.sdk_auth_alias} not found`
        : 'not set; using SDK default login',
      'Unset OZ_SN_AUTH_ALIAS to use the SDK default, or set it to an alias from now-sdk auth --list.',
    ),
    check(
      'sdk_auth_list',
      sdk.available ? 'pass' : 'warn',
      sdk.available ? `available through ${sdk.command}` : sdk.error || 'ServiceNow SDK auth list unavailable',
      'Run npx --yes @servicenow/sdk@4.8.0 auth --list after signing in.',
    ),
    check(
      'governance_api',
      config.governance_api_configured ? 'pass' : 'warn',
      config.governance_api_url || 'not configured; local safety checks will be used',
      'Install the ServiceNow governance artifacts, then set OZ_MODE=governance and OZ_GOVERNANCE_API_URL=<url>.',
    ),
    check(
      'instance_kind',
      effectiveKind === 'subprod' ? 'pass' : 'warn',
      effectiveKind,
      'Use a dev/sub-prod instance for write validation. Production instances are read-only by default.',
    ),
  ];

  const failures = checks.filter((item) => item.status === 'fail');
  return {
    success: failures.length === 0,
    command,
    root,
    config: {
      ...config,
      instance_url: config.instance_url || defaultLogin.host,
      instance_kind: effectiveKind,
    },
    generated_mcp_config_path: generatedMcpConfigPath,
    mcp_config: mcpConfig(),
    build,
    checks,
    sdk_default_alias: defaultAlias,
    sdk_auth_list: publicSdkAuthList(sdk),
    next_steps: nextSteps(checks, config),
  };
}

function nextSteps(checks, config) {
  const failed = new Set(checks.filter((item) => item.status === 'fail').map((item) => item.name));
  const steps = [];
  if (failed.has('dependencies')) steps.push('Run npm install.');
  if (failed.has('build_output')) steps.push('Run npm run build.');
  steps.push(`Copy MCP config from ${generatedMcpConfigPath} into Claude Code, or point your MCP client at dist/index.js.`);
  if (failed.has('sdk_default_login') || failed.has('servicenow_auth')) {
    steps.push('Sign in with the ServiceNow SDK: npx --yes @servicenow/sdk@4.8.0 auth --add https://<instance>.service-now.com');
  }
  if (!config.governance_api_configured) {
    steps.push('Optional: install servicenow/ governance files, then set OZ_MODE=governance and OZ_GOVERNANCE_API_URL.');
  }
  steps.push('Optional verification: npm test.');
  steps.push('Run npm run build to verify the local tool server compiles.');
  return [...new Set(steps)];
}

function printText(report) {
  console.log(`OperatorZero ${command}`);
  console.log(`Root: ${report.root}`);
  if (shouldWriteConfig) console.log(`Generated MCP config: ${report.generated_mcp_config_path}`);
  console.log('');
  console.log('Checks:');
  for (const item of report.checks) {
    console.log(`  [${item.status}] ${item.name}: ${item.detail}`);
    if (item.status !== 'pass' && item.fix) console.log(`        fix: ${item.fix}`);
  }
  console.log('');
  console.log('Next steps:');
  report.next_steps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
  console.log('');
  const label = command === 'doctor' ? 'Doctor' : 'Setup';
  console.log(report.success ? `${label} result: ready for local OperatorZero flow.` : `${label} result: setup needs attention.`);
}

if (!['setup', 'doctor', 'mcp-config'].includes(command)) {
  console.error('Usage: node scripts/operatorzero-setup.mjs <setup|doctor|mcp-config> [--json]');
  process.exit(2);
}

const report = await buildReport();
if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printText(report);
}

if (command === 'doctor' && !report.success) {
  process.exitCode = 1;
}
