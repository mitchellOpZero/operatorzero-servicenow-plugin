import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApprovalRecord, HistoryEntry, RuntimeConfig } from './types.js';

interface StateFile {
  installId: string;
  telemetryEnabled?: boolean;
}

interface PendingTelemetryLine {
  line: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface TelemetryBatch {
  pending: PendingTelemetryLine[];
  timer?: NodeJS.Timeout;
}

const TELEMETRY_FLUSH_DELAY_MS = 5;
const approvals = new Map<string, ApprovalRecord>();
const ensuredDirs = new Set<string>();
const stateCache = new Map<string, StateFile>();
const appendFds = new Map<string, number>();
const telemetryBatches = new Map<string, TelemetryBatch>();

function ensureDir(dir: string): Promise<void> | undefined {
  if (ensuredDirs.has(dir)) return undefined;
  return fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => {
    ensuredDirs.add(dir);
  });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function appendFd(file: string): number {
  const existing = appendFds.get(file);
  if (existing !== undefined) return existing;

  const fd = fsSync.openSync(file, 'a', 0o600);
  appendFds.set(file, fd);
  return fd;
}

function appendText(file: string, text: string): Promise<void> | undefined {
  const pendingDir = ensureDir(path.dirname(file));
  if (pendingDir) {
    return pendingDir.then(() => {
      fsSync.writeSync(appendFd(file), text);
    });
  }
  fsSync.writeSync(appendFd(file), text);
  return undefined;
}

function appendJsonLine(file: string, value: unknown): Promise<void> | undefined {
  return appendText(file, `${JSON.stringify(value)}\n`);
}

function flushTelemetryBatch(file: string, batch: TelemetryBatch): void {
  batch.timer = undefined;
  const pending = batch.pending;
  batch.pending = [];
  const pendingWrite = appendText(file, pending.map((item) => item.line).join(''));
  const written = pendingWrite || Promise.resolve();
  written
    .then(() => pending.forEach((item) => item.resolve()))
    .catch((error) => pending.forEach((item) => item.reject(error)));
}

function appendTelemetryLine(file: string, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  let batch = telemetryBatches.get(file);
  if (!batch) {
    batch = { pending: [] };
    telemetryBatches.set(file, batch);
  }

  const promise = new Promise<void>((resolve, reject) => {
    batch.pending.push({ line, resolve, reject });
  });
  if (!batch.timer) {
    batch.timer = setTimeout(() => flushTelemetryBatch(file, batch), TELEMETRY_FLUSH_DELAY_MS);
  }
  return promise;
}

function statePath(config: RuntimeConfig): string {
  return path.join(config.storageDir, 'state.json');
}

function historyPath(config: RuntimeConfig): string {
  return path.join(config.storageDir, 'history.jsonl');
}

function telemetryPath(config: RuntimeConfig): string {
  return path.join(config.storageDir, 'telemetry.jsonl');
}

export async function getState(config: RuntimeConfig): Promise<StateFile> {
  const file = statePath(config);
  const cached = stateCache.get(file);
  if (cached) return cached;

  const existing = await readJson<StateFile>(file);
  if (existing?.installId) {
    stateCache.set(file, existing);
    return existing;
  }

  const state = { installId: crypto.randomUUID(), telemetryEnabled: config.telemetryDefault };
  await writeJson(file, state);
  stateCache.set(file, state);
  return state;
}

export async function setTelemetryEnabled(config: RuntimeConfig, enabled: boolean): Promise<StateFile> {
  const state = await getState(config);
  const next = { ...state, telemetryEnabled: enabled };
  const file = statePath(config);
  await writeJson(file, next);
  stateCache.set(file, next);
  return next;
}

export async function resetInstallId(config: RuntimeConfig): Promise<StateFile> {
  const state = await getState(config);
  const next = { ...state, installId: crypto.randomUUID() };
  const file = statePath(config);
  await writeJson(file, next);
  stateCache.set(file, next);
  return next;
}

export async function telemetryEnabled(config: RuntimeConfig): Promise<boolean> {
  const cached = cachedTelemetryEnabled(config);
  if (cached !== undefined) return cached;
  const state = await getState(config);
  return state.telemetryEnabled ?? config.telemetryDefault;
}

export function cachedTelemetryEnabled(config: RuntimeConfig): boolean | undefined {
  const state = stateCache.get(statePath(config));
  return state ? state.telemetryEnabled ?? config.telemetryDefault : undefined;
}

export function storeApproval(record: ApprovalRecord): void {
  approvals.set(record.token, record);
}

export function consumeApproval(token: string): ApprovalRecord | undefined {
  const record = approvals.get(token);
  if (!record || record.used || Date.now() > record.expiresAt) {
    approvals.delete(token);
    return undefined;
  }
  approvals.delete(token);
  return record;
}

export function appendHistory(
  config: RuntimeConfig,
  entry: Omit<HistoryEntry, 'id' | 'timestamp'>,
): HistoryEntry | Promise<HistoryEntry> {
  const full: HistoryEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const pendingWrite = appendJsonLine(historyPath(config), full);
  if (pendingWrite) return pendingWrite.then(() => full);
  return full;
}

export async function readHistory(config: RuntimeConfig, limit = 20): Promise<HistoryEntry[]> {
  try {
    const text = await fs.readFile(historyPath(config), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HistoryEntry)
      .slice(-Math.max(1, Math.min(limit, 100)))
      .reverse();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendTelemetry(
  config: RuntimeConfig,
  event: Record<string, unknown>,
): Promise<void> {
  const cachedState = stateCache.get(statePath(config));
  const state = cachedState || await getState(config);
  if (!(state.telemetryEnabled ?? config.telemetryDefault)) return;
  const safeEvent = {
    timestamp: new Date().toISOString(),
    anonymous_install_id: state.installId,
    ...event,
  };
  await appendTelemetryLine(telemetryPath(config), safeEvent);
}
