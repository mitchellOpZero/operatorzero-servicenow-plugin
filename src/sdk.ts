import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { RuntimeConfig } from './types.js';

interface SdkModules {
  credentialProvider: (alias?: string) => Promise<unknown>;
  Connector: new (credential: unknown) => { fetch: (endpoint: string, init: RequestInit) => Promise<Response> };
  nodeModules: string;
}

let moduleCandidates: Promise<string[]> | undefined;
const modulesCache = new Map<string, SdkModules>();
const connectorCache = new Map<string, Promise<{ fetch: (endpoint: string, init: RequestInit) => Promise<Response> }>>();

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function sdkNodeModuleCandidates(): Promise<string[]> {
  if (moduleCandidates) return moduleCandidates;

  moduleCandidates = (async () => {
    const candidates: string[] = [];
    if (process.env.SN_SDK_NODE_MODULES) candidates.push(process.env.SN_SDK_NODE_MODULES);

    candidates.push(path.resolve(process.cwd(), 'node_modules'));

    const npxRoot = path.join(os.homedir(), '.npm', '_npx');
    try {
      const entries = await fs.readdir(npxRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) candidates.push(path.join(npxRoot, entry.name, 'node_modules'));
      }
    } catch {
      // The npx cache may not exist until the SDK has been run once.
    }

    const unique = [...new Set(candidates)];
    const withStats: Array<{ candidate: string; mtimeMs: number }> = [];
    for (const candidate of unique) {
      const sdkCli = path.join(candidate, '@servicenow', 'sdk-cli', 'package.json');
      const sdkApi = path.join(candidate, '@servicenow', 'sdk-api', 'package.json');
      if (await exists(sdkCli) && await exists(sdkApi)) {
        const stat = await fs.stat(sdkCli);
        withStats.push({ candidate, mtimeMs: stat.mtimeMs });
      }
    }

    return withStats
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((item) => item.candidate);
  })();

  return moduleCandidates;
}

async function loadSdkModules(): Promise<SdkModules> {
  const candidates = await sdkNodeModuleCandidates();
  for (const nodeModules of candidates) {
    const cached = modulesCache.get(nodeModules);
    if (cached) return cached;

    try {
      const sdkRequire = createRequire(path.join(nodeModules, 'operatorzero-sdk-session.cjs'));
      const { credentialProvider } = sdkRequire('@servicenow/sdk-cli/dist/auth') as {
        credentialProvider: SdkModules['credentialProvider'];
      };
      const { Connector } = sdkRequire('@servicenow/sdk-api') as {
        Connector: SdkModules['Connector'];
      };
      const modules = { credentialProvider, Connector, nodeModules };
      modulesCache.set(nodeModules, modules);
      return modules;
    } catch {
      // Try the next SDK cache or explicit SDK node_modules path.
    }
  }

  throw new Error(
    'ServiceNow SDK auth modules are unavailable. Run `npx --yes @servicenow/sdk@4.8.0 auth --list` once, or set SN_SDK_NODE_MODULES to the SDK node_modules path.',
  );
}

async function sdkConnector(alias?: string) {
  const cacheKey = alias || '__default__';
  const cached = connectorCache.get(cacheKey);
  if (cached) return cached;

  const next = loadSdkModules().then(async ({ credentialProvider, Connector }) => {
    const credential = await credentialProvider(alias);
    return new Connector(credential);
  });
  connectorCache.set(cacheKey, next);
  return next;
}

function endpointFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.startsWith('/') ? url : `/${url}`;
  }
}

export async function fetchWithSdkAuth(config: RuntimeConfig, url: string, init: RequestInit): Promise<Response> {
  const connector = await sdkConnector(config.sdkAuthAlias);
  return connector.fetch(endpointFromUrl(url), init);
}
