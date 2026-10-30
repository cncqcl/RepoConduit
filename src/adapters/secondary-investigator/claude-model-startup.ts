import { CLAUDE_MODEL_BOOTSTRAP_SHA256 } from './claude-model-bootstrap.js';
import { HISTORICAL_BOOTSTRAP_SHA256 } from './claude-model-historical.js';
import { parseClaudeModelSupervisorOutput, type ClaudeModelSupervisorDescriptor,
  type ClaudeModelSupervisorState } from './claude-model-supervisor.js';

const namespaces = ['pid', 'mnt', 'net', 'user', 'ipc', 'uts', 'cgroup'] as const;
type Namespace = typeof namespaces[number];
export interface ClaudeModelBootstrapReady {
  protocol: 'claude_model_bootstrap_v1'; kind: 'ready'; pid: number; ppid: number;
  startTicks: number; namespaces: Record<Namespace, string>; capEff: '0'; noNewPrivs: 1;
}
export interface ClaudeModelStartupRecord {
  protocol: 'claude_model_startup_v1'; kind: 'bootstrap_ready_candidate';
  journal: ClaudeModelSupervisorState; bootstrapSha256: string;
  bwrapInfo: { 'child-pid': number; 'cgroup-namespace': number; 'ipc-namespace': number;
    'mnt-namespace': number; 'pid-namespace': number; 'uts-namespace': number };
  outerCandidate: { hostPid: number; startTicks: number; pidNamespace: string; nspid: number[] };
  bootstrapReady: ClaudeModelBootstrapReady;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Startup information is only a candidate; it never establishes confinement or write authority. */
export function parseClaudeModelStartup(line: string,
  descriptor: ClaudeModelSupervisorDescriptor): ClaudeModelStartupRecord | null {
  return parseStartup(line, descriptor, CLAUDE_MODEL_BOOTSTRAP_SHA256);
}

/** Decode-only v2 evidence parser; callers cannot use it for a fresh launch. */
export function parseHistoricalClaudeModelStartup(line: string,
  descriptor: ClaudeModelSupervisorDescriptor): ClaudeModelStartupRecord | null {
  return parseStartup(line, descriptor, HISTORICAL_BOOTSTRAP_SHA256);
}

function parseStartup(line: string, descriptor: ClaudeModelSupervisorDescriptor,
  bootstrapSha256: string): ClaudeModelStartupRecord | null {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 4096 ||
    !line.endsWith('\n') || line.indexOf('\n') !== line.length - 1) return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!exact(raw, ['protocol', 'kind', 'journal', 'bootstrapSha256', 'bwrapInfo',
    'outerCandidate', 'bootstrapReady']) || raw.protocol !== 'claude_model_startup_v1' ||
    raw.kind !== 'bootstrap_ready_candidate' || raw.bootstrapSha256 !== bootstrapSha256)
    return null;
  const journal = parseClaudeModelSupervisorOutput(JSON.stringify(raw.journal) + '\n', descriptor);
  if (!journal || journal.closed || journal.phase !== 'consumed') return null;
  const infoKeys = ['child-pid', 'cgroup-namespace', 'ipc-namespace', 'mnt-namespace',
    'pid-namespace', 'uts-namespace'] as const;
  const info = raw.bwrapInfo; const outer = raw.outerCandidate; const ready = raw.bootstrapReady;
  if (!exact(info, infoKeys) || !infoKeys.every(key => positive(info[key])) ||
    !exact(outer, ['hostPid', 'startTicks', 'pidNamespace', 'nspid']) ||
    !positive(outer.hostPid) || !positive(outer.startTicks) || outer.hostPid !== info['child-pid'] ||
    outer.hostPid === journal.enterPid || outer.pidNamespace !== `pid:[${info['pid-namespace']}]` ||
    !Array.isArray(outer.nspid) || outer.nspid.length < 2 || outer.nspid.length > 8 ||
    !outer.nspid.every(positive) || outer.nspid[0] !== outer.hostPid || outer.nspid.at(-1) !== 1 ||
    !exact(ready, ['protocol', 'kind', 'pid', 'ppid', 'startTicks', 'namespaces', 'capEff', 'noNewPrivs']) ||
    ready.protocol !== 'claude_model_bootstrap_v1' || ready.kind !== 'ready' ||
    !positive(ready.pid) || ready.pid <= 1 || ready.ppid !== 1 || !positive(ready.startTicks) ||
    ready.capEff !== '0' || ready.noNewPrivs !== 1 || !exact(ready.namespaces, namespaces)) return null;
  const ns = ready.namespaces;
  if (!namespaces.every(key => typeof ns[key] === 'string' &&
    new RegExp(`^${key}:\\[[1-9][0-9]{0,15}\\]$`).test(ns[key] as string)) ||
    !(['pid', 'mnt', 'ipc', 'uts', 'cgroup'] as const).every(key =>
      ns[key] === `${key}:[${info[`${key}-namespace`]}]`)) return null;
  return { ...raw, journal } as unknown as ClaudeModelStartupRecord;
}
