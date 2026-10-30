import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, types } from 'node:util';
import { mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InvestigationRecord, InvestigationResult } from '../../core/investigation/request.js';
import type {ParsedInvestigationResult} from '../../core/investigation/result.js';
import type {RepositorySnapshot} from '../repository/snapshots.js';
import {validateInvestigationResultEvidence} from '../../runtime/investigation-result-evidence.js';
import type { VerifiedClaudeModelOriginalOutcome } from '../../runtime/claude-model-investigation.js';
import { FIXED_ZERO_MODEL_PROFILE_DIGEST } from '../../core/investigation/fixed-zero-model-profile.js';
import { isDataPathPermitted, validDataPaths, type RepositoryReadBinding,
  type RepositoryReadObservation, type RepositoryReadReservation } from '../../core/policy/authorize.js';
import { validateRelativePath } from '../repository/path-policy.js';
import { StoreConflict } from './sqlite.js';
import { wslSourceViewSpec, type SourceViewDescriptor, type SourceViewState } from '../codex/investigator/source-view.js';
import { sameWindowsAppServerLaunchOrigin, validCurrentWindowsAppServerLaunchBinding,
  validActiveWindowsAppServerLaunchBinding,
  validWindowsAppServerLaunchRecord, validWindowsAppServerProcessIdentity,
  validWindowsLaunchStartIntent,
  validWindowsAppServerClosureObservation, validWindowsAppServerClosureRecord,
  validWindowsAppServerNotStartedObservation, validWindowsAppServerNotStartedRecord,
  type WindowsAppServerLaunchBinding, type CurrentWindowsAppServerLaunchBinding,
  type CurrentWindowsAppServerLaunchRecord, type WindowsAppServerClosureObservation,
  type WindowsAppServerClosureRecord,
  type WindowsAppServerNotStartedObservation, type WindowsAppServerNotStartedRecord,
  type WindowsAppServerLaunchRecord, type WindowsAppServerProcessIdentity,
  type WindowsLaunchStartIntent } from
  '../codex/investigator/windows-launch-record.js';
import { parseNativeSupervisorGateOutput, type NativeSupervisorGateState } from
  '../secondary-investigator/claude-native-supervisor.js';
import type { SupervisorV2RunningObservation } from
  '../secondary-investigator/supervisor-v2-running-observer.js';
import { parseClaudeModelSupervisorOutput, type ClaudeModelSupervisorState } from
  '../secondary-investigator/claude-model-supervisor.js';
import type { ClaudeModelRunningObservation } from '../secondary-investigator/claude-model-running-observer.js';
import { validateClaudeModelOuterFact, validateCurrentClaudeModelOuterFact,
  type ModelOuterConfinedFact } from
  '../secondary-investigator/claude-model-outer-fact.js';
import { validateClaudeModelTreeTerminal, type ClaudeModelTreeTerminalObservation } from
  '../secondary-investigator/claude-model-tree-terminal.js';
type ModelRunningObservation = Extract<ClaudeModelRunningObservation, { kind: 'claude_model_running' }>;
import { claudeModelTerminalSpec, type ClaudeModelTerminalObservation } from
  '../secondary-investigator/claude-model-terminal-observer.js';
type ModelTerminalObservation = Extract<ClaudeModelTerminalObservation, { kind: 'model_unit_terminal' }>;

export interface SourceViewReservation {
  descriptor: SourceViewDescriptor;
  privateRoot: string;
  closedAt: string | null;
}

export interface WindowsSourceDescriptor {
  attemptId: string;
  workspaceId: string;
  workerEpoch: number;
  sourceDigest: string;
}

export interface WindowsSourceReservation {
  descriptor: WindowsSourceDescriptor;
  privateRoot: string;
  preparedAt: string | null;
}

export interface WindowsLaunchSettlementFact {
  cleanupWorkerId: string;
  cleanupEpoch: number;
  settledAt: string;
  privateRoot: string;
  sourceClosed: {kind:'closed';descriptor:WindowsSourceDescriptor;viewPath:string;
    isolationVerified:false};
}

export interface PendingInvestigation {
  requestId: string;
  workspaceId: string;
  collaborationId: string;
}

export interface ClaimInput {
  workerId: string;
  isolationEvidence: string;
  profileRevision: string;
  permissionEpoch: number;
  now: Date;
  launchProtocol?: 'resource_reservation_v1';
}

export interface InvestigationClaim {
  requestId: string;
  attemptId: string;
  workerId: string;
  workerEpoch: number;
  workspaceId: string;
  nativeRef: string | null;
  launchProtocol?: 'resource_reservation_v1' | null;
  containerName?: string | null;
  containerId?: string | null;
  scratchRoot?: string | null;
  dockerVolume?: DockerVolumeResource;
  wslResource?: WslResource;
  sourceView?: SourceViewReservation;
  windowsSource?: WindowsSourceReservation;
  phase: 'start_intent' | 'started' | 'unknown' | 'reconcile';
}

/** Versioned Docker-owned source view. Names are reserved before native create. */
export interface DockerVolumeResource {
  protocol: 'docker_volume_v1';
  daemonId: string;
  ownerName: string;
  ownerId: string | null;
  volumeName: string | null;
  materializationIntent: boolean;
  materialized: boolean;
  readerName: string | null;
  readerId: string | null;
}

export interface NativeInvestigationJournal {
  requestId: string;
  attemptId: string;
  workspaceId: string;
  collaborationId: string;
  workerEpoch: number;
  thread: { state: 'intent' | 'observed'; threadId: string | null };
  turns: { intentId: string; turnId: string | null;
    state: 'intent' | 'observed' | 'terminal'; interruptAcknowledged: boolean }[];
}

/** Trusted scheduler binding for reads by an independently identified investigator. */
export interface RunningReadBinding {
  collaborationId: string;
  workingCopyId: string;
  snapshotId: string;
  paths: readonly string[];
  workerGrantId: string;
  workerAudience: string;
  workerRecipient: string;
}

export interface SucceededInvestigationReadReceipt {
  id: string; requestId: string; attemptId: string; workspaceId: string;
  collaborationId: string; workingCopyId: string; snapshotId: string;
  contextRevisionId: string; launchEpoch: number; nativeRef: string;
  workerPrincipal: string; workerAudience: string; workerRecipient: string;
  workerGrantId: string;
  path: string; fullContentHash: string; byteRange: [number, number];
  lineRange: [number, number]; pageContentHash: string;
  completeness: 'complete' | 'partial'; reservedAt: string; observedAt: string;
}

export interface CodexNativeReadTurn { intentId: string; threadId: string; turnId: string }
export interface SucceededCodexInvestigationReadReceipt extends Omit<SucceededInvestigationReadReceipt,'nativeRef'> {
  intentId: string; threadId: string; turnId: string; callId: string;
}

export interface WslResourceReservation {
  unitName: string;
  distro: string;
  uid: number;
  bootId: string;
  gate?: WslLaunchGateBinding;
}

export interface WslLaunchGateBinding {
  protocol: 'attempt_gate_v1';
  linuxUser: string;
  root: string;
  payloadKind: 'canary_v1' | 'native_supervisor_v1' | 'native_supervisor_v2' | 'claude_model_v1';
  /** Absent on legacy rows; a v2 release cannot proceed without this original binding. */
  launch?: NativeSupervisorLaunchBinding;
}

export interface NativeSupervisorLaunchBinding {
  workerEpoch: number;
  sourceDigest: string;
  profileDigest: string;
  action: 'fixed_zero_model_v1' | 'claude_model_v1';
  /** Mandatory for new model reservations; absent only on decode-only legacy rows. */
  commandDigest?: string;
}

export interface ModelPromptIntent {
  launchEpoch: number; nativeRef: string; profileDigest: string; commandDigest: string;
  promptHash: string; intentAt: string;
}

export interface WslResourceObservation {
  invocationId: string;
  controlGroup: string;
}

export interface WslResource extends WslResourceReservation {
  invocationId: string | null;
  controlGroup: string | null;
}

interface WslResourceRow {
  wsl_unit_name: string | null;
  wsl_distro: string | null;
  wsl_uid: number | null;
  wsl_boot_id: string | null;
  wsl_invocation_id: string | null;
  wsl_control_group: string | null;
  wsl_launch_gate_json: string | null;
}

interface DockerVolumeRow { docker_volume_json: string | null }

const dockerOwnerName = /^rcac-investigator-owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dockerReaderName = /^rcac-investigator-reader-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dockerId = /^[0-9a-f]{64}$/;
const dockerVolumeName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const dockerDaemonId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validDockerVolume(value: unknown): value is DockerVolumeResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  return Object.keys(resource).sort().join(',') ===
    'daemonId,materializationIntent,materialized,ownerId,ownerName,protocol,readerId,readerName,volumeName' &&
    resource.protocol === 'docker_volume_v1' &&
    typeof resource.daemonId === 'string' && dockerDaemonId.test(resource.daemonId) &&
    typeof resource.ownerName === 'string' && dockerOwnerName.test(resource.ownerName) &&
    (resource.ownerId === null || (typeof resource.ownerId === 'string' && dockerId.test(resource.ownerId))) &&
    (resource.volumeName === null || (typeof resource.volumeName === 'string' && dockerVolumeName.test(resource.volumeName))) &&
    (resource.ownerId === null) === (resource.volumeName === null) &&
    typeof resource.materializationIntent === 'boolean' &&
    (!resource.materializationIntent || resource.ownerId !== null) &&
    typeof resource.materialized === 'boolean' &&
    (!resource.materialized || resource.materializationIntent) &&
    (resource.readerName === null || (typeof resource.readerName === 'string' && dockerReaderName.test(resource.readerName))) &&
    (resource.readerId === null || (typeof resource.readerId === 'string' && dockerId.test(resource.readerId))) &&
    (resource.readerId === null || resource.readerName !== null) &&
    (resource.readerId === null || resource.readerId !== resource.ownerId) &&
    (resource.readerName === null || resource.materialized);
}

function dockerVolumeFromRow(row: DockerVolumeRow): DockerVolumeResource | undefined {
  if (row.docker_volume_json === null) return undefined;
  let value: unknown;
  try { value = JSON.parse(row.docker_volume_json); } catch { throw new StoreConflict(); }
  if (!validDockerVolume(value)) throw new StoreConflict();
  return value;
}

function validSupervisorLaunchBinding(value: unknown, model = false): value is NativeSupervisorLaunchBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const launch = value as Record<string, unknown>;
  return Object.keys(launch).sort().join(',') === (model ?
    'action,commandDigest,profileDigest,sourceDigest,workerEpoch' : 'action,profileDigest,sourceDigest,workerEpoch') &&
    Number.isSafeInteger(launch.workerEpoch) && (launch.workerEpoch as number) > 0 &&
    typeof launch.sourceDigest === 'string' && /^[0-9a-f]{64}$/.test(launch.sourceDigest) &&
    typeof launch.profileDigest === 'string' && /^[0-9a-f]{64}$/.test(launch.profileDigest) &&
    launch.action === (model ? 'claude_model_v1' : 'fixed_zero_model_v1') &&
    (!model || typeof launch.commandDigest === 'string' && /^[0-9a-f]{64}$/.test(launch.commandDigest));
}

function sameSupervisorLaunchBinding(a: NativeSupervisorLaunchBinding | undefined,
  b: NativeSupervisorLaunchBinding | undefined): boolean {
  if (!a || !b) return a === b;
  return a.workerEpoch === b.workerEpoch && a.sourceDigest === b.sourceDigest &&
    a.profileDigest === b.profileDigest && a.action === b.action && a.commandDigest === b.commandDigest;
}

function legacyModelLaunch(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const launch = value as Record<string, unknown>;
  return launch.action === 'claude_model_v1' &&
    Object.keys(launch).sort().join(',') === 'action,profileDigest,sourceDigest,workerEpoch' &&
    Number.isSafeInteger(launch.workerEpoch) && (launch.workerEpoch as number) > 0 &&
    typeof launch.sourceDigest === 'string' && /^[0-9a-f]{64}$/.test(launch.sourceDigest) &&
    typeof launch.profileDigest === 'string' && /^[0-9a-f]{64}$/.test(launch.profileDigest);
}

function validWslGateBinding(value: unknown, decodeLegacy = false): value is WslLaunchGateBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const gate = value as Record<string, unknown>;
  if (Object.keys(gate).sort().join(',') !== (gate.launch === undefined ?
    'linuxUser,payloadKind,protocol,root' : 'launch,linuxUser,payloadKind,protocol,root') ||
    gate.protocol !== 'attempt_gate_v1' ||
    (gate.payloadKind !== 'canary_v1' && gate.payloadKind !== 'native_supervisor_v1' &&
      gate.payloadKind !== 'native_supervisor_v2' && gate.payloadKind !== 'claude_model_v1') ||
    (gate.payloadKind === 'claude_model_v1' && !validSupervisorLaunchBinding(gate.launch, true) &&
      !(decodeLegacy && legacyModelLaunch(gate.launch))) ||
    (gate.launch !== undefined &&
      !((gate.payloadKind === 'native_supervisor_v2' && validSupervisorLaunchBinding(gate.launch)) ||
        (gate.payloadKind === 'claude_model_v1' && (validSupervisorLaunchBinding(gate.launch, true) ||
          decodeLegacy && legacyModelLaunch(gate.launch))))) ||
    typeof gate.linuxUser !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(gate.linuxUser) ||
    typeof gate.root !== 'string' || gate.root.length > 256 ||
    !gate.root.startsWith(`/home/${gate.linuxUser}/`)) return false;
  return gate.root.split('/').slice(1).every(part =>
    /^[A-Za-z0-9._-]+$/.test(part) && part !== '.' && part !== '..');
}

function gateFromRow(raw: string | null): WslLaunchGateBinding | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new StoreConflict(); }
  if (!validWslGateBinding(parsed, true)) throw new StoreConflict();
  return parsed;
}

function sameGateBinding(a: WslLaunchGateBinding | undefined, b: WslLaunchGateBinding | undefined): boolean {
  if (!a || !b) return a === b;
  return a.protocol === b.protocol && a.linuxUser === b.linuxUser &&
    a.root === b.root && a.payloadKind === b.payloadKind &&
    sameSupervisorLaunchBinding(a.launch, b.launch);
}

type PrelaunchRow = WslResourceRow & {
  source_view_json: string | null;
  source_view_closed_at: string | null;
  windows_source_json: string | null;
  launch_protocol: 'resource_reservation_v1' | null;
  phase: InvestigationClaim['phase'];
  native_ref: string | null;
  container_name: string | null;
  container_id: string | null;
  scratch_root: string | null;
} & DockerVolumeRow;

function isUnreservedPrelaunch(row: PrelaunchRow): boolean {
  return row.launch_protocol === 'resource_reservation_v1' && row.phase === 'start_intent' &&
    row.native_ref === null && row.container_name === null && row.container_id === null &&
    row.scratch_root === null && row.docker_volume_json === null && row.wsl_unit_name === null && row.wsl_distro === null &&
    row.wsl_uid === null && row.wsl_boot_id === null && row.wsl_invocation_id === null &&
    row.wsl_control_group === null && row.wsl_launch_gate_json === null &&
    row.source_view_json === null && row.source_view_closed_at === null && row.windows_source_json === null;
}

function wslResourceFromRow(row: WslResourceRow): WslResource | undefined {
  if (row.wsl_unit_name === null) {
    if (row.wsl_distro !== null || row.wsl_uid !== null || row.wsl_boot_id !== null ||
      row.wsl_invocation_id !== null || row.wsl_control_group !== null ||
      row.wsl_launch_gate_json !== null) throw new StoreConflict();
    return undefined;
  }
  if (row.wsl_distro === null || row.wsl_uid === null || row.wsl_boot_id === null ||
    (row.wsl_invocation_id === null) !== (row.wsl_control_group === null)) throw new StoreConflict();
  const gate = gateFromRow(row.wsl_launch_gate_json);
  return { unitName: row.wsl_unit_name, distro: row.wsl_distro, uid: row.wsl_uid,
    bootId: row.wsl_boot_id, invocationId: row.wsl_invocation_id, controlGroup: row.wsl_control_group,
    ...(gate ? { gate } : {}) };
}

interface SourceViewRow {
  source_view_json: string | null;
  source_view_closed_at: string | null;
}

interface WindowsSourceRow { windows_source_json: string | null }

function validWindowsSourceDescriptor(value: unknown): value is WindowsSourceDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'attemptId,sourceDigest,workerEpoch,workspaceId' &&
    typeof v.attemptId === 'string' &&
    /^attempt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.attemptId) &&
    typeof v.workspaceId === 'string' && v.workspaceId.length > 0 &&
    Number.isSafeInteger(v.workerEpoch) && (v.workerEpoch as number) > 0 &&
    typeof v.sourceDigest === 'string' && /^[0-9a-f]{64}$/.test(v.sourceDigest);
}

function validWindowsPrivateRoot(root: unknown): root is string {
  return typeof root === 'string' && root.length <= 4096 && !root.includes('\0') &&
    win32.isAbsolute(root) && win32.normalize(root) === root &&
    !root.endsWith('\\') && !root.startsWith('\\\\');
}

export function validWindowsLaunchSettlementFact(value: unknown):
  value is WindowsLaunchSettlementFact {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const fact=value as Record<string,unknown>;
  if (Object.keys(fact).sort().join(',')!==
    'cleanupEpoch,cleanupWorkerId,privateRoot,settledAt,sourceClosed' ||
    typeof fact.cleanupWorkerId!=='string' || !fact.cleanupWorkerId ||
    !Number.isSafeInteger(fact.cleanupEpoch) || (fact.cleanupEpoch as number)<1 ||
    typeof fact.settledAt!=='string' || !Number.isFinite(Date.parse(fact.settledAt)) ||
    !validWindowsPrivateRoot(fact.privateRoot) || !fact.sourceClosed ||
    typeof fact.sourceClosed!=='object' || Array.isArray(fact.sourceClosed)) return false;
  const source=fact.sourceClosed as Record<string,unknown>;
  return Object.keys(source).sort().join(',')===
    'descriptor,isolationVerified,kind,viewPath' && source.kind==='closed' &&
    source.isolationVerified===false && validWindowsSourceDescriptor(source.descriptor) &&
    source.viewPath===win32.join(fact.privateRoot,
      `${source.descriptor.attemptId}.view`);
}

function windowsSourceFromRow(row: WindowsSourceRow): WindowsSourceReservation | undefined {
  if (row.windows_source_json === null) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(row.windows_source_json); } catch { throw new StoreConflict(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new StoreConflict();
  const v = parsed as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'descriptor,preparedAt,privateRoot' ||
    !validWindowsSourceDescriptor(v.descriptor) || !validWindowsPrivateRoot(v.privateRoot) ||
    (v.preparedAt !== null && (typeof v.preparedAt !== 'string' ||
      !Number.isFinite(Date.parse(v.preparedAt))))) throw new StoreConflict();
  return { descriptor: v.descriptor, privateRoot: v.privateRoot, preparedAt: v.preparedAt as string | null };
}

function sourceViewFromRow(row: SourceViewRow): SourceViewReservation | undefined {
  if (row.source_view_json === null) {
    if (row.source_view_closed_at !== null) throw new StoreConflict();
    return undefined;
  }
  let binding: { descriptor?: SourceViewDescriptor; privateRoot?: string };
  try { binding = JSON.parse(row.source_view_json) as typeof binding; }
  catch { throw new StoreConflict(); }
  if (!binding || Object.keys(binding).sort().join(',') !== 'descriptor,privateRoot' ||
    !binding.descriptor || Object.keys(binding.descriptor).sort().join(',') !==
      'attemptId,bootId,distro,linuxUser,sourceDigest,uid,workerEpoch,workspaceId' ||
    typeof binding.privateRoot !== 'string') throw new StoreConflict();
  try { wslSourceViewSpec('status', binding.descriptor, binding.privateRoot); }
  catch { throw new StoreConflict(); }
  if (row.source_view_closed_at !== null && !Number.isFinite(Date.parse(row.source_view_closed_at))) throw new StoreConflict();
  return { descriptor: binding.descriptor, privateRoot: binding.privateRoot, closedAt: row.source_view_closed_at };
}

export interface CodexSessionClosure {
  sessionId:string;requestId:string;attemptId:string;workerEpoch:number;
  /** Missing on historical original Job closures. Never supplied by an external transport. */
  kind?:'job_closed'|'not_started';
}
export interface CodexSessionCandidate {
  turn:CodexNativeReadTurn;result:ParsedInvestigationResult;snapshot:RepositorySnapshot;
}

export interface InvestigationClaimAuthority {
  verifyIsolation(evidence: string, record: InvestigationRecord, revision: string): boolean;
  verifyNativeReceipt(claim: InvestigationClaim, nativeRef: string, receipt: string): boolean;
  verifyOutcomeReceipt(claim: InvestigationClaim, result: InvestigationResult, nativeRef: string, receipt: string): boolean;
  /** Local original-session registry only; transport/model DTOs cannot supply this authority. */
  verifyCodexSessionClosure?(claim: InvestigationClaim, closure: CodexSessionClosure): boolean;
  verifyModelRunningReceipt?(claim: InvestigationClaim, resource: WslResource,
    fact: ClaudeModelSupervisorState, receipt: string): boolean;
  verifyModelRunningObservationReceipt?(claim: InvestigationClaim, resource: WslResource,
    observation: ModelRunningObservation, receipt: string): boolean;
  verifyModelOuterReceipt?(claim: InvestigationClaim, resource: WslResource,
    fact: ModelOuterConfinedFact, receipt: string): boolean;
  verifyModelPromptWindowReceipt?(claim: InvestigationClaim, fact: ModelOuterConfinedFact,
    receipt: string, purpose: 'intent' | 'send'): boolean;
  verifyClaudeModelPreventionReceipt?(claim: InvestigationClaim, resource: WslResource,
    observation: ModelTerminalObservation, receipt: string): boolean;
  verifyClaudeModelTreeReceipt?(claim: InvestigationClaim, resource: WslResource,
    fact: ModelOuterConfinedFact, observation: ClaudeModelTreeTerminalObservation, receipt: string): boolean;
  verifyClaudeModelOriginalTreeReceipt?(claim: InvestigationClaim, resource: WslResource,
    fact: ModelOuterConfinedFact, observation: ClaudeModelTreeTerminalObservation, receipt: string): boolean;
  verifyClaudeModelOriginalOutcomeReceipt?(claim: InvestigationClaim, resource: WslResource,
    fact: ModelOuterConfinedFact, intent: ModelPromptIntent,
    outcome: VerifiedClaudeModelOriginalOutcome, receipt: string): boolean;
  verifyWslTerminationReceipt?(claim: InvestigationClaim, resource: WslResource, receipt: string): boolean;
  verifyDockerVolumeCleanupReceipt?(claim: InvestigationClaim, resource: DockerVolumeResource,
    receipt: string): boolean;
  verifySupervisorV2TerminalReceipt?(claim: InvestigationClaim, resource: WslResource,
    launch: NativeSupervisorLaunchBinding, journal: NativeSupervisorGateState, receipt: string): boolean;
  verifyWindowsLaunch?(claim: InvestigationClaim, launch: CurrentWindowsAppServerLaunchRecord): boolean;
  verifyWindowsLaunchClosure?(launch: WindowsAppServerLaunchRecord,
    observation: WindowsAppServerClosureObservation): boolean;
  verifyWindowsLaunchNotStarted?(launch: WindowsAppServerLaunchRecord,
    observation: WindowsAppServerNotStartedObservation): boolean;
}

/** Durable request and dispatch intent. Worker execution belongs to the scheduler. */
export class SqliteInvestigationStore {
  private readonly db: DatabaseSync;

  constructor(file: string, private readonly claimAuthority?: InvestigationClaimAuthority) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS investigation_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        audience TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (principal, audience, workspace_id, operation, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS investigation_outbox (
        request_id TEXT PRIMARY KEY REFERENCES investigation_requests(id),
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_codex_owned_sessions (
        attempt_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
        worker_epoch INTEGER NOT NULL,session_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS investigation_cancel_receipts (
        principal TEXT NOT NULL,
        audience TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation='investigate.cancel'),
        idempotency_key TEXT NOT NULL,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        result_json TEXT NOT NULL,
        PRIMARY KEY (principal,audience,workspace_id,operation,idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS investigation_active_attempts (
        request_id TEXT PRIMARY KEY REFERENCES investigation_requests(id),
        attempt_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        worker_epoch INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('start_intent','started','unknown','reconcile')),
        launch_protocol TEXT CHECK (launch_protocol IS NULL OR launch_protocol='resource_reservation_v1'),
        native_ref TEXT,
        container_name TEXT,
        container_id TEXT,
        scratch_root TEXT,
        docker_volume_json TEXT,
        wsl_unit_name TEXT,
        wsl_distro TEXT,
        wsl_uid INTEGER,
        wsl_boot_id TEXT,
        wsl_invocation_id TEXT,
        wsl_control_group TEXT,
        wsl_launch_gate_json TEXT,
        source_view_json TEXT,
        source_view_closed_at TEXT,
        windows_source_json TEXT,
        lease_until TEXT NOT NULL,
        profile_revision TEXT NOT NULL,
        permission_epoch INTEGER NOT NULL,
        isolation_evidence TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS investigation_active_workspace ON investigation_active_attempts(workspace_id);
      CREATE TABLE IF NOT EXISTS investigation_supervisor_v2_running_facts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        fact_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_model_running_facts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        native_ref TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        native_json TEXT,
        outer_json TEXT
      );
      CREATE TABLE IF NOT EXISTS investigation_model_dispatch (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        launch_epoch INTEGER NOT NULL,
        native_ref TEXT NOT NULL,
        profile_digest TEXT NOT NULL,
        command_digest TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        intent_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_model_prevention_facts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        cleanup_epoch INTEGER NOT NULL,
        observation_json TEXT NOT NULL,
        settled_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_model_tree_facts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        cleanup_epoch INTEGER NOT NULL,
        observation_json TEXT NOT NULL,
        settled_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_model_outcome_provenance (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        launch_epoch INTEGER NOT NULL,
        native_ref TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        settled_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_read_receipts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        attempt_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT NOT NULL,
        working_copy_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        launch_epoch INTEGER NOT NULL,
        native_ref TEXT NOT NULL,
        worker_principal TEXT NOT NULL,
        worker_audience TEXT NOT NULL,
        worker_recipient TEXT NOT NULL,
        worker_grant_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','succeeded')),
        full_content_hash TEXT,
        byte_start INTEGER, byte_end INTEGER,
        line_start INTEGER, line_end INTEGER,
        page_content_hash TEXT,
        completeness TEXT,
        reserved_at TEXT NOT NULL,
        observed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS investigation_native_threads (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT NOT NULL,
        worker_epoch INTEGER NOT NULL,
        thread_id TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS investigation_native_turns (
        attempt_id TEXT NOT NULL REFERENCES investigation_native_threads(attempt_id),
        intent_id TEXT NOT NULL,
        turn_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('intent','observed','terminal')),
        interrupt_ack INTEGER NOT NULL DEFAULT 0 CHECK (interrupt_ack IN (0,1)),
        PRIMARY KEY (attempt_id,intent_id)
      );
      CREATE TABLE IF NOT EXISTS investigation_codex_read_sessions (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        workspace_id TEXT NOT NULL,
        launch_epoch INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        profile_revision TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        deadline_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_codex_read_receipts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        attempt_id TEXT NOT NULL REFERENCES investigation_codex_read_sessions(attempt_id),
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT NOT NULL,
        working_copy_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        launch_epoch INTEGER NOT NULL,
        worker_principal TEXT NOT NULL,
        worker_audience TEXT NOT NULL,
        worker_recipient TEXT NOT NULL,
        worker_grant_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','succeeded')),
        full_content_hash TEXT,
        byte_start INTEGER, byte_end INTEGER,
        line_start INTEGER, line_end INTEGER,
        page_content_hash TEXT,
        completeness TEXT,
        reserved_at TEXT NOT NULL,
        observed_at TEXT,
        UNIQUE(attempt_id,turn_id,call_id)
      );
      CREATE TABLE IF NOT EXISTS investigation_windows_app_server_launches (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        launch_id TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_windows_app_server_start_intents (
        launch_id TEXT PRIMARY KEY REFERENCES investigation_windows_app_server_launches(launch_id),
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_windows_app_server_closures (
        launch_id TEXT PRIMARY KEY REFERENCES investigation_windows_app_server_launches(launch_id),
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_windows_app_server_not_started (
        launch_id TEXT PRIMARY KEY REFERENCES investigation_windows_app_server_launches(launch_id),
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_windows_launch_settlement_facts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        launch_id TEXT NOT NULL REFERENCES investigation_windows_app_server_launches(launch_id),
        cleanup_epoch INTEGER NOT NULL,
        fact_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_windows_not_started_settlement_facts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES investigation_requests(id),
        launch_id TEXT NOT NULL REFERENCES investigation_windows_app_server_launches(launch_id),
        cleanup_epoch INTEGER NOT NULL,
        fact_json TEXT NOT NULL
      );
    `);
      this.migrateLegacyScope();
      this.migrateReadBudget();
      this.migrateReadReceipts();
      this.migrateContainerName();
      this.migrateDockerVolume();
      this.migrateWslResource();
      this.migrateLaunchProtocol();
      this.migrateSourceView();
      this.migrateWindowsSource();
      this.withTransaction(() => {
        const columns = this.db.prepare('PRAGMA table_info(investigation_model_running_facts)').all();
        if (!columns.some(column => column.name === 'native_json')) {
          this.db.exec('ALTER TABLE investigation_model_running_facts ADD COLUMN native_json TEXT');
        }
        if (!columns.some(column => column.name === 'outer_json')) {
          this.db.exec('ALTER TABLE investigation_model_running_facts ADD COLUMN outer_json TEXT');
        }
      });
      this.db.exec('PRAGMA busy_timeout=0');
    } catch (error) {
      try { this.db.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], 'SQLite constructor cleanup uncertain',
        { cause: closeError }); }
      throw error;
    }
  }

  private migrateReadBudget(): void {
    this.withTransaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investigation_read_budget'").get();
      if (existing) return;
      this.db.exec(`CREATE TABLE investigation_read_budget (
        request_id TEXT PRIMARY KEY REFERENCES investigation_requests(id),
        reserved_calls INTEGER CHECK (reserved_calls IS NULL OR reserved_calls >= 0)
      )`);
      // Legacy requests with any attempt history have unknown prior tool use.
      // Absence of a row is never interpreted as zero for an existing request.
      this.db.prepare(`INSERT INTO investigation_read_budget(request_id,reserved_calls)
        SELECT id, CASE WHEN json_array_length(json_extract(record_json, '$.attempts'))=0
          AND json_extract(record_json, '$.state')='queued'
          AND NOT EXISTS (SELECT 1 FROM investigation_active_attempts a WHERE a.request_id=investigation_requests.id)
          THEN 0 ELSE NULL END
        FROM investigation_requests
        WHERE NOT EXISTS (SELECT 1 FROM investigation_read_budget b WHERE b.request_id=investigation_requests.id)`).run();
    });
  }

  private migrateReadReceipts(): void {
    const columns = this.db.prepare('PRAGMA table_info(investigation_read_receipts)').all() as
      {name:string}[];
    if (!columns.some(column => column.name === 'worker_grant_id'))
      this.db.exec('ALTER TABLE investigation_read_receipts ADD COLUMN worker_grant_id TEXT');
  }

  private migrateContainerName(): void {
    const columns = this.db.prepare('PRAGMA table_info(investigation_active_attempts)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'container_name')) {
      this.db.exec('ALTER TABLE investigation_active_attempts ADD COLUMN container_name TEXT');
    }
    if (!columns.some(column => column.name === 'scratch_root')) {
      this.db.exec('ALTER TABLE investigation_active_attempts ADD COLUMN scratch_root TEXT');
    }
    if (!columns.some(column => column.name === 'container_id')) {
      this.db.exec('ALTER TABLE investigation_active_attempts ADD COLUMN container_id TEXT');
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS investigation_active_container_name ON investigation_active_attempts(container_name)');
  }

  private migrateDockerVolume(): void {
    const columns = this.db.prepare('PRAGMA table_info(investigation_active_attempts)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'docker_volume_json')) {
      this.db.exec('ALTER TABLE investigation_active_attempts ADD COLUMN docker_volume_json TEXT');
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS investigation_active_docker_owner
      ON investigation_active_attempts(json_extract(docker_volume_json, '$.ownerName'))`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS investigation_active_docker_reader
      ON investigation_active_attempts(json_extract(docker_volume_json, '$.readerName'))`);
  }

  private migrateWslResource(): void {
    const columns = this.db.prepare('PRAGMA table_info(investigation_active_attempts)').all() as { name: string }[];
    for (const column of ['wsl_unit_name', 'wsl_distro', 'wsl_uid', 'wsl_boot_id',
      'wsl_invocation_id', 'wsl_control_group', 'wsl_launch_gate_json']) {
      if (!columns.some(existing => existing.name === column)) {
        this.db.exec(`ALTER TABLE investigation_active_attempts ADD COLUMN ${column} ${column === 'wsl_uid' ? 'INTEGER' : 'TEXT'}`);
      }
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS investigation_active_wsl_unit_name ON investigation_active_attempts(wsl_unit_name)');
  }

  private migrateLaunchProtocol(): void {
    const columns = this.db.prepare('PRAGMA table_info(investigation_active_attempts)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'launch_protocol')) {
      this.db.exec(`ALTER TABLE investigation_active_attempts ADD COLUMN launch_protocol TEXT
        CHECK (launch_protocol IS NULL OR launch_protocol='resource_reservation_v1')`);
    }
  }

  private migrateSourceView(): void {
    const columns = this.db.prepare('PRAGMA table_info(investigation_active_attempts)').all() as { name: string }[];
    for (const column of ['source_view_json', 'source_view_closed_at']) {
      if (!columns.some(existing => existing.name === column)) {
        this.db.exec(`ALTER TABLE investigation_active_attempts ADD COLUMN ${column} TEXT`);
      }
    }
  }

  private migrateWindowsSource(): void {
    const columns = this.db.prepare('PRAGMA table_info(investigation_active_attempts)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'windows_source_json')) {
      this.db.exec('ALTER TABLE investigation_active_attempts ADD COLUMN windows_source_json TEXT');
    }
  }

  private migrateLegacyScope(): void {
    const columns = this.db.prepare('PRAGMA table_info(investigation_requests)').all() as { name: string }[];
    const indexes = this.db.prepare('PRAGMA index_list(investigation_requests)').all() as
      { name: string; unique: number }[];
    const hasUniqueScope = (scope: string[]): boolean => indexes.some(index => index.unique === 1 &&
      JSON.stringify((this.db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(index.name) as { name: string }[]).map(column => column.name)) === JSON.stringify(scope));
    const currentScope = ['principal', 'audience', 'workspace_id', 'operation', 'idempotency_key'];
    if (columns.some(column => column.name === 'operation')) {
      if (!hasUniqueScope(currentScope)) throw new Error('Unsupported investigation idempotency scope; explicit migration required');
      return;
    }
    const expected = ['id', 'workspace_id', 'collaboration_id', 'principal', 'audience',
      'idempotency_key', 'fingerprint', 'record_json'];
    if (columns.length !== expected.length || columns.some(column => !expected.includes(column.name))) {
      throw new Error('Unsupported investigation schema; explicit migration required');
    }
    const legacyScope = ['workspace_id', 'collaboration_id', 'principal', 'audience', 'idempotency_key'];
    if (!hasUniqueScope(legacyScope)) throw new Error('Unsupported investigation idempotency scope; explicit migration required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ambiguous = this.db.prepare(`SELECT 1 FROM investigation_requests
        GROUP BY principal,audience,workspace_id,idempotency_key HAVING COUNT(*)>1 LIMIT 1`).get();
      if (ambiguous) throw new StoreConflict();
      this.db.exec(`ALTER TABLE investigation_requests
        ADD COLUMN operation TEXT NOT NULL DEFAULT 'investigate.submit';
        CREATE UNIQUE INDEX investigation_scope_v2 ON investigation_requests
          (principal,audience,workspace_id,operation,idempotency_key);`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  enqueue(record: InvestigationRecord, key: string, fingerprint: string): InvestigationRecord {
    if (!key || !fingerprint) throw new TypeError('Incomplete investigation idempotency input');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`SELECT fingerprint,record_json FROM investigation_requests
        WHERE principal=? AND audience=? AND workspace_id=? AND operation='investigate.submit' AND idempotency_key=?`)
        .get(record.principal, record.audience, record.workspaceId, key) as
        { fingerprint: string; record_json: string } | undefined;
      if (existing) {
        const saved = JSON.parse(existing.record_json) as InvestigationRecord;
        if (existing.fingerprint !== fingerprint || saved.collaborationId !== record.collaborationId ||
          saved.workingCopyId !== record.workingCopyId) throw new StoreConflict();
        this.requireGrant(saved, saved.grantId, 'investigation.request');
        if (!this.hasReadScope(saved, [...saved.scope.paths, ...saved.scope.relatedTests])) throw new Error('NOT_AVAILABLE');
        this.db.exec('COMMIT');
        return saved;
      }
      this.requireGrant(record, record.grantId, 'investigation.request');
      if (!this.hasReadScope(record, [...record.scope.paths, ...record.scope.relatedTests])) throw new Error('NOT_AVAILABLE');
      this.db.prepare(`INSERT INTO investigation_requests
        (id,workspace_id,collaboration_id,principal,audience,operation,idempotency_key,fingerprint,record_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(record.id, record.workspaceId, record.collaborationId,
        record.principal, record.audience, 'investigate.submit', key, fingerprint, JSON.stringify(record));
      this.db.prepare('INSERT INTO investigation_read_budget(request_id,reserved_calls) VALUES (?,0)').run(record.id);
      this.db.prepare(`INSERT INTO investigation_outbox(request_id,workspace_id,collaboration_id,created_at)
        VALUES (?,?,?,?)`).run(record.id, record.workspaceId, record.collaborationId, record.createdAt);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireGrant(record: InvestigationRecord, grantId: string, permission: string): void {
    const grant = this.db.prepare(`SELECT principal,audience,workspace_id,collaboration_id,recipient,
        permissions_json,expires_at,revoked_at FROM grants WHERE id=?`).get(grantId) as {
          principal: string; audience: string; workspace_id: string; collaboration_id: string | null;
          recipient: string | null; permissions_json: string; expires_at: string | null; revoked_at: string | null;
        } | undefined;
    if (!grant || grant.principal !== record.principal || grant.audience !== record.audience ||
      grant.workspace_id !== record.workspaceId || (grant.collaboration_id !== null && grant.collaboration_id !== record.collaborationId) ||
      grant.recipient !== record.recipient || grant.revoked_at !== null ||
      (grant.expires_at !== null && !(Date.parse(grant.expires_at) > Date.now())) ||
      !(JSON.parse(grant.permissions_json) as string[]).includes(permission)) throw new Error('NOT_AVAILABLE');
  }

  /** Called only inside a write transaction so grant revocation and publication serialize. */
  private hasReadScope(record: InvestigationRecord, paths: readonly string[]): boolean {
    if (!Array.isArray(paths)) return false;
    const rows = this.db.prepare(`SELECT collaboration_id,recipient,permissions_json,data_paths_json,expires_at,revoked_at
      FROM grants WHERE principal=? AND audience=? AND workspace_id=?`)
      .all(record.principal, record.audience, record.workspaceId) as {
        collaboration_id: string | null; recipient: string | null; permissions_json: string;
        data_paths_json: string | null; expires_at: string | null; revoked_at: string | null;
      }[];
    const now = Date.now();
    const allowed: string[] = [];
    for (const row of rows) {
      if ((row.collaboration_id !== null && row.collaboration_id !== record.collaborationId) ||
        row.recipient !== record.recipient || row.revoked_at !== null ||
        (row.expires_at !== null && !(Date.parse(row.expires_at) > now))) continue;
      try {
        if (!(JSON.parse(row.permissions_json) as unknown[]).includes('data.read')) continue;
        const dataPaths: unknown = row.data_paths_json === null ? null : JSON.parse(row.data_paths_json);
        if (validDataPaths(dataPaths)) allowed.push(...dataPaths);
      } catch { continue; }
    }
    return allowed.length > 0 && paths.every(path => isDataPathPermitted(path, allowed));
  }

  get(id: string): InvestigationRecord | null {
    const row = this.db.prepare('SELECT record_json FROM investigation_requests WHERE id=?').get(id) as
      { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as InvestigationRecord : null;
  }

  listPending(): PendingInvestigation[] {
    const rows = this.db.prepare(`SELECT request_id,workspace_id,collaboration_id
      FROM investigation_outbox ORDER BY created_at,request_id`).all() as
      { request_id: string; workspace_id: string; collaboration_id: string }[];
    return rows.map(row => ({ requestId: row.request_id, workspaceId: row.workspace_id,
      collaborationId: row.collaboration_id }));
  }

  /** Recovery inventory from durable state, including unknown starts that still hold slots. */
  listUnsettled(): InvestigationClaim[] {
    const rows = this.db.prepare(`SELECT request_id,attempt_id,worker_id,worker_epoch,workspace_id,native_ref,container_name,container_id,scratch_root,docker_volume_json,
      wsl_unit_name,wsl_distro,wsl_uid,wsl_boot_id,wsl_invocation_id,wsl_control_group,wsl_launch_gate_json,source_view_json,source_view_closed_at,windows_source_json,phase,launch_protocol
      FROM investigation_active_attempts ORDER BY request_id`).all() as unknown as ({
        request_id: string; attempt_id: string; worker_id: string; worker_epoch: number;
        workspace_id: string; native_ref: string | null; container_name: string | null; container_id: string | null;
        scratch_root: string | null; phase: InvestigationClaim['phase']; launch_protocol: 'resource_reservation_v1' | null;
      } & WslResourceRow & SourceViewRow & WindowsSourceRow & DockerVolumeRow)[];
    return rows.map(row => {
      const wslResource = wslResourceFromRow(row);
      const sourceView = sourceViewFromRow(row);
      const windowsSource = windowsSourceFromRow(row);
      const dockerVolume = dockerVolumeFromRow(row);
      if (dockerVolume && (row.container_name !== null || row.container_id !== null ||
        row.scratch_root !== null || row.native_ref !== null || wslResource || sourceView || windowsSource)) throw new StoreConflict();
      if (sourceView && (sourceView.descriptor.attemptId !== row.attempt_id ||
        sourceView.descriptor.workspaceId !== row.workspace_id ||
        sourceView.descriptor.workerEpoch > row.worker_epoch)) throw new StoreConflict();
      if (windowsSource && (windowsSource.descriptor.attemptId !== row.attempt_id ||
        windowsSource.descriptor.workspaceId !== row.workspace_id ||
        windowsSource.descriptor.workerEpoch > row.worker_epoch || sourceView || wslResource ||
        row.container_name !== null || row.container_id !== null || row.scratch_root !== null)) throw new StoreConflict();
      return { requestId: row.request_id, attemptId: row.attempt_id, workerId: row.worker_id,
      workerEpoch: row.worker_epoch, workspaceId: row.workspace_id, nativeRef: row.native_ref,
      launchProtocol: row.launch_protocol,
      ...(row.container_name === null ? {} : { containerName: row.container_name }),
      ...(row.container_id === null ? {} : { containerId: row.container_id }),
      ...(row.scratch_root === null ? {} : { scratchRoot: row.scratch_root }),
      ...(dockerVolume === undefined ? {} : { dockerVolume }),
      ...(wslResource === undefined ? {} : { wslResource }),
      ...(sourceView === undefined ? {} : { sourceView }),
      ...(windowsSource === undefined ? {} : { windowsSource }), phase: row.phase };
    });
  }

  private nativeJournalBinding(claim: InvestigationClaim, collaborationId: string): void {
    this.activeFor(claim);
    const request = this.db.prepare(`SELECT workspace_id,collaboration_id FROM investigation_requests WHERE id=?`)
      .get(claim.requestId) as { workspace_id: string; collaboration_id: string } | undefined;
    if (!request || request.workspace_id !== claim.workspaceId ||
      request.collaboration_id !== collaborationId) throw new StoreConflict();
  }

  /** A single durable create intent precedes any Windows App Server process creation. */
  beginWindowsAppServerLaunch(claim: InvestigationClaim, binding: CurrentWindowsAppServerLaunchBinding,
    now: Date): CurrentWindowsAppServerLaunchRecord {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !validActiveWindowsAppServerLaunchBinding(binding)) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const started=performance.now();
      const canonical=structuredClone(binding);
      this.requireWindowsLaunchSourceAuthority(claim,canonical,now);
      if (this.db.prepare('SELECT 1 FROM investigation_windows_app_server_launches WHERE attempt_id=?')
        .get(claim.attemptId) || this.db.prepare('SELECT 1 FROM investigation_native_threads WHERE attempt_id=?')
        .get(claim.attemptId)) throw new StoreConflict();
      const launch:CurrentWindowsAppServerLaunchRecord={launchId:randomUUID(),requestId:claim.requestId,
        attemptId:claim.attemptId,workspaceId:claim.workspaceId,
        collaborationId:canonical.collaborationId,launchWorkerId:claim.workerId,
        launchEpoch:claim.workerEpoch,binding:canonical,state:'intent',identity:null,
        intentAt:now.toISOString(),observedAt:null,recoveryRequiredAt:null};
      if (this.claimAuthority?.verifyWindowsLaunch?.(structuredClone(claim),
        structuredClone(launch))!==true) throw new Error('NOT_AVAILABLE');
      const checkedAt=new Date(now.getTime()+Math.ceil(performance.now()-started));
      this.requireWindowsLaunchSourceAuthority(claim,canonical,checkedAt);
      if (this.db.prepare('SELECT 1 FROM investigation_windows_app_server_launches WHERE attempt_id=?')
        .get(claim.attemptId)) throw new StoreConflict();
      this.db.prepare(`INSERT INTO investigation_windows_app_server_launches
        (attempt_id,request_id,launch_id,record_json) VALUES (?,?,?,?)`)
        .run(claim.attemptId,claim.requestId,launch.launchId,JSON.stringify(launch));
      const startIntent:WindowsLaunchStartIntent={kind:'windows_app_server_start_intent_v1',
        launchId:launch.launchId,reservedAt:launch.intentAt,consumedAt:null};
      this.db.prepare(`INSERT INTO investigation_windows_app_server_start_intents
        (launch_id,record_json) VALUES (?,?)`).run(launch.launchId,JSON.stringify(startIntent));
      return structuredClone(launch);
    });
  }

  /** Current owner can inspect a prior launch after cleanup takeover; no grant is implied. */
  getWindowsLaunch(claim: InvestigationClaim): WindowsAppServerLaunchRecord | null {
    this.activeFor(claim);
    const launch=this.readWindowsLaunch(claim.attemptId);
    if (!launch) return null;
    const record=this.get(claim.requestId);
    if (!record || launch.requestId!==claim.requestId || launch.workspaceId!==claim.workspaceId ||
      launch.collaborationId!==record.collaborationId) throw new StoreConflict();
    return structuredClone(launch);
  }

  /** Persist a late exact process identity even if source authority or ownership has gone away. */
  recordWindowsLaunchObservation(original: WindowsAppServerLaunchRecord,
    identity: WindowsAppServerProcessIdentity, now: Date): WindowsAppServerLaunchRecord {
    if (!validWindowsAppServerLaunchRecord(original) ||
      !validWindowsAppServerProcessIdentity(identity,original.binding) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const saved=this.readWindowsLaunch(original.attemptId);
      if (!saved || !sameWindowsAppServerLaunchOrigin(saved,original) ||
        this.readWindowsLaunchNotStarted(saved.launchId) ||
        (saved.identity && JSON.stringify(saved.identity)!==JSON.stringify(identity))) throw new StoreConflict();
      if (saved.identity) return structuredClone(saved);
      const updated:WindowsAppServerLaunchRecord={...saved,identity:structuredClone(identity),
        observedAt:now.toISOString(),state:saved.state==='recovery_required'?'recovery_required':'observed'};
      this.db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
        WHERE attempt_id=? AND launch_id=?`).run(JSON.stringify(updated),saved.attemptId,saved.launchId);
      return structuredClone(updated);
    });
  }

  /** Unknown outcome is monotonic; a later observation cannot restore launch usability. */
  markWindowsLaunchRecoveryRequired(original: WindowsAppServerLaunchRecord,
    now: Date): WindowsAppServerLaunchRecord {
    if (!validWindowsAppServerLaunchRecord(original) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const saved=this.readWindowsLaunch(original.attemptId);
      if (!saved || !sameWindowsAppServerLaunchOrigin(saved,original)) throw new StoreConflict();
      if (saved.state==='recovery_required') return structuredClone(saved);
      const updated:WindowsAppServerLaunchRecord={...saved,state:'recovery_required',
        recoveryRequiredAt:now.toISOString()};
      this.db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
        WHERE attempt_id=? AND launch_id=?`).run(JSON.stringify(updated),saved.attemptId,saved.launchId);
      return structuredClone(updated);
    });
  }

  /** An owned helper transcript may append a closure fact after revocation or takeover. */
  recordWindowsLaunchClosure(original: WindowsAppServerLaunchRecord,
    observation: WindowsAppServerClosureObservation, now: Date): WindowsAppServerClosureRecord {
    if (!validWindowsAppServerLaunchRecord(original) ||
      !validWindowsAppServerClosureObservation(observation) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    const frozenOriginal=structuredClone(original);
    const canonical=structuredClone(observation);
    return this.withTransaction(() => {
      const saved=this.readWindowsLaunch(frozenOriginal.attemptId);
      if (!saved || !sameWindowsAppServerLaunchOrigin(saved,frozenOriginal) || !saved.identity ||
        this.readWindowsLaunchNotStarted(saved.launchId) ||
        saved.launchId!==canonical.launchId ||
        saved.binding.hostScopeId!==canonical.hostScopeId ||
        saved.binding.executionInstanceId!==canonical.executionInstanceId ||
        saved.identity.pid!==canonical.root.pid ||
        saved.identity.creationFiletime!==canonical.root.creationFiletime ||
        saved.identity.hostScopeId!==canonical.hostScopeId ||
        saved.identity.executionInstanceId!==canonical.executionInstanceId)
        throw new StoreConflict();
      const authorityLaunch=structuredClone(saved);
      Object.freeze(authorityLaunch.binding);
      if (authorityLaunch.identity) Object.freeze(authorityLaunch.identity);
      Object.freeze(authorityLaunch);
      const authorityObservation=structuredClone(canonical);
      Object.freeze(authorityObservation.root);
      Object.freeze(authorityObservation.members.pids);
      Object.freeze(authorityObservation.members);
      Object.freeze(authorityObservation);
      if (this.claimAuthority?.verifyWindowsLaunchClosure?.(authorityLaunch,
        authorityObservation)!==true) throw new Error('NOT_AVAILABLE');
      const current=this.readWindowsLaunch(frozenOriginal.attemptId);
      if (!current || !sameWindowsAppServerLaunchOrigin(current,saved) ||
        !isDeepStrictEqual(current.identity,saved.identity)) throw new StoreConflict();
      const prior=this.readWindowsLaunchClosure(saved.launchId);
      if (prior) {
        if (!isDeepStrictEqual(prior.observation,canonical)) throw new StoreConflict();
        return this.freezeWindowsLaunchClosure(prior);
      }
      const record:WindowsAppServerClosureRecord={launchId:saved.launchId,
        observation:canonical,recordedAt:now.toISOString()};
      this.db.prepare(`INSERT INTO investigation_windows_app_server_closures
        (launch_id,record_json) VALUES (?,?)`).run(saved.launchId,JSON.stringify(record));
      return this.freezeWindowsLaunchClosure(record);
    });
  }

  /** Read-only recovery fact; the current owner is checked without requiring a fresh source grant. */
  getWindowsLaunchClosure(claim: InvestigationClaim): WindowsAppServerClosureRecord | null {
    return this.withTransaction(() => {
      const launch=this.getWindowsLaunch(claim);
      if (!launch) return null;
      const closure=this.readWindowsLaunchClosure(launch.launchId);
      if (!closure) return null;
      if (!launch.identity ||
        closure.observation.hostScopeId!==launch.binding.hostScopeId ||
        closure.observation.executionInstanceId!==launch.binding.executionInstanceId ||
        closure.observation.root.pid!==launch.identity.pid ||
        closure.observation.root.creationFiletime!==launch.identity.creationFiletime)
        throw new StoreConflict();
      return this.freezeWindowsLaunchClosure(closure);
    });
  }

  private readWindowsLaunchClosure(launchId: string): WindowsAppServerClosureRecord | null {
    const row=this.db.prepare(`SELECT record_json FROM investigation_windows_app_server_closures
      WHERE launch_id=?`).get(launchId) as {record_json:string}|undefined;
    if (!row) return null;
    let parsed:unknown;
    try {parsed=JSON.parse(row.record_json);} catch {throw new StoreConflict();}
    if (!validWindowsAppServerClosureRecord(parsed) || parsed.launchId!==launchId)
      throw new StoreConflict();
    return parsed;
  }

  private freezeWindowsLaunchClosure(record: WindowsAppServerClosureRecord):
    WindowsAppServerClosureRecord {
    const copy=structuredClone(record);
    Object.freeze(copy.observation.root);
    Object.freeze(copy.observation.members.pids);
    Object.freeze(copy.observation.members);
    Object.freeze(copy.observation);
    return Object.freeze(copy);
  }

  /** An owned no-child transcript may be saved after revocation; it grants no start or RPC. */
  recordWindowsLaunchNotStarted(original: WindowsAppServerLaunchRecord,
    observation: WindowsAppServerNotStartedObservation, now: Date): WindowsAppServerNotStartedRecord {
    if (!validWindowsAppServerLaunchRecord(original) ||
      !validCurrentWindowsAppServerLaunchBinding(original.binding) || original.identity!==null ||
      !validWindowsAppServerNotStartedObservation(observation) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    const expected=structuredClone(original), canonical=structuredClone(observation);
    return this.withTransaction(() => {
      const existing=this.readWindowsLaunch(expected.attemptId);
      const existingFact=this.readWindowsLaunchNotStarted(expected.launchId);
      if (existingFact) {
        const intent=this.readWindowsLaunchStartIntent(expected.launchId);
        if (!existing || !sameWindowsAppServerLaunchOrigin(existing,expected) ||
          existing.identity!==null || !intent || intent.reservedAt!==existing.intentAt ||
          this.readWindowsLaunchClosure(existing.launchId) ||
          this.db.prepare('SELECT 1 FROM investigation_native_threads WHERE attempt_id=?')
            .get(existing.attemptId) ||
          this.db.prepare('SELECT 1 FROM investigation_native_turns WHERE attempt_id=?')
            .get(existing.attemptId) ||
          !isDeepStrictEqual(existingFact.observation,canonical)) throw new StoreConflict();
        return structuredClone(existingFact);
      }
      if (!validActiveWindowsAppServerLaunchBinding(expected.binding)) throw new Error('INVALID_ARGUMENT');
      const before=existing;
      const beforeIntent=this.readWindowsLaunchStartIntent(expected.launchId);
      const exact=():WindowsAppServerLaunchRecord => {
        const saved=this.readWindowsLaunch(expected.attemptId);
        const intent=this.readWindowsLaunchStartIntent(expected.launchId);
        if (!saved || !sameWindowsAppServerLaunchOrigin(saved,expected) ||
          !isDeepStrictEqual(saved,before) || saved.identity!==null ||
          !['intent','recovery_required'].includes(saved.state) ||
          !intent || !isDeepStrictEqual(intent,beforeIntent) ||
          intent.reservedAt!==saved.intentAt ||
          this.readWindowsLaunchClosure(saved.launchId) ||
          this.db.prepare('SELECT 1 FROM investigation_native_threads WHERE attempt_id=?')
            .get(saved.attemptId) ||
          this.db.prepare('SELECT 1 FROM investigation_native_turns WHERE attempt_id=?')
            .get(saved.attemptId) ||
          canonical.launchId!==saved.launchId ||
          canonical.hostScopeId!==saved.binding.hostScopeId ||
          canonical.executionInstanceId!==saved.binding.executionInstanceId)
          throw new StoreConflict();
        return saved;
      };
      const saved=exact();
      const authorityLaunch=structuredClone(saved);
      Object.freeze(authorityLaunch.binding);Object.freeze(authorityLaunch);
      const authorityObservation=structuredClone(canonical);
      Object.freeze(authorityObservation.helper);
      Object.freeze(authorityObservation.prepared);
      Object.freeze(authorityObservation.preparedClosed.members.pids);
      Object.freeze(authorityObservation.preparedClosed.members);
      Object.freeze(authorityObservation.preparedClosed);
      Object.freeze(authorityObservation);
      if (this.claimAuthority?.verifyWindowsLaunchNotStarted?.(authorityLaunch,
        authorityObservation)!==true) throw new Error('NOT_AVAILABLE');
      exact();
      if (this.readWindowsLaunchNotStarted(saved.launchId)) throw new StoreConflict();
      const record:WindowsAppServerNotStartedRecord={launchId:saved.launchId,
        observation:canonical,recordedAt:now.toISOString()};
      this.db.prepare(`INSERT INTO investigation_windows_app_server_not_started
        (launch_id,record_json) VALUES (?,?)`).run(saved.launchId,JSON.stringify(record));
      if (saved.state!=='recovery_required') {
        this.db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
          WHERE launch_id=?`).run(JSON.stringify({...saved,state:'recovery_required',
            recoveryRequiredAt:now.toISOString()}),saved.launchId);
      }
      return structuredClone(record);
    });
  }

  getWindowsLaunchNotStarted(claim: InvestigationClaim): WindowsAppServerNotStartedRecord | null {
    return this.withTransaction(() => {
      const launch=this.getWindowsLaunch(claim);
      if (!launch) return null;
      const fact=this.readWindowsLaunchNotStarted(launch.launchId);
      return fact ? structuredClone(fact) : null;
    });
  }

  private readWindowsLaunchNotStarted(launchId:string):WindowsAppServerNotStartedRecord|null {
    const row=this.db.prepare(`SELECT record_json FROM investigation_windows_app_server_not_started
      WHERE launch_id=?`).get(launchId) as {record_json:string}|undefined;
    if (!row) return null;
    let parsed:unknown;try{parsed=JSON.parse(row.record_json);}catch{throw new StoreConflict();}
    if(!validWindowsAppServerNotStartedRecord(parsed)||parsed.launchId!==launchId)throw new StoreConflict();
    return parsed;
  }

  assertWindowsLaunchUsable(claim: InvestigationClaim, launchId: string, now: Date): void {
    this.withTransaction(() => {this.requireWindowsLaunchUsable(claim,launchId,now);});
  }

  /** Read-only fact for the exact current owner; it does not authorize another start. */
  getWindowsLaunchStartIntent(claim: InvestigationClaim): WindowsLaunchStartIntent | null {
    return this.withTransaction(() => {
      const launch=this.getWindowsLaunch(claim);
      if (!launch) return null;
      const intent=this.readWindowsLaunchStartIntent(launch.launchId);
      return intent ? structuredClone(intent) : null;
    });
  }

  /** Persist consumption before one synchronous external start; neither phase can replay it. */
  dispatchWindowsLaunchStartOnce(claim: InvestigationClaim,
    original: CurrentWindowsAppServerLaunchRecord, now: Date, emitStart: () => void): void {
    if (!validWindowsAppServerLaunchRecord(original) ||
      !validActiveWindowsAppServerLaunchBinding(original.binding) ||
      original.state!=='intent' || original.identity!==null ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      typeof emitStart!=='function' || types.isAsyncFunction(emitStart))
      throw new Error('INVALID_ARGUMENT');
    const owner=structuredClone(claim), expected=structuredClone(original);
    const at=new Date(now.getTime());
    const dispatchStarted=performance.now();
    const consumed=this.withTransaction(() => {
      this.requireWindowsLaunchStartEligible(owner,expected,at,dispatchStarted);
      const intent=this.readWindowsLaunchStartIntent(expected.launchId);
      if (!intent || intent.reservedAt!==expected.intentAt || intent.consumedAt!==null)
        throw new StoreConflict();
      const updated:WindowsLaunchStartIntent={...intent,consumedAt:at.toISOString()};
      this.db.prepare(`UPDATE investigation_windows_app_server_start_intents SET record_json=?
        WHERE launch_id=?`).run(JSON.stringify(updated),expected.launchId);
      return updated;
    });
    try {
      this.withTransaction(() => {
        this.requireWindowsLaunchStartEligible(owner,expected,at,dispatchStarted);
        const saved=this.readWindowsLaunchStartIntent(expected.launchId);
        if (!saved || !isDeepStrictEqual(saved,consumed)) throw new StoreConflict();
        const result:unknown=emitStart();
        if (result!==undefined) {
          if (types.isPromise(result)) Promise.prototype.then.call(result,undefined,()=>undefined);
          throw new Error('INVALID_ARGUMENT');
        }
      });
    } catch (error) {
      try { this.markWindowsLaunchRecoveryRequired(expected,at); }
      catch (markError) { throw new AggregateError([error,markError],
        'Windows start failed and recovery marking failed',{cause:markError}); }
      throw error;
    }
  }

  private readWindowsLaunchStartIntent(launchId: string): WindowsLaunchStartIntent | null {
    const row=this.db.prepare(`SELECT record_json FROM investigation_windows_app_server_start_intents
      WHERE launch_id=?`).get(launchId) as {record_json:string}|undefined;
    if (!row) return null;
    let parsed:unknown;
    try { parsed=JSON.parse(row.record_json); } catch { throw new StoreConflict(); }
    if (!validWindowsLaunchStartIntent(parsed) || parsed.launchId!==launchId) throw new StoreConflict();
    return parsed;
  }

  private requireWindowsLaunchStartEligible(claim: InvestigationClaim,
    expected: CurrentWindowsAppServerLaunchRecord, now: Date, started: number): void {
    const currentAt=()=>new Date(now.getTime()+Math.ceil(performance.now()-started));
    const exact=() => {
      const saved=this.readWindowsLaunch(claim.attemptId);
      if (!saved || !isDeepStrictEqual(saved,expected) || saved.state!=='intent' || saved.identity!==null ||
        !validActiveWindowsAppServerLaunchBinding(saved.binding) ||
        this.readWindowsLaunchClosure(expected.launchId) ||
        this.readWindowsLaunchNotStarted(expected.launchId) ||
        this.db.prepare('SELECT 1 FROM investigation_native_threads WHERE attempt_id=?')
          .get(claim.attemptId) ||
        this.db.prepare('SELECT 1 FROM investigation_native_turns WHERE attempt_id=?')
          .get(claim.attemptId)) throw new StoreConflict();
    };
    exact();
    this.requireWindowsLaunchSourceAuthority(claim,expected.binding,currentAt());
    if (this.claimAuthority?.verifyWindowsLaunch?.(structuredClone(claim),
      structuredClone(expected))!==true) throw new Error('NOT_AVAILABLE');
    this.requireWindowsLaunchSourceAuthority(claim,expected.binding,currentAt());
    exact();
  }

  /** Internal owner send mechanism, not a launch qualification or permission grant.
   * The callback must perform its one synchronous send in this transaction.
   * Throwing cannot recall externally accepted bytes; the owner must fail-stop. */
  sendWindowsLaunchControl(claim: InvestigationClaim,
    original: CurrentWindowsAppServerLaunchRecord, now: Date, emit: () => void): void {
    if (!validWindowsAppServerLaunchRecord(original) ||
      !validActiveWindowsAppServerLaunchBinding(original.binding) ||
      original.state!=='observed' || !original.identity ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      typeof emit!=='function' || types.isAsyncFunction(emit)) throw new Error('INVALID_ARGUMENT');
    const owner=structuredClone(claim);
    const expected=structuredClone(original);
    const checkedAt=new Date(now.getTime());
    this.withTransaction(() => {
      const exact=()=>{
        const saved=this.readWindowsLaunch(owner.attemptId);
        if (!saved || !sameWindowsAppServerLaunchOrigin(saved,expected) ||
          !isDeepStrictEqual(saved.identity,expected.identity)) throw new StoreConflict();
      };
      exact();
      this.requireWindowsLaunchUsable(owner,expected.launchId,checkedAt);
      exact();
      // No await, queue, fallback, or second authority transaction after this point.
      const result:unknown=emit();
      if (result!==undefined) {
        // Reject asynchronous acceptance without invoking an arbitrary thenable.
        if (types.isPromise(result)) Promise.prototype.then.call(result,undefined,()=>undefined);
        throw new Error('INVALID_ARGUMENT');
      }
    });
  }

  private readWindowsLaunch(attemptId: string): WindowsAppServerLaunchRecord | null {
    const row=this.db.prepare(`SELECT record_json FROM investigation_windows_app_server_launches
      WHERE attempt_id=?`).get(attemptId) as {record_json:string}|undefined;
    if (!row) return null;
    let parsed:unknown;
    try {parsed=JSON.parse(row.record_json);} catch {throw new StoreConflict();}
    if (!validWindowsAppServerLaunchRecord(parsed) || parsed.attemptId!==attemptId)
      throw new StoreConflict();
    return parsed;
  }

  private requireWindowsLaunchSourceAuthority(claim: InvestigationClaim,
    binding: WindowsAppServerLaunchBinding, now: Date): void {
    const active=this.activeFor(claim);
    const source=windowsSourceFromRow(active);
    const record=this.get(claim.requestId);
    if (!source || !claim.windowsSource || JSON.stringify(source)!==JSON.stringify(claim.windowsSource) ||
      source.preparedAt===null || source.descriptor.sourceDigest!==binding.sourceDigest ||
      source.descriptor.workerEpoch!==claim.workerEpoch ||
      active.profile_revision!==binding.profileRevision ||
      active.permission_epoch!==binding.permissionEpoch ||
      active.launch_protocol!=='resource_reservation_v1' || active.phase!=='start_intent' ||
      claim.phase!=='start_intent' || active.native_ref!==null || claim.nativeRef!==null ||
      active.container_name!==null || active.container_id!==null || active.scratch_root!==null ||
      wslResourceFromRow(active) || sourceViewFromRow(active) ||
      !record || record.collaborationId!==binding.collaborationId) throw new StoreConflict();
    const selected=[...new Set([...record.scope.paths,...record.scope.relatedTests])].sort();
    this.requireCurrentSourceAuthority(claim,active,now,selected);
  }

  private requireWindowsLaunchUsable(claim: InvestigationClaim, launchId: string, now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      typeof launchId!=='string' || !launchId) throw new Error('INVALID_ARGUMENT');
    const saved=this.readWindowsLaunch(claim.attemptId);
    if (!saved || saved.launchId!==launchId || saved.requestId!==claim.requestId ||
      saved.workspaceId!==claim.workspaceId || saved.launchWorkerId!==claim.workerId ||
      saved.launchEpoch!==claim.workerEpoch || saved.state!=='observed' || !saved.identity)
      throw new StoreConflict();
    if (!validActiveWindowsAppServerLaunchBinding(saved.binding)) throw new StoreConflict();
    const startIntent=this.readWindowsLaunchStartIntent(saved.launchId);
    if (!startIntent || startIntent.reservedAt!==saved.intentAt || startIntent.consumedAt===null)
      throw new StoreConflict();
    if (this.readWindowsLaunchClosure(saved.launchId) ||
      this.readWindowsLaunchNotStarted(saved.launchId)) throw new StoreConflict();
    const started=performance.now();
    this.requireWindowsLaunchSourceAuthority(claim,saved.binding,now);
    const qualified:CurrentWindowsAppServerLaunchRecord={...saved,binding:saved.binding};
    if (this.claimAuthority?.verifyWindowsLaunch?.(structuredClone(claim),
      structuredClone(qualified))!==true) throw new Error('NOT_AVAILABLE');
    const checkedAt=new Date(now.getTime()+Math.ceil(performance.now()-started));
    this.requireWindowsLaunchSourceAuthority(claim,saved.binding,checkedAt);
    const current=this.readWindowsLaunch(claim.attemptId);
    if (!current || current.state!=='observed' ||
      !sameWindowsAppServerLaunchOrigin(current,saved) ||
      JSON.stringify(current.identity)!==JSON.stringify(saved.identity) ||
      !isDeepStrictEqual(this.readWindowsLaunchStartIntent(saved.launchId),startIntent) ||
      this.readWindowsLaunchClosure(saved.launchId)) throw new StoreConflict();
  }

  private nativeThreadRow(claim: InvestigationClaim, collaborationId: string):
    { worker_epoch: number; thread_id: string | null } {
    this.nativeJournalBinding(claim, collaborationId);
    const row = this.db.prepare(`SELECT worker_epoch,thread_id FROM investigation_native_threads
      WHERE attempt_id=? AND request_id=? AND workspace_id=? AND collaboration_id=?`)
      .get(claim.attemptId, claim.requestId, claim.workspaceId, collaborationId) as
      { worker_epoch: number; thread_id: string | null } | undefined;
    if (!row || row.worker_epoch !== claim.workerEpoch) throw new StoreConflict();
    return row;
  }

  private nativeTurnRow(claim: InvestigationClaim, intentId: string):
    { turn_id: string | null; state: 'intent' | 'observed' | 'terminal'; interrupt_ack: number } {
    const row = this.db.prepare(`SELECT turn_id,state,interrupt_ack FROM investigation_native_turns
      WHERE attempt_id=? AND intent_id=?`).get(claim.attemptId, intentId) as
      { turn_id: string | null; state: 'intent' | 'observed' | 'terminal'; interrupt_ack: number } | undefined;
    if (!row) throw new StoreConflict();
    return row;
  }

  /** Persist this intent before invoking thread/start. Never replay an existing intent. */
  beginNativeThreadIntent(claim: InvestigationClaim, collaborationId: string, now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      this.nativeJournalBinding(claim, collaborationId);
      const active = this.activeFor(claim);
      const record = this.get(claim.requestId);
      if (!record || active.phase !== 'start_intent' || active.native_ref !== null ||
        active.docker_volume_json !== null) throw new StoreConflict();
      const selectedPaths = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
      const launch=this.readWindowsLaunch(claim.attemptId);
      if (launch) this.requireWindowsLaunchUsable(claim,launch.launchId,now);
      if (this.db.prepare('SELECT 1 FROM investigation_native_threads WHERE attempt_id=?')
        .get(claim.attemptId)) throw new StoreConflict();
      this.db.prepare(`INSERT INTO investigation_native_threads
        (attempt_id,request_id,workspace_id,collaboration_id,worker_epoch,thread_id)
        VALUES (?,?,?,?,?,NULL)`).run(claim.attemptId, claim.requestId, claim.workspaceId,
        collaborationId, claim.workerEpoch);
    });
  }

  /** Preserve a returned native ID before checking later response fields or current permission. */
  observeNativeThread(claim: InvestigationClaim, collaborationId: string, threadId: string): void {
    if (!threadId || threadId.length > 256) throw new StoreConflict();
    this.withTransaction(() => {
      const row = this.nativeThreadRow(claim, collaborationId);
      if (row.thread_id !== null && row.thread_id !== threadId) throw new StoreConflict();
      if (row.thread_id === null) this.db.prepare(`UPDATE investigation_native_threads SET thread_id=?
        WHERE attempt_id=?`).run(threadId, claim.attemptId);
    });
  }

  /** A new native turn requires an observed thread and no unresolved prior turn. */
  beginNativeTurnIntent(claim: InvestigationClaim, collaborationId: string, intentId: string,
    expectedThreadId: string, now: Date): void {
    if (!intentId || intentId.length > 256 || !expectedThreadId || expectedThreadId.length > 256 ||
      !(now instanceof Date) ||
      !Number.isFinite(now.getTime())) throw new StoreConflict();
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      const selectedPaths = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
      const launch=this.readWindowsLaunch(claim.attemptId);
      if (launch) this.requireWindowsLaunchUsable(claim,launch.launchId,now);
      if (this.nativeThreadRow(claim, collaborationId).thread_id !== expectedThreadId ||
        this.db.prepare(`SELECT 1 FROM investigation_native_turns WHERE attempt_id=? AND state!='terminal' LIMIT 1`)
          .get(claim.attemptId) ||
        this.db.prepare(`SELECT 1 FROM investigation_native_turns WHERE attempt_id=? AND intent_id=?`)
          .get(claim.attemptId, intentId) ||
        (this.db.prepare('SELECT COUNT(*) AS count FROM investigation_native_turns WHERE attempt_id=?')
          .get(claim.attemptId) as { count: number }).count >= record.budget.maxTurns) throw new StoreConflict();
      this.db.prepare(`INSERT INTO investigation_native_turns (attempt_id,intent_id,turn_id,state)
        VALUES (?,?,NULL,'intent')`).run(claim.attemptId, intentId);
    });
  }

  observeNativeTurn(claim: InvestigationClaim, collaborationId: string, intentId: string,
    turnId: string, now: Date = new Date()): void {
    if (!turnId || turnId.length > 256) throw new StoreConflict();
    this.withTransaction(() => {
      this.nativeThreadRow(claim, collaborationId);
      const row = this.nativeTurnRow(claim, intentId);
      if (row.turn_id !== null && row.turn_id !== turnId) throw new StoreConflict();
      if (row.turn_id === null) {
        this.db.prepare(`UPDATE investigation_native_turns
          SET turn_id=?,state='observed' WHERE attempt_id=? AND intent_id=?`)
          .run(turnId, claim.attemptId, intentId);
        // The native ID is an observation even if authority has changed since turn/start.
        // Only an active original Codex owner may project public running state.
        try {
          const active = this.activeFor(claim);
          const owned = this.db.prepare(`SELECT 1 FROM investigation_codex_owned_sessions
            WHERE attempt_id=? AND request_id=? AND workspace_id=? AND worker_epoch=?
              AND closed_at IS NULL`).get(claim.attemptId, claim.requestId,
              claim.workspaceId, claim.workerEpoch);
          const record = this.get(claim.requestId);
          const attempt = record?.attempts.find(item => item.id === claim.attemptId);
          if (!owned || !record || !attempt || record.collaborationId !== collaborationId ||
            active.phase !== 'start_intent' || claim.phase !== 'start_intent' ||
            active.native_ref !== null || claim.nativeRef !== null ||
            active.container_name !== null || active.container_id !== null ||
            active.scratch_root !== null || active.docker_volume_json !== null ||
            active.wsl_unit_name !== null || active.wsl_distro !== null ||
            active.wsl_uid !== null || active.wsl_boot_id !== null ||
            active.wsl_invocation_id !== null || active.wsl_control_group !== null ||
            active.wsl_launch_gate_json !== null || active.source_view_json !== null ||
            active.source_view_closed_at !== null || active.windows_source_json !== null ||
            record.profileRef !== active.profile_revision ||
            record.budgetRef !== active.profile_revision || record.state !== 'queued' ||
            record.cancelRequested || record.result !== null ||
            record.attempts.length !== 1 || attempt.state !== 'claimed' ||
            attempt.workerEpoch !== claim.workerEpoch || attempt.nativeRef !== null ||
            attempt.startedAt !== null || attempt.finishedAt !== null ||
            attempt.terminationConfirmed) return;
          const selected = [...new Set([...record.scope.paths,...record.scope.relatedTests])].sort();
          this.requireCurrentSourceAuthority(claim, active, now, selected);
          const attempts = record.attempts.map(item => item.id === claim.attemptId ?
            {...item,state:'running' as const} : item);
          this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
            .run(JSON.stringify({...record,state:'running',attempts}),claim.requestId);
        } catch {
          // A projection failure cannot discard the already observed native identity.
          return;
        }
      }
    });
  }

  /** Exact native identity preflight before an interrupt RPC; no current source authority is needed to stop work. */
  assertNativeTurnBinding(claim: InvestigationClaim, collaborationId: string,
    intentId: string, threadId: string, turnId: string): void {
    if (!threadId || !turnId) throw new StoreConflict();
    const thread = this.nativeThreadRow(claim, collaborationId);
    const turn = this.nativeTurnRow(claim, intentId);
    if (thread.thread_id !== threadId || turn.turn_id !== turnId || turn.state !== 'observed') {
      throw new StoreConflict();
    }
  }

  /** Interrupt RPC acknowledgment is only an observation, not proof of terminal state. */
  acknowledgeNativeTurnInterrupt(claim: InvestigationClaim, collaborationId: string,
    intentId: string, turnId: string): void {
    this.withTransaction(() => {
      this.nativeThreadRow(claim, collaborationId);
      const row = this.nativeTurnRow(claim, intentId);
      if (!turnId || row.turn_id !== turnId || row.state === 'intent') throw new StoreConflict();
      this.db.prepare(`UPDATE investigation_native_turns SET interrupt_ack=1
        WHERE attempt_id=? AND intent_id=?`).run(claim.attemptId, intentId);
    });
  }

  /** Caller must have independently observed terminal state for this exact native turn. */
  observeNativeTurnTerminal(claim: InvestigationClaim, collaborationId: string,
    intentId: string, turnId: string): void {
    this.withTransaction(() => {
      this.nativeThreadRow(claim, collaborationId);
      const row = this.nativeTurnRow(claim, intentId);
      if (!turnId || row.turn_id !== turnId || row.state === 'intent') throw new StoreConflict();
      this.db.prepare(`UPDATE investigation_native_turns SET state='terminal'
        WHERE attempt_id=? AND intent_id=?`).run(claim.attemptId, intentId);
    });
  }

  /** Recovery read accepts the current claim after takeover, while writes remain bound to the launch epoch. */
  getNativeJournal(claim: InvestigationClaim, collaborationId: string): NativeInvestigationJournal | null {
    this.nativeJournalBinding(claim, collaborationId);
    const thread = this.db.prepare(`SELECT worker_epoch,thread_id FROM investigation_native_threads
      WHERE attempt_id=? AND request_id=? AND workspace_id=? AND collaboration_id=?`)
      .get(claim.attemptId, claim.requestId, claim.workspaceId, collaborationId) as
      { worker_epoch: number; thread_id: string | null } | undefined;
    if (!thread) return null;
    const turns = this.db.prepare(`SELECT intent_id,turn_id,state,interrupt_ack FROM investigation_native_turns
      WHERE attempt_id=? ORDER BY rowid`).all(claim.attemptId) as
      { intent_id: string; turn_id: string | null; state: 'intent' | 'observed' | 'terminal'; interrupt_ack: number }[];
    return { requestId: claim.requestId, attemptId: claim.attemptId, workspaceId: claim.workspaceId,
      collaborationId, workerEpoch: thread.worker_epoch,
      thread: { state: thread.thread_id === null ? 'intent' : 'observed', threadId: thread.thread_id },
      turns: turns.map(row => ({ intentId: row.intent_id, turnId: row.turn_id,
        state: row.state, interruptAcknowledged: row.interrupt_ack === 1 })) };
  }

  private hasNativeThreadIntent(attemptId: string): boolean {
    return this.db.prepare('SELECT 1 FROM investigation_native_threads WHERE attempt_id=?')
      .get(attemptId) !== undefined ||
      this.db.prepare('SELECT 1 FROM investigation_windows_app_server_launches WHERE attempt_id=?')
        .get(attemptId) !== undefined ||
      this.db.prepare('SELECT 1 FROM investigation_codex_owned_sessions WHERE attempt_id=?').get(attemptId)!==undefined;
  }

  private assertNoNativeThreadIntent(attemptId: string): void {
    if (this.hasNativeThreadIntent(attemptId)) throw new StoreConflict();
  }

  /** Commit the exact source identity before a supervisor calls WSL materialize. */
  reserveSourceView(claim: InvestigationClaim, descriptor: SourceViewDescriptor,
    privateRoot: string, now: Date, selectedPaths?: readonly string[]): InvestigationClaim {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !descriptor || Object.keys(descriptor).sort().join(',') !==
        'attemptId,bootId,distro,linuxUser,sourceDigest,uid,workerEpoch,workspaceId') throw new Error('INVALID_ARGUMENT');
    wslSourceViewSpec('status', descriptor, privateRoot);
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
      const wsl = wslResourceFromRow(active);
      if (descriptor.attemptId !== claim.attemptId || descriptor.workspaceId !== claim.workspaceId ||
        descriptor.workerEpoch !== claim.workerEpoch || now.toISOString() >= active.lease_until ||
        active.phase !== 'start_intent' || active.launch_protocol !== 'resource_reservation_v1' ||
        active.container_name !== null || active.native_ref !== null || active.windows_source_json !== null ||
        active.docker_volume_json !== null || !wsl ||
        wsl.distro !== descriptor.distro || wsl.uid !== descriptor.uid ||
        wsl.bootId !== descriptor.bootId || !wsl.gate ||
        wsl.gate.protocol !== 'attempt_gate_v1' ||
        (wsl.gate.payloadKind !== 'canary_v1' &&
          wsl.gate.payloadKind !== 'native_supervisor_v1' &&
          wsl.gate.payloadKind !== 'native_supervisor_v2') ||
        (wsl.gate.launch !== undefined &&
          (wsl.gate.launch.workerEpoch !== descriptor.workerEpoch ||
            wsl.gate.launch.sourceDigest !== descriptor.sourceDigest)) ||
        wsl.gate.linuxUser !== descriptor.linuxUser) throw new StoreConflict();
      const saved = sourceViewFromRow(active);
      if (saved) {
        if (saved.privateRoot !== privateRoot ||
          Object.keys(descriptor).some(key => descriptor[key as keyof SourceViewDescriptor] !==
            saved.descriptor[key as keyof SourceViewDescriptor])) throw new StoreConflict();
      } else {
        this.db.prepare(`UPDATE investigation_active_attempts SET source_view_json=? WHERE request_id=?`)
          .run(JSON.stringify({ descriptor, privateRoot }), claim.requestId);
      }
      return { ...claim, sourceView: saved ?? { descriptor, privateRoot, closedAt: null } };
    });
  }


  /** Reserve host-owned bytes under current authority. This is not an investigator isolation proof. */
  reserveWindowsSourceView(claim: InvestigationClaim, descriptor: WindowsSourceDescriptor,
    privateRoot: string, selectedPaths: readonly string[], now: Date): InvestigationClaim {
    if (!validWindowsSourceDescriptor(descriptor) || !validWindowsPrivateRoot(privateRoot) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
      if (descriptor.attemptId !== claim.attemptId || descriptor.workspaceId !== claim.workspaceId ||
        descriptor.workerEpoch !== claim.workerEpoch || active.phase !== 'start_intent' ||
        active.launch_protocol !== 'resource_reservation_v1' || active.native_ref !== null ||
        active.container_name !== null || active.container_id !== null || active.scratch_root !== null ||
        wslResourceFromRow(active) || sourceViewFromRow(active) || active.docker_volume_json !== null) throw new StoreConflict();
      const saved = windowsSourceFromRow(active);
      if (saved) {
        if (saved.privateRoot !== privateRoot ||
          Object.keys(descriptor).some(key => descriptor[key as keyof WindowsSourceDescriptor] !==
            saved.descriptor[key as keyof WindowsSourceDescriptor])) throw new StoreConflict();
      } else {
        this.db.prepare('UPDATE investigation_active_attempts SET windows_source_json=? WHERE request_id=?')
          .run(JSON.stringify({ descriptor, privateRoot, preparedAt: null }), claim.requestId);
      }
      return { ...claim, windowsSource: saved ?? { descriptor, privateRoot, preparedAt: null } };
    });
  }

  /** Persist a trusted supervisor's exact materialization observation, without asserting sandbox isolation. */
  confirmWindowsSourcePrepared(claim: InvestigationClaim, observation: {
    viewPath: string; sourceDigest: string; isolationVerified: false
  }, now: Date): InvestigationClaim {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const saved = windowsSourceFromRow(active);
      const submitted = claim.windowsSource;
      const record = this.get(claim.requestId);
      if (!saved || !submitted || !record ||
        JSON.stringify(submitted.descriptor) !== JSON.stringify(saved.descriptor) ||
        submitted.privateRoot !== saved.privateRoot || submitted.preparedAt !== saved.preparedAt ||
        !observation || Object.keys(observation).sort().join(',') !==
          'isolationVerified,sourceDigest,viewPath' || observation.isolationVerified !== false ||
        observation.sourceDigest !== saved.descriptor.sourceDigest ||
        observation.viewPath !== win32.join(saved.privateRoot, `${claim.attemptId}.view`) ||
        active.launch_protocol !== 'resource_reservation_v1' ||
        active.phase !== 'start_intent' || active.native_ref !== null) throw new StoreConflict();
      const selected = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
      this.requireCurrentSourceAuthority(claim, active, now, selected);
      if (saved.preparedAt === null) {
        this.db.prepare('UPDATE investigation_active_attempts SET windows_source_json=? WHERE request_id=?')
          .run(JSON.stringify({ ...saved, preparedAt: now.toISOString() }), claim.requestId);
      }
      return { ...claim, windowsSource: { ...saved, preparedAt: saved.preparedAt ?? now.toISOString() } };
    });
  }

  /** Durable staging preflight only; a future Windows launch needs a separate OS isolation gate. */
  preflightWindowsSourcePrepared(claim: InvestigationClaim, selectedPaths: readonly string[],
    expectedProfileRevision: string, expectedSourceDigest: string, now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !expectedProfileRevision ||
      !/^[0-9a-f]{64}$/.test(expectedSourceDigest)) throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      const saved = windowsSourceFromRow(active);
      const submitted = claim.windowsSource;
      if (!saved || !submitted || saved.preparedAt === null ||
        JSON.stringify(saved) !== JSON.stringify(submitted) ||
        saved.descriptor.sourceDigest !== expectedSourceDigest ||
        saved.descriptor.workerEpoch !== claim.workerEpoch ||
        active.profile_revision !== expectedProfileRevision ||
        active.launch_protocol !== 'resource_reservation_v1' || active.phase !== 'start_intent' ||
        active.native_ref !== null || active.container_name !== null || active.container_id !== null ||
        active.scratch_root !== null || active.wsl_unit_name !== null) throw new StoreConflict();
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
    });
  }

  /** The source plan's exact file selection is checked under the same write lock as its reservation. */
  private requireCurrentSourceAuthority(claim: InvestigationClaim,
    active: { lease_until: string; permission_epoch: number }, now: Date,
    selectedPaths: readonly string[] | undefined): void {
    const { record, attempt } = this.requireCurrentInvestigationAuthority(claim, active, now, selectedPaths);
    if (!['queued', 'running'].includes(record.state) ||
      !['claimed', 'running'].includes(attempt.state)) throw new StoreConflict();
  }

  private requireCurrentInvestigationAuthority(claim: InvestigationClaim,
    active: { lease_until: string; permission_epoch: number }, now: Date,
    selectedPaths: readonly string[] | undefined): {
      record: InvestigationRecord; attempt: InvestigationRecord['attempts'][number]
    } {
    const record = this.get(claim.requestId);
    const attempt = record?.attempts.find(item => item.id === claim.attemptId);
    if (!record || record.workspaceId !== claim.workspaceId || record.cancelRequested ||
      record.result !== null || !attempt || attempt.workerEpoch !== claim.workerEpoch ||
      !(Date.parse(active.lease_until) > now.getTime()) ||
      active.permission_epoch !== this.currentPermissionEpoch(record)) throw new StoreConflict();
    const expected = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
    const selected = selectedPaths ?? [];
    if (!Array.isArray(selected) || selected.length !== expected.length ||
      selected.some((path, index) => {
        try { validateRelativePath(path); } catch { return true; }
        return path !== expected[index];
      })) throw new StoreConflict();
    this.requireGrant(record, record.grantId, 'investigation.request');
    if (!this.hasReadScope(record, selected)) throw new Error('NOT_AVAILABLE');
    return { record, attempt };
  }

  /** Recheck authority before loading snapshot bytes into a trusted supervisor. */
  preflightSourceRead(claim: InvestigationClaim, selectedPaths: readonly string[], now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (active.phase !== 'start_intent' || active.native_ref !== null) throw new StoreConflict();
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
    });
  }

  /** Rechecked at every MCP read; an active worker grant never replaces the original request authority. */
  assertRunningReadAuthority(claim: InvestigationClaim, binding: RunningReadBinding, now: Date): void {
    this.withTransaction(() => this.requireRunningReadAuthority(claim, binding, now));
  }

  /** A reservation consumes one request tool call even if the subsequent read or disclosure fails. */
  reserveRunningRead(claim: InvestigationClaim, binding: RunningReadBinding,
    read: RepositoryReadBinding, now: Date): RepositoryReadReservation {
    const reservationId = randomUUID();
    this.withTransaction(() => {
      const record = this.requireRunningReadAuthority(claim, binding, now);
      if (!read || read.workspaceId !== claim.workspaceId ||
          read.collaborationId !== binding.collaborationId ||
          read.workingCopyId !== binding.workingCopyId ||
          read.snapshotId !== binding.snapshotId ||
          !binding.paths.includes(read.path)) throw new StoreConflict();
      if (!Number.isSafeInteger(record.budget.maxToolCalls) || record.budget.maxToolCalls <= 0) {
        throw new StoreConflict();
      }
      const result = this.db.prepare(`UPDATE investigation_read_budget SET reserved_calls=reserved_calls+1
        WHERE request_id=? AND reserved_calls IS NOT NULL AND reserved_calls < ?`)
        .run(claim.requestId, record.budget.maxToolCalls);
      if (result.changes !== 1) throw new StoreConflict();
      this.db.prepare(`INSERT INTO investigation_read_receipts
        (id,request_id,attempt_id,workspace_id,collaboration_id,working_copy_id,snapshot_id,
        context_revision_id,launch_epoch,native_ref,worker_principal,worker_audience,worker_recipient,
        worker_grant_id,path,status,reserved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        reservationId, claim.requestId, claim.attemptId, claim.workspaceId,
        binding.collaborationId, binding.workingCopyId, binding.snapshotId,
        record.contextRevisionId, claim.workerEpoch, claim.nativeRef!, claim.workerId,
        binding.workerAudience, binding.workerRecipient, binding.workerGrantId,
        read.path, 'reserved', now.toISOString());
    });
    return {complete: (observed) => this.completeRunningRead(claim, binding, read,
      reservationId, observed, new Date())};
  }

  private completeRunningRead(claim: InvestigationClaim, binding: RunningReadBinding,
    read: RepositoryReadBinding, reservationId: string,
    observed: RepositoryReadObservation, now: Date): string {
    return this.withTransaction(() => {
      const record = this.requireRunningReadAuthority(claim, binding, now);
      const startedAt = record.attempts.find(item => item.id === claim.attemptId)?.startedAt;
      if (!startedAt || now.getTime() >= Date.parse(startedAt) + record.budget.maxWallSeconds * 1000 ||
        !observed || observed.snapshotId !== read.snapshotId || observed.path !== read.path ||
        observed.decoding !== 'utf-8' || !['complete', 'partial'].includes(observed.completeness) ||
        !/^[0-9a-f]{64}$/.test(observed.contentHash) || typeof observed.content !== 'string' ||
        !Number.isSafeInteger(observed.byteRange?.start) ||
        !Number.isSafeInteger(observed.byteRange?.end) || observed.byteRange.start < 0 ||
        observed.byteRange.end <= observed.byteRange.start ||
        Buffer.byteLength(observed.content, 'utf8') !== observed.byteRange.end - observed.byteRange.start ||
        !Number.isSafeInteger(observed.lineRange?.start) ||
        !Number.isSafeInteger(observed.lineRange?.end) || observed.lineRange.start < 1 ||
        observed.lineRange.end < observed.lineRange.start) throw new StoreConflict();
      const result = this.db.prepare(`UPDATE investigation_read_receipts SET
        status='succeeded',full_content_hash=?,byte_start=?,byte_end=?,line_start=?,line_end=?,
        page_content_hash=?,completeness=?,observed_at=? WHERE id=? AND request_id=? AND
        attempt_id=? AND launch_epoch=? AND native_ref=? AND path=? AND status='reserved'`).run(
        observed.contentHash, observed.byteRange.start, observed.byteRange.end,
        observed.lineRange.start, observed.lineRange.end,
        createHash('sha256').update(observed.content, 'utf8').digest('hex'),
        observed.completeness, now.toISOString(), reservationId, claim.requestId,
        claim.attemptId, claim.workerEpoch, claim.nativeRef, read.path);
      if (result.changes !== 1) throw new StoreConflict();
      return reservationId;
    });
  }

  /** Read-only durable evidence; callers still validate exact snapshot bytes and authority. */
  getSucceededReadReceipts(claim: InvestigationClaim): SucceededInvestigationReadReceipt[] {
    const rows = this.db.prepare(`SELECT * FROM investigation_read_receipts WHERE
      request_id=? AND attempt_id=? AND launch_epoch=? AND native_ref=? AND status='succeeded'
      ORDER BY observed_at,id`).all(claim.requestId, claim.attemptId, claim.workerEpoch,
      claim.nativeRef) as Record<string, unknown>[];
    return rows.map(row => ({id: row.id as string, requestId: row.request_id as string,
      attemptId: row.attempt_id as string, workspaceId: row.workspace_id as string,
      collaborationId: row.collaboration_id as string, workingCopyId: row.working_copy_id as string,
      snapshotId: row.snapshot_id as string, contextRevisionId: row.context_revision_id as string,
      launchEpoch: row.launch_epoch as number, nativeRef: row.native_ref as string,
      workerPrincipal: row.worker_principal as string, workerAudience: row.worker_audience as string,
      workerRecipient: row.worker_recipient as string, path: row.path as string,
      workerGrantId: row.worker_grant_id as string,
      fullContentHash: row.full_content_hash as string,
      byteRange: [row.byte_start as number, row.byte_end as number],
      lineRange: [row.line_start as number, row.line_end as number],
      pageContentHash: row.page_content_hash as string,
      completeness: row.completeness as 'complete' | 'partial',
      reservedAt: row.reserved_at as string, observedAt: row.observed_at as string}));
  }

  private requireRunningReadAuthority(claim: InvestigationClaim, binding: RunningReadBinding, now: Date): InvestigationRecord {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !binding ||
      !binding.workerGrantId || !binding.workerAudience || !binding.workerRecipient ||
      !validDataPaths(binding.paths)) throw new Error('NOT_AVAILABLE');
    const active = this.activeFor(claim);
    const selected = [...binding.paths].sort();
    if (active.phase !== 'started' || !active.native_ref || claim.nativeRef !== active.native_ref) {
      throw new StoreConflict();
    }
    this.requireCurrentSourceAuthority(claim, active, now, selected);
    const record = this.get(claim.requestId)!;
    if (record.collaborationId !== binding.collaborationId ||
        record.workingCopyId !== binding.workingCopyId || record.snapshotRef !== binding.snapshotId ||
        claim.workerId === record.principal || binding.workerAudience === record.audience ||
        binding.workerRecipient === record.recipient) throw new StoreConflict();
    const worker = this.db.prepare(`SELECT principal,audience,recipient,workspace_id,collaboration_id,
      permissions_json,data_paths_json,expires_at,revoked_at FROM grants WHERE id=?`)
      .get(binding.workerGrantId) as { principal: string; audience: string; recipient: string | null;
        workspace_id: string; collaboration_id: string | null; permissions_json: string;
        data_paths_json: string | null; expires_at: string | null; revoked_at: string | null } | undefined;
    if (!worker || worker.principal !== claim.workerId || worker.audience !== binding.workerAudience ||
        worker.recipient !== binding.workerRecipient || worker.workspace_id !== claim.workspaceId ||
        worker.collaboration_id !== binding.collaborationId || worker.revoked_at !== null ||
        worker.expires_at === null || !(Date.parse(worker.expires_at) > now.getTime())) {
      throw new Error('NOT_AVAILABLE');
    }
    let permissions: unknown;
    let dataPaths: unknown;
    try {
      permissions = JSON.parse(worker.permissions_json);
      dataPaths = worker.data_paths_json === null ? null : JSON.parse(worker.data_paths_json);
    } catch { throw new Error('NOT_AVAILABLE'); }
    if (!Array.isArray(permissions) || permissions.length !== 1 || permissions[0] !== 'data.read' ||
        !validDataPaths(dataPaths) || JSON.stringify([...dataPaths].sort()) !== JSON.stringify(selected)) {
      throw new Error('NOT_AVAILABLE');
    }
    return record;
  }

  /** Codex App Server has a native journal but no Claude nativeRef or running fact. */
  prepareCodexReadSession(claim: InvestigationClaim, binding: RunningReadBinding,
    deadline: Date, now: Date): void {
    if (!(deadline instanceof Date) || !Number.isFinite(deadline.getTime())) throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const {record,active} = this.requireCodexReadBase(claim,binding,now);
      if (deadline.getTime() <= now.getTime() ||
        deadline.getTime() > now.getTime() + record.budget.maxWallSeconds * 1000 ||
        this.db.prepare('SELECT 1 FROM investigation_codex_read_sessions WHERE attempt_id=?')
          .get(claim.attemptId)) throw new StoreConflict();
      this.db.prepare(`INSERT INTO investigation_codex_read_sessions
        (attempt_id,request_id,workspace_id,launch_epoch,worker_id,profile_revision,binding_json,deadline_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(claim.attemptId,claim.requestId,claim.workspaceId,
        claim.workerEpoch,claim.workerId,active.profile_revision,JSON.stringify(binding),deadline.toISOString());
    });
  }

  assertCodexReadAuthority(claim: InvestigationClaim, binding: RunningReadBinding,
    turn: CodexNativeReadTurn, now: Date): void {
    this.withTransaction(() => { this.requireCodexReadAuthority(claim,binding,turn,now); });
  }

  reserveCodexRead(claim: InvestigationClaim, binding: RunningReadBinding,
    turn: CodexNativeReadTurn, callId: string, read: RepositoryReadBinding,
    now: Date): RepositoryReadReservation {
    const id=randomUUID();
    this.withTransaction(() => {
      const record=this.requireCodexReadAuthority(claim,binding,turn,now);
      if (!callId || callId.length>128 || !/^[A-Za-z0-9_.-]+$/.test(callId) ||
        !read || read.workspaceId!==claim.workspaceId ||
        read.collaborationId!==binding.collaborationId ||
        read.workingCopyId!==binding.workingCopyId || read.snapshotId!==binding.snapshotId ||
        !binding.paths.includes(read.path) ||
        this.db.prepare(`SELECT 1 FROM investigation_codex_read_receipts
          WHERE attempt_id=? AND turn_id=? AND call_id=?`).get(claim.attemptId,turn.turnId,callId))
        throw new StoreConflict();
      const debited=this.db.prepare(`UPDATE investigation_read_budget SET reserved_calls=reserved_calls+1
        WHERE request_id=? AND reserved_calls IS NOT NULL AND reserved_calls < ?`)
        .run(claim.requestId,record.budget.maxToolCalls);
      if (debited.changes!==1) throw new StoreConflict();
      this.db.prepare(`INSERT INTO investigation_codex_read_receipts
        (id,request_id,attempt_id,workspace_id,collaboration_id,working_copy_id,snapshot_id,
        context_revision_id,launch_epoch,worker_principal,worker_audience,worker_recipient,
        worker_grant_id,intent_id,thread_id,turn_id,call_id,path,status,reserved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?)`).run(id,claim.requestId,claim.attemptId,
        claim.workspaceId,binding.collaborationId,binding.workingCopyId,binding.snapshotId,
        record.contextRevisionId,claim.workerEpoch,claim.workerId,binding.workerAudience,
        binding.workerRecipient,binding.workerGrantId,turn.intentId,turn.threadId,turn.turnId,
        callId,read.path,now.toISOString());
    });
    return {complete: observed => this.completeCodexRead(claim,binding,turn,callId,read,id,observed,new Date())};
  }

  private completeCodexRead(claim: InvestigationClaim, binding: RunningReadBinding,
    turn: CodexNativeReadTurn, callId: string, read: RepositoryReadBinding, id: string,
    observed: RepositoryReadObservation, now: Date): string {
    return this.withTransaction(() => {
      this.requireCodexReadAuthority(claim,binding,turn,now);
      if (!observed || observed.snapshotId!==read.snapshotId || observed.path!==read.path ||
        observed.decoding!=='utf-8' || !['complete','partial'].includes(observed.completeness) ||
        !/^[0-9a-f]{64}$/.test(observed.contentHash) || typeof observed.content!=='string' ||
        !Number.isSafeInteger(observed.byteRange?.start) || !Number.isSafeInteger(observed.byteRange?.end) ||
        observed.byteRange.start<0 || observed.byteRange.end<=observed.byteRange.start ||
        Buffer.byteLength(observed.content,'utf8')!==observed.byteRange.end-observed.byteRange.start ||
        !Number.isSafeInteger(observed.lineRange?.start) || !Number.isSafeInteger(observed.lineRange?.end) ||
        observed.lineRange.start<1 || observed.lineRange.end<observed.lineRange.start) throw new StoreConflict();
      const result=this.db.prepare(`UPDATE investigation_codex_read_receipts SET
        status='succeeded',full_content_hash=?,byte_start=?,byte_end=?,line_start=?,line_end=?,
        page_content_hash=?,completeness=?,observed_at=? WHERE id=? AND request_id=? AND attempt_id=?
        AND launch_epoch=? AND intent_id=? AND thread_id=? AND turn_id=? AND call_id=? AND path=?
        AND status='reserved'`).run(observed.contentHash,observed.byteRange.start,observed.byteRange.end,
        observed.lineRange.start,observed.lineRange.end,
        createHash('sha256').update(observed.content,'utf8').digest('hex'),observed.completeness,
        now.toISOString(),id,claim.requestId,claim.attemptId,claim.workerEpoch,turn.intentId,
        turn.threadId,turn.turnId,callId,read.path);
      if(result.changes!==1) throw new StoreConflict();
      return id;
    });
  }

  /** The caller emits synchronously under the final SQLite authority check. */
  discloseCodexRead(claim: InvestigationClaim,binding: RunningReadBinding,
    turn: CodexNativeReadTurn,now: Date,emit:()=>void): void {
    if (typeof emit!=='function') throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {this.requireCodexReadAuthority(claim,binding,turn,now);emit();});
  }

  getSucceededCodexReadReceipts(claim: InvestigationClaim,
    turn: CodexNativeReadTurn): SucceededCodexInvestigationReadReceipt[] {
    const record=this.get(claim.requestId);
    if (!record || !turn || this.nativeThreadRow(claim,record.collaborationId).thread_id!==turn.threadId ||
      this.nativeTurnRow(claim,turn.intentId).turn_id!==turn.turnId) throw new StoreConflict();
    const session=this.db.prepare(`SELECT launch_epoch FROM investigation_codex_read_sessions
      WHERE attempt_id=? AND request_id=? AND workspace_id=?`).get(claim.attemptId,claim.requestId,
      claim.workspaceId) as {launch_epoch:number}|undefined;
    if (!session || session.launch_epoch!==claim.workerEpoch) throw new StoreConflict();
    const rows=this.db.prepare(`SELECT * FROM investigation_codex_read_receipts WHERE
      request_id=? AND attempt_id=? AND launch_epoch=? AND intent_id=? AND thread_id=? AND turn_id=?
      AND status='succeeded' ORDER BY observed_at,id`).all(claim.requestId,claim.attemptId,
      claim.workerEpoch,turn.intentId,turn.threadId,turn.turnId) as Record<string,unknown>[];
    return rows.map(row=>({id:row.id as string,requestId:row.request_id as string,
      attemptId:row.attempt_id as string,workspaceId:row.workspace_id as string,
      collaborationId:row.collaboration_id as string,workingCopyId:row.working_copy_id as string,
      snapshotId:row.snapshot_id as string,contextRevisionId:row.context_revision_id as string,
      launchEpoch:row.launch_epoch as number,workerPrincipal:row.worker_principal as string,
      workerAudience:row.worker_audience as string,workerRecipient:row.worker_recipient as string,
      workerGrantId:row.worker_grant_id as string,intentId:row.intent_id as string,
      threadId:row.thread_id as string,turnId:row.turn_id as string,callId:row.call_id as string,
      path:row.path as string,fullContentHash:row.full_content_hash as string,
      byteRange:[row.byte_start as number,row.byte_end as number],
      lineRange:[row.line_start as number,row.line_end as number],
      pageContentHash:row.page_content_hash as string,
      completeness:row.completeness as 'complete'|'partial',reservedAt:row.reserved_at as string,
      observedAt:row.observed_at as string}));
  }

  private requireCodexReadBase(claim: InvestigationClaim,binding: RunningReadBinding,now: Date):
    {record:InvestigationRecord;active:ReturnType<SqliteInvestigationStore['activeFor']>} {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !binding ||
      !binding.workerGrantId || !binding.workerAudience || !binding.workerRecipient ||
      !validDataPaths(binding.paths)) throw new Error('NOT_AVAILABLE');
    const active=this.activeFor(claim);
    if (active.phase!=='start_intent' || active.native_ref!==null || claim.nativeRef!==null ||
      claim.phase!=='start_intent') throw new StoreConflict();
    const selected=[...binding.paths].sort();
    this.requireCurrentSourceAuthority(claim,active,now,selected);
    const launch=this.readWindowsLaunch(claim.attemptId);
    if (launch) this.requireWindowsLaunchUsable(claim,launch.launchId,now);
    const record=this.get(claim.requestId)!;
    if (record.collaborationId!==binding.collaborationId ||
      record.workingCopyId!==binding.workingCopyId || record.snapshotRef!==binding.snapshotId ||
      claim.workerId===record.principal || binding.workerAudience===record.audience ||
      binding.workerRecipient===record.recipient) throw new StoreConflict();
    const worker=this.db.prepare(`SELECT principal,audience,recipient,workspace_id,collaboration_id,
      permissions_json,data_paths_json,expires_at,revoked_at FROM grants WHERE id=?`)
      .get(binding.workerGrantId) as {principal:string;audience:string;recipient:string|null;
        workspace_id:string;collaboration_id:string|null;permissions_json:string;
        data_paths_json:string|null;expires_at:string|null;revoked_at:string|null}|undefined;
    if (!worker || worker.principal!==claim.workerId || worker.audience!==binding.workerAudience ||
      worker.recipient!==binding.workerRecipient || worker.workspace_id!==claim.workspaceId ||
      worker.collaboration_id!==binding.collaborationId || worker.revoked_at!==null ||
      worker.expires_at===null || !(Date.parse(worker.expires_at)>now.getTime()))
      throw new Error('NOT_AVAILABLE');
    let permissions:unknown;let dataPaths:unknown;
    try {permissions=JSON.parse(worker.permissions_json);
      dataPaths=worker.data_paths_json===null?null:JSON.parse(worker.data_paths_json);}
    catch {throw new Error('NOT_AVAILABLE');}
    if (!Array.isArray(permissions)||permissions.length!==1||permissions[0]!=='data.read'||
      !validDataPaths(dataPaths)||JSON.stringify([...dataPaths].sort())!==JSON.stringify(selected))
      throw new Error('NOT_AVAILABLE');
    return {record,active};
  }

  private requireCodexReadAuthority(claim: InvestigationClaim,binding: RunningReadBinding,
    turn: CodexNativeReadTurn,now: Date): InvestigationRecord {
    const {record,active}=this.requireCodexReadBase(claim,binding,now);
    const session=this.db.prepare(`SELECT * FROM investigation_codex_read_sessions WHERE
      attempt_id=? AND request_id=? AND workspace_id=?`).get(claim.attemptId,claim.requestId,
      claim.workspaceId) as {launch_epoch:number;worker_id:string;profile_revision:string;
        binding_json:string;deadline_at:string}|undefined;
    if (!session || session.launch_epoch!==claim.workerEpoch || session.worker_id!==claim.workerId ||
      session.profile_revision!==active.profile_revision || session.binding_json!==JSON.stringify(binding) ||
      !(Date.parse(session.deadline_at)>now.getTime()) ||
      !turn?.intentId || !turn.threadId || !turn.turnId ||
      this.nativeThreadRow(claim,binding.collaborationId).thread_id!==turn.threadId) throw new StoreConflict();
    const nativeTurn=this.nativeTurnRow(claim,turn.intentId);
    if(nativeTurn.turn_id!==turn.turnId || nativeTurn.state!=='observed') throw new StoreConflict();
    return record;
  }
  /** Storage binding only: the runner must separately observe the WSL gate and source bytes. */
  preflightNativeLaunch(claim: InvestigationClaim, selectedPaths: readonly string[],
    expectedProfileRevision: string, expectedSourceDigest: string, now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !expectedProfileRevision ||
      !/^[0-9a-f]{64}$/.test(expectedSourceDigest)) throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      const resource = wslResourceFromRow(active);
      const source = sourceViewFromRow(active);
      const suppliedResource = claim.wslResource;
      const suppliedSource = claim.sourceView;
      if (active.launch_protocol !== 'resource_reservation_v1' || active.phase !== 'start_intent' ||
        active.native_ref !== null || active.container_name !== null || active.container_id !== null ||
        active.scratch_root !== null || active.profile_revision !== expectedProfileRevision ||
        !resource || !resource.gate || resource.invocationId !== null || resource.controlGroup !== null ||
        !suppliedResource || suppliedResource.unitName !== resource.unitName ||
        suppliedResource.distro !== resource.distro || suppliedResource.uid !== resource.uid ||
        suppliedResource.bootId !== resource.bootId || suppliedResource.invocationId !== null ||
        suppliedResource.controlGroup !== null || !sameGateBinding(suppliedResource.gate, resource.gate) ||
        !source || source.closedAt !== null || !suppliedSource || suppliedSource.closedAt !== null ||
        suppliedSource.privateRoot !== source.privateRoot ||
        source.descriptor.sourceDigest !== expectedSourceDigest ||
        Object.keys(source.descriptor).some(key => source.descriptor[key as keyof SourceViewDescriptor] !==
          suppliedSource.descriptor?.[key as keyof SourceViewDescriptor]) ||
        source.descriptor.distro !== resource.distro || source.descriptor.uid !== resource.uid ||
        source.descriptor.bootId !== resource.bootId || source.descriptor.linuxUser !== resource.gate.linuxUser ||
        source.descriptor.workerEpoch !== claim.workerEpoch) throw new StoreConflict();
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
    });
  }

  /** MCP-only model launch has no materialized source view. No native effect occurs here. */
  preflightClaudeModelLaunch(claim: InvestigationClaim, selectedPaths: readonly string[],
    expectedProfileRevision: string, expectedLaunch: NativeSupervisorLaunchBinding, now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !expectedProfileRevision ||
        !validSupervisorLaunchBinding(expectedLaunch, true)) throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      const { resource, launch } = this.modelResource(claim);
      if (active.phase !== 'start_intent' || claim.phase !== 'start_intent' || active.native_ref !== null ||
          claim.nativeRef !== null || resource.invocationId !== null || resource.controlGroup !== null ||
          active.profile_revision !== expectedProfileRevision || launch.workerEpoch !== claim.workerEpoch ||
          !sameSupervisorLaunchBinding(launch, expectedLaunch)) throw new StoreConflict();
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
    });
  }

  private modelResource(claim: InvestigationClaim): { resource: WslResource; launch: NativeSupervisorLaunchBinding } {
    const active = this.activeFor(claim);
    const resource = wslResourceFromRow(active);
    const supplied = claim.wslResource;
    const launch = resource?.gate?.launch;
    if (active.launch_protocol !== 'resource_reservation_v1' || active.source_view_json !== null ||
        active.source_view_closed_at !== null || active.windows_source_json !== null ||
        active.container_name !== null || active.container_id !== null || active.scratch_root !== null ||
        active.docker_volume_json !== null || claim.sourceView || claim.windowsSource || claim.containerName ||
        claim.containerId || claim.scratchRoot || claim.dockerVolume ||
        !resource || resource.gate?.payloadKind !== 'claude_model_v1' ||
        !validSupervisorLaunchBinding(launch, true) || launch.workerEpoch > claim.workerEpoch ||
        !supplied || supplied.unitName !== resource.unitName || supplied.distro !== resource.distro ||
        supplied.uid !== resource.uid || supplied.bootId !== resource.bootId ||
        supplied.invocationId !== resource.invocationId || supplied.controlGroup !== resource.controlGroup ||
        !sameGateBinding(supplied.gate, resource.gate)) throw new StoreConflict();
    return { resource, launch };
  }

  private validModelRunningFact(claim: InvestigationClaim, resource: WslResource,
    fact: ClaudeModelSupervisorState): boolean {
    const gate = resource.gate;
    const launch = gate?.launch;
    if (!gate || !launch || !launch.commandDigest || !validSupervisorLaunchBinding(launch, true) ||
        !fact || fact.commandDigest !== launch.commandDigest) return false;
    const parsed = parseClaudeModelSupervisorOutput(JSON.stringify(fact) + '\n', {
      attemptId: claim.attemptId, workspaceId: claim.workspaceId, distro: resource.distro,
      linuxUser: gate.linuxUser, uid: resource.uid, bootId: resource.bootId, unitName: resource.unitName,
      launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
      profileDigest: launch.profileDigest, commandDigest: launch.commandDigest,
    });
    return Boolean(parsed && parsed.phase === 'entered' && !parsed.closed &&
      resource.invocationId && resource.controlGroup && parsed.invocationId === resource.invocationId &&
      parsed.controlGroup === resource.controlGroup);
  }

  /** Only a trusted observer receipt can establish the original native model owner. */
  recordModelRunningFact(claim: InvestigationClaim, fact: ClaudeModelSupervisorState,
    receipt: string, now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      const { resource, launch } = this.modelResource(claim);
      const record = this.get(claim.requestId);
      if (!record || active.phase !== 'started' || claim.phase !== 'started' || !active.native_ref ||
          active.native_ref !== claim.nativeRef || launch.workerEpoch !== claim.workerEpoch ||
          !this.validModelRunningFact(claim, resource, fact) ||
          !this.claimAuthority?.verifyModelRunningReceipt?.(claim, resource, fact, receipt)) throw new StoreConflict();
      this.requireCurrentSourceAuthority(claim, active, now,
        [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort());
      const serialized = JSON.stringify(fact);
      const saved = this.db.prepare('SELECT native_ref,fact_json FROM investigation_model_running_facts WHERE attempt_id=? AND request_id=?')
        .get(claim.attemptId, claim.requestId) as { native_ref: string; fact_json: string } | undefined;
      if (saved && (saved.native_ref !== active.native_ref || saved.fact_json !== serialized)) throw new StoreConflict();
      if (!saved) this.db.prepare('INSERT INTO investigation_model_running_facts (attempt_id,request_id,native_ref,fact_json) VALUES (?,?,?,?)')
        .run(claim.attemptId, claim.requestId, active.native_ref, serialized);
    });
  }

  private savedModelRunningFact(claim: InvestigationClaim, resource: WslResource): ClaudeModelSupervisorState {
    const row = this.db.prepare('SELECT native_ref,fact_json FROM investigation_model_running_facts WHERE attempt_id=? AND request_id=?')
      .get(claim.attemptId, claim.requestId) as { native_ref: string; fact_json: string } | undefined;
    if (!row || row.native_ref !== claim.nativeRef) throw new StoreConflict();
    let fact: ClaudeModelSupervisorState;
    try { fact = JSON.parse(row.fact_json) as ClaudeModelSupervisorState; } catch { throw new StoreConflict(); }
    if (!this.validModelRunningFact(claim, resource, fact)) throw new StoreConflict();
    return fact;
  }

  getModelRunningFact(claim: InvestigationClaim): ClaudeModelSupervisorState {
    const { resource } = this.modelResource(claim);
    return this.savedModelRunningFact(claim, resource);
  }

  private validModelRunningObservation(claim: InvestigationClaim, resource: WslResource,
    observation: ModelRunningObservation): boolean {
    if (!observation || Object.keys(observation).sort().join(',') !== 'journal,kind,native,resource' ||
        observation.kind !== 'claude_model_running' ||
        !isDeepStrictEqual(observation.resource, resource) ||
        !this.validModelRunningFact(claim, resource, observation.journal)) return false;
    const native = observation.native;
    return Boolean(native && Object.keys(native).sort().join(',') ===
      'activeState,bootId,controlGroup,invocationId,loadState,mainPid,procControlGroup,startTicks,subState,uid,unitName' &&
      native.bootId === resource.bootId && native.uid === resource.uid && native.unitName === resource.unitName &&
      native.invocationId === resource.invocationId && native.controlGroup === resource.controlGroup &&
      native.procControlGroup === resource.controlGroup && native.loadState === 'loaded' &&
      native.activeState === 'active' && native.subState === 'running' &&
      native.mainPid === observation.journal.enterPid && native.startTicks === observation.journal.enterStartTicks);
  }

  /** Persist the actual native probe fields atomically with the original journal. */
  recordModelRunningObservation(claim: InvestigationClaim, observation: ModelRunningObservation,
    receipt: string, now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      const { resource, launch } = this.modelResource(claim);
      const record = this.get(claim.requestId);
      if (!record || active.phase !== 'started' || claim.phase !== 'started' || !active.native_ref ||
          active.native_ref !== claim.nativeRef || launch.workerEpoch !== claim.workerEpoch ||
          !this.validModelRunningObservation(claim, resource, observation)) throw new StoreConflict();
      this.requireCurrentSourceAuthority(claim, active, now,
        [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort());
      const journal = JSON.stringify(observation.journal);
      const native = JSON.stringify(observation.native);
      const saved = this.db.prepare('SELECT native_ref,fact_json,native_json FROM investigation_model_running_facts WHERE attempt_id=? AND request_id=?')
        .get(claim.attemptId, claim.requestId);
      if (saved && (saved.native_ref !== active.native_ref || saved.fact_json !== journal ||
          saved.native_json !== native)) throw new StoreConflict();
      if (!this.claimAuthority?.verifyModelRunningObservationReceipt?.(claim, resource, observation, receipt)) {
        throw new StoreConflict();
      }
      if (!saved) this.db.prepare('INSERT INTO investigation_model_running_facts (attempt_id,request_id,native_ref,fact_json,native_json) VALUES (?,?,?,?,?)')
        .run(claim.attemptId, claim.requestId, active.native_ref, journal, native);
    });
  }

  /** Historical evidence under the current recovery fence; does not assert current liveness. */
  getModelRunningObservation(claim: InvestigationClaim): ModelRunningObservation | null {
    const { resource } = this.modelResource(claim);
    const row = this.db.prepare('SELECT native_ref,fact_json,native_json FROM investigation_model_running_facts WHERE attempt_id=? AND request_id=?')
      .get(claim.attemptId, claim.requestId);
    if (!row) return null;
    const journal = this.savedModelRunningFact(claim, resource);
    if (row.native_json === null) return null;
    let observation: ModelRunningObservation;
    try { observation = { kind: 'claude_model_running', resource, journal,
      native: JSON.parse(row.native_json as string) as ModelRunningObservation['native'] }; }
    catch { throw new StoreConflict(); }
    if (!this.validModelRunningObservation(claim, resource, observation)) throw new StoreConflict();
    return observation;
  }

  private validModelOuterBinding(claim: InvestigationClaim, fact: ModelOuterConfinedFact): boolean {
    try {
      if (!validateClaudeModelOuterFact(fact)) return false;
      const { resource, launch } = this.modelResource(claim);
      const active = this.activeFor(claim);
      const original = this.getModelRunningObservation(claim);
      const record = this.get(claim.requestId);
      const descriptor = { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
        distro: resource.distro, linuxUser: resource.gate!.linuxUser, uid: resource.uid,
        bootId: resource.bootId, unitName: resource.unitName, launchWorkerEpoch: launch.workerEpoch,
        sourceDigest: launch.sourceDigest, profileDigest: launch.profileDigest,
        commandDigest: launch.commandDigest };
      return Boolean(record && original &&
        isDeepStrictEqual(fact.observation.candidate.running, original) &&
        isDeepStrictEqual(fact.expectation.descriptor, descriptor) &&
        fact.expectation.limits.maxWallSeconds === record.budget.maxWallSeconds &&
        (!Object.hasOwn(fact.expectation.limits, 'maxTurns') ||
          ('maxTurns' in fact.expectation.limits &&
            fact.expectation.limits.maxTurns === record.budget.maxTurns)) &&
        fact.expectation.paths.privateFifoDirectory ===
          `${resource.gate!.root}/${claim.attemptId}-${launch.workerEpoch}.mcp` &&
        (launch.workerEpoch !== claim.workerEpoch ||
          fact.expectation.profileRevision === active.profile_revision));
    } catch { return false; }
  }

  private modelAuthorityClock(now: Date): () => Date {
    const baseline = now.getTime();
    if (!Number.isFinite(baseline)) throw new StoreConflict();
    const entered = performance.now();
    return () => new Date(baseline + Math.max(0, performance.now() - entered));
  }

  private requireModelWallBudget(claim: InvestigationClaim, record: InvestigationRecord, now: Date): void {
    const { launch } = this.modelResource(claim);
    const attempt = record.attempts.find(item => item.id === claim.attemptId);
    const started = attempt?.startedAt ? Date.parse(attempt.startedAt) : NaN;
    if (claim.phase !== 'started' || launch.workerEpoch !== claim.workerEpoch ||
      !Number.isFinite(started) || now.getTime() < started ||
      !Number.isSafeInteger(record.budget.maxWallSeconds) || record.budget.maxWallSeconds < 1 ||
      record.budget.maxWallSeconds > 600 || !Number.isSafeInteger(record.budget.maxTurns) ||
      record.budget.maxTurns < 1 || now.getTime() >= started + record.budget.maxWallSeconds * 1000)
      throw new StoreConflict();
  }

  /** One immutable original-owner fact. No backfill, overwrite or historical upgrade. */
  recordModelOuterFact(claim: InvestigationClaim, binding: RunningReadBinding,
    fact: ModelOuterConfinedFact, receipt: string, now: Date): void {
    const clock = this.modelAuthorityClock(now);
    const saved = structuredClone({ claim, binding, fact });
    this.withTransaction(() => {
      const record = this.requireRunningReadAuthority(saved.claim, saved.binding, now);
      this.requireModelWallBudget(saved.claim, record, now);
      const { resource } = this.modelResource(saved.claim);
      if (!validateCurrentClaudeModelOuterFact(saved.fact) ||
        !this.validModelOuterBinding(saved.claim, saved.fact) ||
        this.getModelPromptIntent(saved.claim) !== null) throw new StoreConflict();
      const row = this.db.prepare(`SELECT native_ref,native_json,outer_json
        FROM investigation_model_running_facts WHERE attempt_id=? AND request_id=?`)
        .get(saved.claim.attemptId, saved.claim.requestId);
      if (!row || row.native_ref !== saved.claim.nativeRef || row.native_json === null ||
        row.outer_json !== null) throw new StoreConflict();
      const serialized = JSON.stringify(saved.fact);
      if (!this.claimAuthority?.verifyModelOuterReceipt?.(structuredClone(saved.claim),
        structuredClone(resource), structuredClone(saved.fact), receipt)) throw new StoreConflict();
      const current = clock();
      const currentRecord = this.requireRunningReadAuthority(saved.claim, saved.binding, current);
      this.requireModelWallBudget(saved.claim, currentRecord, current);
      const changed = this.db.prepare(`UPDATE investigation_model_running_facts SET outer_json=?
        WHERE attempt_id=? AND request_id=? AND native_ref=? AND outer_json IS NULL`)
        .run(serialized, saved.claim.attemptId, saved.claim.requestId, saved.claim.nativeRef!);
      if (changed.changes !== 1) throw new StoreConflict();
    });
  }

  /** Historical evidence only. Recovery cannot use it as current liveness or send permission. */
  getModelOuterFact(claim: InvestigationClaim): ModelOuterConfinedFact | null {
    this.modelResource(claim);
    const row = this.db.prepare(`SELECT native_ref,outer_json FROM investigation_model_running_facts
      WHERE attempt_id=? AND request_id=?`).get(claim.attemptId, claim.requestId);
    if (!row || row.outer_json === null) return null;
    if (row.native_ref !== claim.nativeRef || typeof row.outer_json !== 'string' ||
      Buffer.byteLength(row.outer_json) > 512 * 1024) throw new StoreConflict();
    let fact: ModelOuterConfinedFact;
    try { fact = JSON.parse(row.outer_json) as ModelOuterConfinedFact; } catch { throw new StoreConflict(); }
    if (!this.validModelOuterBinding(claim, fact)) throw new StoreConflict();
    return fact;
  }

  private requireModelPromptAuthority(claim: InvestigationClaim, binding: RunningReadBinding,
    expectedLaunch: NativeSupervisorLaunchBinding, clock: () => Date): ModelOuterConfinedFact {
    const { launch } = this.modelResource(claim);
    if (!sameSupervisorLaunchBinding(launch, expectedLaunch)) throw new StoreConflict();
    const fact = this.getModelOuterFact(claim);
    if (!fact || !validateCurrentClaudeModelOuterFact(fact)) throw new StoreConflict();
    const current = clock();
    const record = this.requireRunningReadAuthority(claim, binding, current);
    this.requireModelWallBudget(claim, record, current);
    return fact;
  }

  /** This records uncertainty before prompt I/O. Even matching repeats are refused. */
  recordModelPromptIntent(claim: InvestigationClaim, binding: RunningReadBinding,
    expectedLaunch: NativeSupervisorLaunchBinding, promptHash: string, now: Date,
    windowReceipt?: string): void {
    const clock = this.modelAuthorityClock(now);
    if (!validSupervisorLaunchBinding(expectedLaunch, true) || !/^[0-9a-f]{64}$/.test(promptHash)) {
      throw new Error('INVALID_ARGUMENT');
    }
    const saved = structuredClone({ claim, binding, expectedLaunch });
    this.withTransaction(() => {
      const outer = this.requireModelPromptAuthority(saved.claim, saved.binding, saved.expectedLaunch, clock);
      const { launch } = this.modelResource(saved.claim);
      if (typeof windowReceipt !== 'string' || this.getModelPromptIntent(saved.claim) !== null ||
        !this.claimAuthority?.verifyModelPromptWindowReceipt?.(structuredClone(saved.claim),
          structuredClone(outer), windowReceipt, 'intent')) throw new StoreConflict();
      const current = clock();
      const record = this.requireRunningReadAuthority(saved.claim, saved.binding, current);
      this.requireModelWallBudget(saved.claim, record, current);
      try {
        this.db.prepare(`INSERT INTO investigation_model_dispatch
          (attempt_id,request_id,launch_epoch,native_ref,profile_digest,command_digest,prompt_hash,intent_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(saved.claim.attemptId, saved.claim.requestId, launch.workerEpoch,
          saved.claim.nativeRef!, launch.profileDigest, launch.commandDigest!, promptHash, current.toISOString());
      } catch { throw new StoreConflict(); }
    });
  }

  /** Final synchronous fence; caller must immediately write the original handle without awaiting. */
  assertModelPromptSendAuthority(claim: InvestigationClaim, binding: RunningReadBinding,
    expectedLaunch: NativeSupervisorLaunchBinding, promptHash: string, now: Date,
    windowReceipt: string): void {
    const clock = this.modelAuthorityClock(now);
    if (!validSupervisorLaunchBinding(expectedLaunch, true) || !/^[0-9a-f]{64}$/.test(promptHash))
      throw new Error('INVALID_ARGUMENT');
    const saved = structuredClone({ claim, binding, expectedLaunch });
    this.withTransaction(() => {
      const fact = this.requireModelPromptAuthority(saved.claim, saved.binding, saved.expectedLaunch, clock);
      const intent = this.getModelPromptIntent(saved.claim);
      if (!intent || intent.promptHash !== promptHash || typeof windowReceipt !== 'string' ||
        !this.claimAuthority?.verifyModelPromptWindowReceipt?.(structuredClone(saved.claim),
          structuredClone(fact), windowReceipt, 'send')) throw new StoreConflict();
      const current = clock();
      const record = this.requireRunningReadAuthority(saved.claim, saved.binding, current);
      this.requireModelWallBudget(saved.claim, record, current);
    });
  }

  /** Recovery reads the original intent without requiring a still-valid disclosure grant. */
  getModelPromptIntent(claim: InvestigationClaim): ModelPromptIntent | null {
    const { resource, launch } = this.modelResource(claim);
    const row = this.db.prepare(`SELECT launch_epoch,native_ref,profile_digest,command_digest,prompt_hash,intent_at
      FROM investigation_model_dispatch WHERE attempt_id=? AND request_id=?`).get(claim.attemptId, claim.requestId) as {
        launch_epoch: number; native_ref: string; profile_digest: string; command_digest: string;
        prompt_hash: string; intent_at: string;
      } | undefined;
    if (!row) return null;
    const fact = this.savedModelRunningFact(claim, resource);
    if (row.launch_epoch !== launch.workerEpoch || row.native_ref !== claim.nativeRef ||
        row.profile_digest !== launch.profileDigest || row.command_digest !== fact.commandDigest ||
        !/^[0-9a-f]{64}$/.test(row.prompt_hash) || !Number.isFinite(Date.parse(row.intent_at))) throw new StoreConflict();
    return { launchEpoch: row.launch_epoch, nativeRef: row.native_ref, profileDigest: row.profile_digest,
      commandDigest: row.command_digest, promptHash: row.prompt_hash, intentAt: row.intent_at };
  }

  /** A v2 host release may use only the original, still-authorized launch binding. */
  preflightSupervisorRelease(claim: InvestigationClaim, observed: WslResourceObservation,
    expectedLaunch: NativeSupervisorLaunchBinding, selectedPaths: readonly string[], now: Date): void {
    this.preflightSupervisorReleaseCore(claim, observed, expectedLaunch, selectedPaths, now, true);
  }

  /** Persist a previously independently verified original-running observation. */
  recordSupervisorV2RunningFact(claim: InvestigationClaim, verified: SupervisorV2RunningObservation,
    selectedPaths: readonly string[], now: Date): void {
    if (verified?.kind !== 'original_unit_running') throw new StoreConflict();
    const launch = verified.resource?.gate?.launch;
    if (!launch) throw new StoreConflict();
    this.preflightSupervisorReleaseCore(claim, {
      invocationId: verified.resource.invocationId!, controlGroup: verified.resource.controlGroup!,
    }, launch, selectedPaths, now, false, verified);
  }

  private validSupervisorV2RunningFact(claim: InvestigationClaim, resource: WslResource,
    launch: NativeSupervisorLaunchBinding, verified: SupervisorV2RunningObservation): boolean {
    if (verified?.kind !== 'original_unit_running' || !verified.journal || !verified.native ||
      !verified.resource) return false;
    const { journal, native, resource: observed } = verified;
    const gate = resource.gate;
    if (!gate || !parseNativeSupervisorGateOutput(JSON.stringify(journal) + '\n', {
      attemptId: claim.attemptId, workspaceId: claim.workspaceId, distro: resource.distro,
      linuxUser: gate.linuxUser, uid: resource.uid, bootId: resource.bootId,
      unitName: resource.unitName, launchWorkerEpoch: launch.workerEpoch,
      sourceDigest: launch.sourceDigest, profileDigest: launch.profileDigest,
    })) return false;
    return Object.keys(verified).sort().join(',') === 'journal,kind,native,resource' &&
      Object.keys(native).sort().join(',') ===
        'activeState,bootId,controlGroup,invocationId,loadState,mainPid,procControlGroup,startTicks,subState,uid,unitName' &&
      observed.unitName === resource.unitName && observed.distro === resource.distro &&
      observed.uid === resource.uid && observed.bootId === resource.bootId &&
      observed.invocationId === resource.invocationId && observed.controlGroup === resource.controlGroup &&
      sameGateBinding(observed.gate, resource.gate) &&
      journal.protocol === 'native_supervisor_v2' && journal.phase === 'entered' && !journal.closed &&
      journal.attemptId === claim.attemptId && journal.workspaceId === claim.workspaceId &&
      journal.launchWorkerEpoch === launch.workerEpoch && journal.sourceDigest === launch.sourceDigest &&
      journal.profileDigest === launch.profileDigest && journal.bootId === resource.bootId &&
      journal.uid === resource.uid && journal.unitName === resource.unitName &&
      journal.invocationId === resource.invocationId && journal.controlGroup === resource.controlGroup &&
      Number.isSafeInteger(journal.enterPid) && journal.enterPid! > 0 &&
      Number.isSafeInteger(journal.enterStartTicks) && journal.enterStartTicks! > 0 &&
      native.bootId === resource.bootId && native.uid === resource.uid &&
      native.unitName === resource.unitName && native.invocationId === resource.invocationId &&
      native.controlGroup === resource.controlGroup && native.procControlGroup === resource.controlGroup &&
      native.loadState === 'loaded' && native.activeState === 'active' && native.subState === 'running' &&
      native.mainPid === journal.enterPid && native.startTicks === journal.enterStartTicks;
  }

  private preflightSupervisorReleaseCore(claim: InvestigationClaim, observed: WslResourceObservation,
    expectedLaunch: NativeSupervisorLaunchBinding, selectedPaths: readonly string[], now: Date,
    requireFact: boolean, verified?: SupervisorV2RunningObservation): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !validSupervisorLaunchBinding(expectedLaunch) || !observed ||
      typeof observed.invocationId !== 'string' || !/^[0-9a-f]{32}$/.test(observed.invocationId) ||
      typeof observed.controlGroup !== 'string') throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      const resource = wslResourceFromRow(active);
      const source = sourceViewFromRow(active);
      const submittedResource = claim.wslResource;
      const submittedSource = claim.sourceView;
      const launch = resource?.gate?.launch;
      const expectedControlGroup = resource &&
        `/user.slice/user-${resource.uid}.slice/user@${resource.uid}.service/app.slice/${resource.unitName}`;
      if (active.launch_protocol !== 'resource_reservation_v1' ||
        active.phase !== 'start_intent' || claim.phase !== 'start_intent' ||
        active.native_ref !== null || active.container_name !== null || active.container_id !== null ||
        active.scratch_root !== null || !resource || resource.gate?.payloadKind !== 'native_supervisor_v2' ||
        !launch || launch.profileDigest !== FIXED_ZERO_MODEL_PROFILE_DIGEST ||
        !sameSupervisorLaunchBinding(launch, expectedLaunch) ||
        launch.workerEpoch !== active.worker_epoch || claim.workerEpoch !== launch.workerEpoch ||
        resource.invocationId !== observed.invocationId ||
        resource.controlGroup !== observed.controlGroup || observed.controlGroup !== expectedControlGroup ||
        !submittedResource || submittedResource.unitName !== resource.unitName ||
        submittedResource.distro !== resource.distro || submittedResource.uid !== resource.uid ||
        submittedResource.bootId !== resource.bootId ||
        submittedResource.invocationId !== resource.invocationId ||
        submittedResource.controlGroup !== resource.controlGroup ||
        !sameGateBinding(submittedResource.gate, resource.gate) ||
        !source || source.closedAt !== null || !submittedSource || submittedSource.closedAt !== null ||
        submittedSource.privateRoot !== source.privateRoot ||
        Object.keys(source.descriptor).some(key => source.descriptor[key as keyof SourceViewDescriptor] !==
          submittedSource.descriptor?.[key as keyof SourceViewDescriptor]) ||
        source.descriptor.attemptId !== claim.attemptId ||
        source.descriptor.workspaceId !== claim.workspaceId ||
        source.descriptor.workerEpoch !== launch.workerEpoch ||
        source.descriptor.sourceDigest !== launch.sourceDigest ||
        source.descriptor.distro !== resource.distro || source.descriptor.uid !== resource.uid ||
        source.descriptor.bootId !== resource.bootId ||
        source.descriptor.linuxUser !== resource.gate.linuxUser) throw new StoreConflict();
      this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
      if (!this.validSupervisorV2RunningFact(claim, resource, launch,
        requireFact ? this.savedSupervisorV2RunningFact(claim) : verified!)) throw new StoreConflict();
      if (!requireFact) {
        const serialized = JSON.stringify(verified);
        const saved = this.db.prepare(`SELECT fact_json FROM investigation_supervisor_v2_running_facts
          WHERE attempt_id=? AND request_id=?`).get(claim.attemptId, claim.requestId) as
          { fact_json: string } | undefined;
        if (saved && saved.fact_json !== serialized) throw new StoreConflict();
        if (!saved) this.db.prepare(`INSERT INTO investigation_supervisor_v2_running_facts
          (attempt_id,request_id,fact_json) VALUES (?,?,?)`)
          .run(claim.attemptId, claim.requestId, serialized);
      }
    });
  }

  private savedSupervisorV2RunningFact(claim: InvestigationClaim): SupervisorV2RunningObservation {
    const row = this.db.prepare(`SELECT fact_json FROM investigation_supervisor_v2_running_facts
      WHERE attempt_id=? AND request_id=?`).get(claim.attemptId, claim.requestId) as
      { fact_json: string } | undefined;
    if (!row) throw new StoreConflict();
    try { return JSON.parse(row.fact_json) as SupervisorV2RunningObservation; }
    catch { throw new StoreConflict(); }
  }

  /** Read the original verifier result for recovery; never reconstruct one from current unit state. */
  getSupervisorV2RunningFact(claim: InvestigationClaim): SupervisorV2RunningObservation | null {
    const active = this.activeFor(claim);
    const resource = wslResourceFromRow(active);
    const source = sourceViewFromRow(active);
    const launch = resource?.gate?.launch;
    const submittedResource = claim.wslResource;
    const submittedSource = claim.sourceView;
    if (!resource || resource.gate?.payloadKind !== 'native_supervisor_v2' || !launch ||
      launch.profileDigest !== FIXED_ZERO_MODEL_PROFILE_DIGEST ||
      launch.workerEpoch > active.worker_epoch || !submittedResource ||
      submittedResource.unitName !== resource.unitName || submittedResource.distro !== resource.distro ||
      submittedResource.uid !== resource.uid || submittedResource.bootId !== resource.bootId ||
      submittedResource.invocationId !== resource.invocationId ||
      submittedResource.controlGroup !== resource.controlGroup ||
      !sameGateBinding(submittedResource.gate, resource.gate) || !source || !submittedSource ||
      submittedSource.privateRoot !== source.privateRoot ||
      submittedSource.closedAt !== source.closedAt ||
      Object.keys(source.descriptor).some(key => source.descriptor[key as keyof SourceViewDescriptor] !==
        submittedSource.descriptor?.[key as keyof SourceViewDescriptor]) ||
      source.descriptor.attemptId !== claim.attemptId ||
      source.descriptor.workspaceId !== claim.workspaceId ||
      source.descriptor.workerEpoch !== launch.workerEpoch ||
      source.descriptor.sourceDigest !== launch.sourceDigest ||
      source.descriptor.distro !== resource.distro || source.descriptor.uid !== resource.uid ||
      source.descriptor.bootId !== resource.bootId ||
      source.descriptor.linuxUser !== resource.gate.linuxUser) throw new StoreConflict();
    const row = this.db.prepare(`SELECT fact_json FROM investigation_supervisor_v2_running_facts
      WHERE attempt_id=? AND request_id=?`).get(claim.attemptId, claim.requestId) as
      { fact_json: string } | undefined;
    if (!row) return null;
    let fact: SupervisorV2RunningObservation;
    try { fact = JSON.parse(row.fact_json) as SupervisorV2RunningObservation; }
    catch { throw new StoreConflict(); }
    if (!this.validSupervisorV2RunningFact(claim, resource, launch, fact)) throw new StoreConflict();
    return fact;
  }

  /** Cleanup takeover fences the worker; the source descriptor keeps its original epoch. */
  acquireSourceViewCleanupLease(claim: InvestigationClaim, workerId: string, now: Date): InvestigationClaim | null {
    if (!workerId || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const sourceView = sourceViewFromRow(active);
      if (!sourceView) throw new StoreConflict();
      if (now.toISOString() <= active.lease_until) return null;
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      const workerEpoch = active.worker_epoch + 1;
      this.db.prepare(`UPDATE investigation_active_attempts SET worker_id=?,worker_epoch=?,phase='reconcile',lease_until=?
        WHERE request_id=?`).run(workerId, workerEpoch, new Date(now.getTime() + 120_000).toISOString(), claim.requestId);
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state: 'recovery_required' as const, workerEpoch } : attempt);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...record, state: 'recovery_required', attempts, result: null }), claim.requestId);
      const wslResource = wslResourceFromRow(active);
      return { ...claim, workerId, workerEpoch, phase: 'reconcile', nativeRef: active.native_ref,
        sourceView, ...(wslResource ? { wslResource } : {}) };
    });
  }

  /** Trusted supervisor assertion of a successful WSL close/status observation; SQLite checks identity and fencing. */
  confirmSourceViewClosed(claim: InvestigationClaim, state: SourceViewState, now: Date): InvestigationClaim {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const sourceView = sourceViewFromRow(active);
      const descriptor = sourceView?.descriptor;
      if (!descriptor || !claim.sourceView || !claim.sourceView.descriptor ||
        claim.sourceView.privateRoot !== sourceView.privateRoot ||
        Object.keys(descriptor).some(key => descriptor[key as keyof SourceViewDescriptor] !==
          claim.sourceView!.descriptor[key as keyof SourceViewDescriptor]) ||
        !state || Object.keys(state).sort().join(',') !==
        'attemptId,bootId,digest,kind,uid,workerEpoch,workspaceId' ||
        state.kind !== 'closed' || state.attemptId !== descriptor.attemptId ||
        state.workspaceId !== descriptor.workspaceId || state.uid !== descriptor.uid ||
        state.workerEpoch !== descriptor.workerEpoch || state.bootId !== descriptor.bootId ||
        state.digest !== descriptor.sourceDigest || now.toISOString() >= active.lease_until ||
        !['start_intent', 'started', 'reconcile'].includes(active.phase)) throw new StoreConflict();
      if (sourceView.closedAt === null) {
        this.db.prepare(`UPDATE investigation_active_attempts SET source_view_closed_at=? WHERE request_id=?`)
          .run(now.toISOString(), claim.requestId);
      }
      return { ...claim, sourceView: { ...sourceView, closedAt: sourceView.closedAt ?? now.toISOString() } };
    });
  }

  private requireClosedSourceView(active: SourceViewRow & WindowsSourceRow): void {
    if (windowsSourceFromRow(active)) throw new StoreConflict();
    const sourceView = sourceViewFromRow(active);
    if (sourceView && sourceView.closedAt === null) throw new StoreConflict();
  }

  private volumeForUpdate(claim: InvestigationClaim, now: Date):
    { active: ReturnType<SqliteInvestigationStore['activeFor']>; resource: DockerVolumeResource } {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    const active = this.activeFor(claim);
    const resource = dockerVolumeFromRow(active);
    if (!resource || now.toISOString() >= active.lease_until ||
      !['start_intent', 'reconcile'].includes(active.phase)) throw new StoreConflict();
    return { active, resource };
  }

  private saveDockerVolume(requestId: string, resource: DockerVolumeResource): void {
    if (!validDockerVolume(resource)) throw new StoreConflict();
    try {
      this.db.prepare('UPDATE investigation_active_attempts SET docker_volume_json=? WHERE request_id=?')
        .run(JSON.stringify(resource), requestId);
    } catch { throw new StoreConflict(); }
  }

  private requireDockerVolumeLaunchAuthority(claim: InvestigationClaim,
    active: ReturnType<SqliteInvestigationStore['activeFor']>, now: Date): void {
    const record = this.get(claim.requestId);
    if (!record) throw new StoreConflict();
    const selected = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
    this.requireCurrentSourceAuthority(claim, active, now, selected);
  }

  /** Persist owner create intent before the daemon call. Legacy scratch and WSL rows are separate. */
  reserveDockerVolumeOwner(claim: InvestigationClaim, ownerName: string, daemonId: string,
    now: Date): InvestigationClaim {
    if (!dockerOwnerName.test(ownerName) || !dockerDaemonId.test(daemonId) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('INVALID_ARGUMENT');
    }
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const prior = dockerVolumeFromRow(active);
      this.assertNoNativeThreadIntent(claim.attemptId);
      if (now.toISOString() >= active.lease_until || active.phase !== 'start_intent' ||
        active.launch_protocol !== 'resource_reservation_v1' ||
        active.container_name !== null || active.container_id !== null || active.scratch_root !== null ||
        active.wsl_unit_name !== null || active.windows_source_json !== null || active.source_view_json !== null ||
        active.native_ref !== null || prior) throw new StoreConflict();
      this.requireDockerVolumeLaunchAuthority(claim, active, now);
      const resource: DockerVolumeResource = { protocol: 'docker_volume_v1', daemonId, ownerName,
        ownerId: null, volumeName: null, materializationIntent: false,
        materialized: false, readerName: null, readerId: null };
      this.saveDockerVolume(claim.requestId, resource);
      return { ...claim, dockerVolume: resource };
    });
  }

  /** Full owner ID and the one observed anonymous volume are durable before materialization. */
  observeDockerVolumeOwner(claim: InvestigationClaim, ownerId: string, volumeName: string,
    now: Date): InvestigationClaim {
    if (!dockerId.test(ownerId) || !dockerVolumeName.test(volumeName)) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const { active, resource } = this.volumeForUpdate(claim, now);
      if (!['start_intent', 'reconcile'].includes(active.phase) ||
        (resource.ownerId !== null && (resource.ownerId !== ownerId || resource.volumeName !== volumeName))) {
        throw new StoreConflict();
      }
      const updated = { ...resource, ownerId, volumeName };
      this.saveDockerVolume(claim.requestId, updated);
      return { ...claim, dockerVolume: updated };
    });
  }

  markDockerVolumeMaterialized(claim: InvestigationClaim, now: Date): InvestigationClaim {
    return this.withTransaction(() => {
      const { active, resource } = this.volumeForUpdate(claim, now);
      if (active.phase !== 'start_intent' || !resource.materializationIntent ||
        resource.ownerId === null || resource.volumeName === null ||
        resource.readerName !== null) throw new StoreConflict();
      this.requireDockerVolumeLaunchAuthority(claim, active, now);
      const updated = { ...resource, materialized: true };
      this.saveDockerVolume(claim.requestId, updated);
      return { ...claim, dockerVolume: updated };
    });
  }

  /** Durable one-shot intent and current authority before feeding source bytes to the materializer. */
  reserveDockerVolumeMaterialization(claim: InvestigationClaim, now: Date): InvestigationClaim {
    return this.withTransaction(() => {
      const { active, resource } = this.volumeForUpdate(claim, now);
      if (active.phase !== 'start_intent' || resource.ownerId === null || resource.volumeName === null ||
        resource.materializationIntent) throw new StoreConflict();
      this.requireDockerVolumeLaunchAuthority(claim, active, now);
      const updated = { ...resource, materializationIntent: true };
      this.saveDockerVolume(claim.requestId, updated);
      return { ...claim, dockerVolume: updated };
    });
  }

  /** Persist reader create intent; a cleanup lease prevents the old epoch from creating it later. */
  reserveDockerVolumeReader(claim: InvestigationClaim, readerName: string, now: Date): InvestigationClaim {
    if (!dockerReaderName.test(readerName)) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const { active, resource } = this.volumeForUpdate(claim, now);
      if (active.phase !== 'start_intent' || !resource.materialized ||
        (resource.readerName !== null && resource.readerName !== readerName)) throw new StoreConflict();
      this.requireDockerVolumeLaunchAuthority(claim, active, now);
      const updated = { ...resource, readerName };
      this.saveDockerVolume(claim.requestId, updated);
      return { ...claim, dockerVolume: updated };
    });
  }

  observeDockerVolumeReader(claim: InvestigationClaim, readerId: string, now: Date): InvestigationClaim {
    if (!dockerId.test(readerId)) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const { resource } = this.volumeForUpdate(claim, now);
      if (resource.readerName === null || (resource.readerId !== null && resource.readerId !== readerId)) {
        throw new StoreConflict();
      }
      const updated = { ...resource, readerId };
      this.saveDockerVolume(claim.requestId, updated);
      return { ...claim, dockerVolume: updated };
    });
  }

  /** Cleanup-only takeover never grants another launch or materialization. */
  acquireDockerVolumeCleanupLease(claim: InvestigationClaim, workerId: string, now: Date): InvestigationClaim | null {
    if (!workerId || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const resource = dockerVolumeFromRow(active);
      if (!resource || now.toISOString() <= active.lease_until) return null;
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      const workerEpoch = active.worker_epoch + 1;
      this.db.prepare(`UPDATE investigation_active_attempts SET worker_id=?,worker_epoch=?,phase='reconcile',lease_until=?
        WHERE request_id=?`).run(workerId, workerEpoch, new Date(now.getTime() + 120_000).toISOString(), claim.requestId);
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state: 'recovery_required' as const, workerEpoch } : attempt);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...record, state: 'recovery_required', attempts, result: null }), claim.requestId);
      return { ...claim, workerId, workerEpoch, phase: 'reconcile', dockerVolume: resource };
    });
  }

  /** Settle only after a verifier binds exact reader, owner and volume absence to this claim. */
  finishDockerVolumeCleanup(claim: InvestigationClaim, receipt: string, now: Date): InvestigationRecord {
    if (typeof receipt !== 'string' || receipt.length < 1 || receipt.length > 256) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const { active, resource } = this.volumeForUpdate(claim, now);
      this.assertNoNativeThreadIntent(claim.attemptId);
      if (active.phase !== 'reconcile' || !resource.ownerId || !resource.volumeName ||
        (resource.readerName !== null && !resource.readerId)) throw new StoreConflict();
      if (this.claimAuthority?.verifyDockerVolumeCleanupReceipt?.(claim, resource, receipt) !== true) {
        throw new Error('NOT_AVAILABLE');
      }
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state, finishedAt: now.toISOString(), terminationConfirmed: true } : attempt);
      const updated: InvestigationRecord = { ...record, state, attempts, result: null };
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Commit the exact daemon name before docker create. A second name cannot replace it. */
  reserveContainerName(claim: InvestigationClaim, name: string, scratchRoot: string, now: Date): InvestigationClaim {
    if (!/^rcac-investigator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name) ||
      !isAbsolute(scratchRoot) || resolve(scratchRoot) !== scratchRoot || basename(scratchRoot) !== name ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (now.toISOString() >= active.lease_until || active.phase !== 'start_intent' ||
        active.wsl_unit_name !== null || active.windows_source_json !== null ||
        active.docker_volume_json !== null ||
        (active.container_name !== null && active.container_name !== name) ||
        (active.scratch_root !== null && active.scratch_root !== scratchRoot) ||
        (active.container_name !== null && active.scratch_root === null)) throw new StoreConflict();
      if (active.container_name === null) {
        try {
          this.db.prepare('UPDATE investigation_active_attempts SET container_name=?,scratch_root=? WHERE request_id=?')
            .run(name, scratchRoot, claim.requestId);
        } catch { throw new StoreConflict(); }
      }
      return { ...claim, containerName: name, scratchRoot };
    });
  }

  /** Commit a WSL unit identity before the native launch call. */
  reserveWslResource(claim: InvestigationClaim, reservation: WslResourceReservation, now: Date): InvestigationClaim {
    if (!/^rcac-investigator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/.test(reservation.unitName) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reservation.distro) ||
      !Number.isSafeInteger(reservation.uid) || reservation.uid < 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reservation.bootId) ||
      (reservation.gate !== undefined && !validWslGateBinding(reservation.gate)) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const saved = wslResourceFromRow(active);
      if (now.toISOString() >= active.lease_until || active.phase !== 'start_intent' ||
        (reservation.gate?.launch && reservation.gate.launch.workerEpoch !== claim.workerEpoch) ||
        active.windows_source_json !== null || active.container_name !== null || active.docker_volume_json !== null ||
        active.container_id !== null || active.native_ref !== null ||
        (saved !== undefined && (saved.unitName !== reservation.unitName || saved.distro !== reservation.distro ||
          saved.uid !== reservation.uid || saved.bootId !== reservation.bootId ||
          !sameGateBinding(saved.gate, reservation.gate)))) throw new StoreConflict();
      if (saved === undefined) {
        try {
          this.db.prepare(`UPDATE investigation_active_attempts SET wsl_unit_name=?,wsl_distro=?,wsl_uid=?,wsl_boot_id=?,
            wsl_launch_gate_json=? WHERE request_id=?`).run(reservation.unitName, reservation.distro,
            reservation.uid, reservation.bootId, reservation.gate ? JSON.stringify(reservation.gate) : null,
            claim.requestId);
        } catch { throw new StoreConflict(); }
      }
      return { ...claim, wslResource: saved ?? { ...reservation, invocationId: null, controlGroup: null } };
    });
  }

  /** Bind the exact observed systemd identity; an observation cannot replace an earlier one. */
  observeWslResource(claim: InvestigationClaim, observation: WslResourceObservation, now: Date): InvestigationClaim {
    if (!/^[0-9a-f]{32}$/.test(observation.invocationId) ||
      !/^\/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+$/.test(observation.controlGroup) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const resource = wslResourceFromRow(active);
      const expectedControlGroup = resource &&
        `/user.slice/user-${resource.uid}.slice/user@${resource.uid}.service/app.slice/${resource.unitName}`;
      if (!resource || observation.controlGroup !== expectedControlGroup ||
        !['start_intent', 'unknown', 'reconcile'].includes(active.phase) || now.toISOString() >= active.lease_until ||
        (resource.invocationId !== null && (resource.invocationId !== observation.invocationId ||
          resource.controlGroup !== observation.controlGroup))) throw new StoreConflict();
      if (resource.invocationId === null) this.db.prepare(`UPDATE investigation_active_attempts
        SET wsl_invocation_id=?,wsl_control_group=? WHERE request_id=?`)
        .run(observation.invocationId, observation.controlGroup, claim.requestId);
      return { ...claim, wslResource: { ...resource, ...observation } };
    });
  }

  private withTransaction<T>(mutation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = mutation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private verifyClaim(input: ClaimInput, record: InvestigationRecord): void {
    if (!this.claimAuthority || !input.workerId || !input.isolationEvidence || !input.profileRevision ||
      (input.launchProtocol !== undefined && input.launchProtocol !== 'resource_reservation_v1') ||
      !Number.isSafeInteger(input.permissionEpoch) || input.permissionEpoch < 0 ||
      !(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) ||
      !this.claimAuthority.verifyIsolation(input.isolationEvidence, record, input.profileRevision)) {
      throw new Error('NOT_AVAILABLE');
    }
  }

  private currentPermissionEpoch(record: InvestigationRecord): number {
    const row = this.db.prepare(`SELECT epoch FROM permission_epochs
      WHERE principal=? AND audience=? AND workspace_id=?`)
      .get(record.principal, record.audience, record.workspaceId) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  /** Stores start intent before any native call. An uncertain intent keeps its slot. */
  claimNext(input: ClaimInput): InvestigationClaim | null {
    if (!this.claimAuthority) throw new Error('NOT_AVAILABLE');
    return this.withTransaction(() => {
      if (!this.hasGlobalSlot()) return null;
      const pending = this.db.prepare(`SELECT r.record_json FROM investigation_outbox o
        JOIN investigation_requests r ON r.id=o.request_id ORDER BY o.created_at,o.request_id`).all() as
        { record_json: string }[];
      for (const row of pending) {
        const record = JSON.parse(row.record_json) as InvestigationRecord;
        const claim = this.claimQueued(record, input);
        if (claim) return claim;
      }
      return null;
    });
  }

  /** Claim a scheduler-selected request without applying another request's epoch or isolation proof. */
  claimRequest(requestId: string, input: ClaimInput): InvestigationClaim | null {
    if (!this.claimAuthority) throw new Error('NOT_AVAILABLE');
    return this.withTransaction(() => {
      if (!this.hasGlobalSlot()) return null;
      const row = this.db.prepare(`SELECT r.record_json FROM investigation_outbox o
        JOIN investigation_requests r ON r.id=o.request_id WHERE o.request_id=?`)
        .get(requestId) as { record_json: string } | undefined;
      return row ? this.claimQueued(JSON.parse(row.record_json) as InvestigationRecord, input) : null;
    });
  }

  private hasGlobalSlot(): boolean {
    const active = this.db.prepare('SELECT COUNT(*) AS count FROM investigation_active_attempts').get() as { count: number };
    return active.count < 2;
  }

  private claimQueued(record: InvestigationRecord, input: ClaimInput): InvestigationClaim | null {
    if (record.state !== 'queued' || record.cancelRequested || record.attempts.length > 0) return null;
    const occupied = this.db.prepare('SELECT 1 FROM investigation_active_attempts WHERE workspace_id=? LIMIT 1')
      .get(record.workspaceId);
    if (occupied || this.currentPermissionEpoch(record) !== input.permissionEpoch) return null;
    try {
      this.requireGrant(record, record.grantId, 'investigation.request');
      if (!this.hasReadScope(record, [...record.scope.paths, ...record.scope.relatedTests])) return null;
    }
    catch { return null; }
    this.verifyClaim(input, record);
    // Isolation verification may be synchronous but slow enough for a grant to expire.
    try {
      this.requireGrant(record, record.grantId, 'investigation.request');
      if (!this.hasReadScope(record, [...record.scope.paths, ...record.scope.relatedTests])) return null;
    } catch { return null; }
    const attemptId = `attempt_${randomUUID()}`;
    const workerEpoch = 1;
    const leaseUntil = new Date(input.now.getTime() + 30_000).toISOString();
    this.db.prepare(`INSERT INTO investigation_active_attempts
      (request_id,attempt_id,workspace_id,worker_id,worker_epoch,phase,native_ref,launch_protocol,lease_until,
      profile_revision,permission_epoch,isolation_evidence) VALUES (?,?,?,?,?,'start_intent',NULL,?,?,?,?,?)`)
      .run(record.id, attemptId, record.workspaceId, input.workerId, workerEpoch, input.launchProtocol ?? null, leaseUntil,
        input.profileRevision, input.permissionEpoch, input.isolationEvidence);
    const updated: InvestigationRecord = { ...record, attempts: [{ id: attemptId,
      state: 'claimed', nativeRef: null, workerEpoch, startedAt: null, finishedAt: null,
      terminationConfirmed: false }] };
    this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
      .run(JSON.stringify(updated), record.id);
    return { requestId: record.id, attemptId, workerId: input.workerId, workerEpoch,
      workspaceId: record.workspaceId, nativeRef: null, launchProtocol: input.launchProtocol ?? null,
      phase: 'start_intent' };
  }

  private activeFor(claim: InvestigationClaim): { worker_epoch: number; worker_id: string;
    attempt_id: string; workspace_id: string; native_ref: string | null; container_name: string | null; container_id: string | null;
    scratch_root: string | null;
    phase: InvestigationClaim['phase']; lease_until: string; permission_epoch: number; profile_revision: string;
    launch_protocol: 'resource_reservation_v1' | null } & WslResourceRow & SourceViewRow & WindowsSourceRow & DockerVolumeRow {
    const active = this.db.prepare(`SELECT worker_epoch,worker_id,attempt_id,workspace_id,native_ref,container_name,container_id,scratch_root,docker_volume_json,
      wsl_unit_name,wsl_distro,wsl_uid,wsl_boot_id,wsl_invocation_id,wsl_control_group,wsl_launch_gate_json,source_view_json,source_view_closed_at,windows_source_json,phase,lease_until,permission_epoch,profile_revision,launch_protocol
      FROM investigation_active_attempts WHERE request_id=?`).get(claim.requestId) as
      { worker_epoch: number; worker_id: string; attempt_id: string; workspace_id: string; native_ref: string | null; container_name: string | null; container_id: string | null;
        scratch_root: string | null;
        phase: InvestigationClaim['phase']; lease_until: string; permission_epoch: number; profile_revision: string;
        launch_protocol: 'resource_reservation_v1' | null } & WslResourceRow & SourceViewRow & WindowsSourceRow & DockerVolumeRow | undefined;
    if (!active || active.worker_epoch !== claim.workerEpoch || active.worker_id !== claim.workerId ||
      active.attempt_id !== claim.attemptId || active.workspace_id !== claim.workspaceId) throw new StoreConflict();
    const sourceView = sourceViewFromRow(active);
    const dockerVolume = dockerVolumeFromRow(active);
    if (dockerVolume && (active.container_name !== null || active.container_id !== null ||
      active.scratch_root !== null || active.native_ref !== null || sourceView || wslResourceFromRow(active) ||
      windowsSourceFromRow(active))) throw new StoreConflict();
    if (sourceView && (sourceView.descriptor.attemptId !== active.attempt_id ||
      sourceView.descriptor.workspaceId !== active.workspace_id ||
      sourceView.descriptor.workerEpoch > active.worker_epoch)) throw new StoreConflict();
    const windowsSource = windowsSourceFromRow(active);
    if (windowsSource && (windowsSource.descriptor.attemptId !== active.attempt_id ||
      windowsSource.descriptor.workspaceId !== active.workspace_id ||
      windowsSource.descriptor.workerEpoch > active.worker_epoch || sourceView ||
      wslResourceFromRow(active) || active.container_name !== null || active.container_id !== null ||
      active.scratch_root !== null || dockerVolume)) throw new StoreConflict();
    return active;
  }

  /** Only the opted-in pre-resource intent may be abandoned without native termination proof. */
  settleExpiredUnreservedAttempt(claim: InvestigationClaim, now: Date): InvestigationRecord | null {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (now.toISOString() <= active.lease_until || !isUnreservedPrelaunch(active) ||
        this.hasNativeThreadIntent(claim.attemptId)) return null;
      this.requireClosedSourceView(active);
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      if (!record || record.workspaceId !== claim.workspaceId || record.state !== 'queued' ||
        record.result !== null || record.attempts.length !== 1 || !attempt || attempt.state !== 'claimed' ||
        attempt.workerEpoch !== active.worker_epoch || attempt.nativeRef !== null ||
        attempt.startedAt !== null || attempt.finishedAt !== null || attempt.terminationConfirmed) throw new StoreConflict();
      const attempts = record.attempts.map(item => item.id === claim.attemptId ?
        { ...item, state: 'failed' as const, startedAt: null, finishedAt: now.toISOString(),
          terminationConfirmed: false } : item);
      const updated: InvestigationRecord = { ...record, state: 'failed', attempts, result: null,
        failureReason: 'abandoned_before_resource_reservation' };
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Current worker may extend its lease; an expired or fenced worker must reconcile. */
  renewLease(claim: InvestigationClaim, now: Date): InvestigationClaim {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('NOT_AVAILABLE');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (now.toISOString() >= active.lease_until) throw new StoreConflict();
      this.db.prepare('UPDATE investigation_active_attempts SET lease_until=? WHERE request_id=?')
        .run(new Date(now.getTime() + 30_000).toISOString(), claim.requestId);
      return claim;
    });
  }

  /** An uncertain worker keeps its attempt, source, native resource and occupied slot for reconciliation. */
  markRecoveryRequired(claim: InvestigationClaim, now: Date,
    reason?: 'model_prompt_limit_exceeded'): InvestigationClaim {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (now.toISOString() >= active.lease_until) throw new StoreConflict();
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      if (!record || record.workspaceId !== claim.workspaceId || record.result !== null ||
        !['queued', 'running', 'recovery_required'].includes(record.state) || !attempt ||
        !['claimed', 'running', 'recovery_required'].includes(attempt.state) ||
        attempt.workerEpoch !== active.worker_epoch || attempt.finishedAt !== null ||
        attempt.terminationConfirmed) throw new StoreConflict();
      const phase = active.native_ref !== null || active.container_id !== null ||
        active.wsl_invocation_id !== null ? 'reconcile' : 'unknown';
      this.db.prepare('UPDATE investigation_active_attempts SET phase=? WHERE request_id=?')
        .run(phase, claim.requestId);
      const attempts = record.attempts.map(item => item.id === claim.attemptId ?
        { ...item, state: 'recovery_required' as const } : item);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...record, state: 'recovery_required', attempts, result: null,
          ...(reason ? {failureReason: reason} : {}) }), claim.requestId);
      const wslResource = wslResourceFromRow(active);
      const sourceView = sourceViewFromRow(active);
      const windowsSource = windowsSourceFromRow(active);
      const dockerVolume = dockerVolumeFromRow(active);
      return { requestId: claim.requestId, attemptId: active.attempt_id, workerId: active.worker_id,
        workerEpoch: active.worker_epoch, workspaceId: active.workspace_id, nativeRef: active.native_ref,
        launchProtocol: active.launch_protocol, phase,
        ...(active.container_name === null ? {} : { containerName: active.container_name }),
        ...(active.container_id === null ? {} : { containerId: active.container_id }),
        ...(active.scratch_root === null ? {} : { scratchRoot: active.scratch_root }),
        ...(dockerVolume === undefined ? {} : { dockerVolume }),
        ...(wslResource === undefined ? {} : { wslResource }),
        ...(sourceView === undefined ? {} : { sourceView }),
        ...(windowsSource === undefined ? {} : { windowsSource }) };
    });
  }

  /** A timed-out lease is reconciled on the same attempt; no slot is released. */
  recoverAttempt(claim: InvestigationClaim, input: ClaimInput): InvestigationClaim {
    return this.withTransaction(() => {
      const record = this.get(claim.requestId);
      if (!record || record.workspaceId !== claim.workspaceId ||
        this.currentPermissionEpoch(record) !== input.permissionEpoch) throw new Error('NOT_AVAILABLE');
      this.verifyClaim(input, record);
      const active = this.activeFor(claim);
      if (input.now.toISOString() <= active.lease_until) throw new StoreConflict();
      if (isUnreservedPrelaunch(active)) throw new StoreConflict();
      const workerEpoch = active.worker_epoch + 1;
      const phase = active.native_ref || active.wsl_invocation_id ? 'reconcile' : 'unknown';
      this.db.prepare(`UPDATE investigation_active_attempts SET worker_id=?,worker_epoch=?,phase=?,lease_until=?,
        profile_revision=?,isolation_evidence=? WHERE request_id=?`)
        .run(input.workerId, workerEpoch, phase, new Date(input.now.getTime() + 30_000).toISOString(),
          input.profileRevision, input.isolationEvidence, claim.requestId);
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state: 'recovery_required' as const, workerEpoch } : attempt);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...record, state: 'recovery_required', attempts }), claim.requestId);
      const wslResource = wslResourceFromRow(active);
      const sourceView = sourceViewFromRow(active);
      const windowsSource = windowsSourceFromRow(active);
      const dockerVolume = dockerVolumeFromRow(active);
      return { ...claim, workerId: input.workerId, workerEpoch, nativeRef: active.native_ref,
        ...(active.container_name === null ? {} : { containerName: active.container_name }),
        ...(active.scratch_root === null ? {} : { scratchRoot: active.scratch_root }),
        ...(dockerVolume === undefined ? {} : { dockerVolume }),
        ...(wslResource === undefined ? {} : { wslResource }),
        ...(sourceView === undefined ? {} : { sourceView }),
        ...(windowsSource === undefined ? {} : { windowsSource }), phase };
    });
  }

  /** Cleanup-only takeover: no grant is needed to terminate an already owned worker. */
  acquireCleanupLease(claim: InvestigationClaim, workerId: string, now: Date): InvestigationClaim | null {
    if (!workerId || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (now.toISOString() <= active.lease_until) return null;
      if (!active.container_name || !active.scratch_root) return null;
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      const workerEpoch = active.worker_epoch + 1;
      this.db.prepare(`UPDATE investigation_active_attempts SET worker_id=?,worker_epoch=?,phase='reconcile',lease_until=?
        WHERE request_id=?`).run(workerId, workerEpoch, new Date(now.getTime() + 120_000).toISOString(), claim.requestId);
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state: 'recovery_required' as const, workerEpoch } : attempt);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...record, state: 'recovery_required', attempts, result: null }), claim.requestId);
      return { ...claim, workerId, workerEpoch, phase: 'reconcile', containerName: active.container_name,
        scratchRoot: active.scratch_root, ...(active.container_id ? { containerId: active.container_id } : {}) };
    });
  }

  /** Cleanup-only WSL takeover keeps the occupied slot and fences the previous worker. */
  acquireWslCleanupLease(claim: InvestigationClaim, workerId: string, now: Date): InvestigationClaim | null {
    if (!workerId || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const resource = wslResourceFromRow(active);
      if (!resource || active.container_name !== null) throw new StoreConflict();
      if (now.toISOString() <= active.lease_until) return null;
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      const workerEpoch = active.worker_epoch + 1;
      this.db.prepare(`UPDATE investigation_active_attempts SET worker_id=?,worker_epoch=?,phase='reconcile',lease_until=?
        WHERE request_id=?`).run(workerId, workerEpoch, new Date(now.getTime() + 120_000).toISOString(), claim.requestId);
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state: 'recovery_required' as const, workerEpoch } : attempt);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...record, state: 'recovery_required', attempts, result: null }), claim.requestId);
      const sourceView = sourceViewFromRow(active);
      return { ...claim, workerId, workerEpoch, nativeRef: active.native_ref,
        phase: 'reconcile', wslResource: resource,
        ...(sourceView ? { sourceView } : {}) };
    });
  }

  /** Cleanup authority is independent of source disclosure grants and never permits dispatch. */
  preflightClaudeModelCleanup(claim: InvestigationClaim, now: Date): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    const active = this.activeFor(claim);
    const { launch } = this.modelResource(claim);
    if (active.phase !== 'reconcile' || claim.phase !== 'reconcile' ||
        now.toISOString() >= active.lease_until || claim.workerEpoch <= launch.workerEpoch ||
        this.hasNativeThreadIntent(claim.attemptId)) throw new StoreConflict();
  }

  /** Original owner only: a stale epoch must never issue a close or pidfd tree probe. */
  preflightClaudeModelOriginalTermination(claim: InvestigationClaim, now: Date,
    minimumLeaseMs = 0): void {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(minimumLeaseMs) || minimumLeaseMs < 0 || minimumLeaseMs > 20_000)
      throw new Error('INVALID_ARGUMENT');
    this.withTransaction(() => {
      const active = this.activeFor(claim);
      const {launch} = this.modelResource(claim);
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      const outer = this.getModelOuterFact(claim);
      const running = this.getModelRunningObservation(claim);
      const intent = this.getModelPromptIntent(claim);
      if (claim.phase !== 'started' || active.phase !== 'started' ||
        claim.workerEpoch !== launch.workerEpoch || active.worker_epoch !== launch.workerEpoch ||
        claim.nativeRef !== active.native_ref || !claim.nativeRef ||
        new Date(now.getTime()+minimumLeaseMs).toISOString() >= active.lease_until || !outer ||
        !validateCurrentClaudeModelOuterFact(outer) || !running ||
        !isDeepStrictEqual(outer.observation.candidate.running,running) ||
        !intent || intent.launchEpoch !== launch.workerEpoch ||
        intent.nativeRef !== claim.nativeRef ||
        !record || record.result !== null || record.attempts.length !== 1 ||
        !attempt || attempt.workerEpoch !== claim.workerEpoch ||
        attempt.nativeRef !== claim.nativeRef || attempt.state !== 'running' ||
        attempt.finishedAt !== null || attempt.terminationConfirmed ||
        this.hasNativeThreadIntent(claim.attemptId)) throw new StoreConflict();
    });
  }

  /** A closed unconsumed model gate plus original unit terminal proves execution prevented only. */
  settleClaudeModelExecutionPrevented(claim: InvestigationClaim, observation: ModelTerminalObservation,
    receipt: string, now: Date): InvestigationRecord {
    if (typeof receipt !== 'string' || !receipt) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      this.preflightClaudeModelCleanup(claim, now);
      const { resource, launch } = this.modelResource(claim);
      const journal = observation?.journal;
      if (!observation || observation.kind !== 'model_unit_terminal' ||
          !isDeepStrictEqual(observation.resource, resource) || !journal?.closed ||
          !['entered', 'released'].includes(journal.phase)) throw new StoreConflict();
      try { claudeModelTerminalSpec(resource, journal, {
        attemptId: claim.attemptId, workspaceId: claim.workspaceId, distro: resource.distro,
        linuxUser: resource.gate!.linuxUser, uid: resource.uid, bootId: resource.bootId,
        unitName: resource.unitName, launchWorkerEpoch: launch.workerEpoch,
        sourceDigest: launch.sourceDigest, profileDigest: launch.profileDigest, commandDigest: launch.commandDigest!,
      }); } catch { throw new StoreConflict(); }
      const native = observation.native;
      if (!native || Object.keys(native).sort().join(',') !==
          'activeState,bootId,cgroupState,controlGroup,invocationId,loadState,mainPid,originalPid,originalStartTicks,processState,subState,uid,unitName' ||
          native.bootId !== resource.bootId || native.uid !== resource.uid || native.unitName !== resource.unitName ||
          native.mainPid !== 0 || native.originalPid !== journal.enterPid ||
          native.originalStartTicks !== journal.enterStartTicks || native.processState !== 'absent' ||
          !['empty', 'absent'].includes(native.cgroupState)) throw new StoreConflict();
      const loaded = native.loadState === 'loaded' && native.invocationId === resource.invocationId &&
        (native.controlGroup === resource.controlGroup || native.controlGroup === '') &&
        ((native.activeState === 'inactive' && native.subState === 'dead') ||
         (native.activeState === 'failed' && native.subState === 'failed'));
      const unloaded = native.loadState === 'not-found' && native.invocationId === '' &&
        native.controlGroup === '' && native.activeState === 'inactive' && native.subState === 'dead';
      if (!loaded && !unloaded) throw new StoreConflict();
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      if (!record || record.workspaceId !== claim.workspaceId || record.state !== 'recovery_required' ||
          record.result !== null || record.attempts.length !== 1 || !attempt ||
          attempt.state !== 'recovery_required' || attempt.workerEpoch !== claim.workerEpoch ||
          attempt.nativeRef !== claim.nativeRef || attempt.finishedAt !== null || attempt.terminationConfirmed) {
        throw new StoreConflict();
      }
      if (!this.claimAuthority?.verifyClaudeModelPreventionReceipt?.(claim, resource, observation, receipt)) {
        throw new StoreConflict();
      }
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const updated: InvestigationRecord = { ...record, state, result: null,
        failureReason: 'model_execution_prevented', attempts: record.attempts.map(item =>
          item.id === claim.attemptId ? { ...item, state, finishedAt: now.toISOString(), terminationConfirmed: false } : item) };
      this.db.prepare('INSERT INTO investigation_model_prevention_facts VALUES (?,?,?,?,?)')
        .run(claim.attemptId, claim.requestId, claim.workerEpoch, JSON.stringify(observation), now.toISOString());
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Consumed model cleanup requires historical confinement and a separate original-tree proof. */
  settleClaudeModelTreeTerminated(claim: InvestigationClaim,
    observation: ClaudeModelTreeTerminalObservation, receipt: string, now: Date): InvestigationRecord {
    if (typeof receipt !== 'string' || !receipt) throw new Error('INVALID_ARGUMENT');
    const clock = this.modelAuthorityClock(now);
    const saved = structuredClone({claim, observation});
    return this.withTransaction(() => {
      this.preflightClaudeModelCleanup(saved.claim, now);
      const {resource} = this.modelResource(saved.claim);
      const fact = this.getModelOuterFact(saved.claim);
      const running = this.getModelRunningObservation(saved.claim);
      if (!fact || !running || !isDeepStrictEqual(fact.observation.candidate.running, running) ||
        !validateClaudeModelTreeTerminal(fact, saved.observation)) throw new StoreConflict();
      const record = this.get(saved.claim.requestId);
      const attempt = record?.attempts.find(item => item.id === saved.claim.attemptId);
      if (!record || record.workspaceId !== saved.claim.workspaceId || record.state !== 'recovery_required' ||
        record.result !== null || record.attempts.length !== 1 || !attempt ||
        attempt.state !== 'recovery_required' || attempt.workerEpoch !== saved.claim.workerEpoch ||
        attempt.nativeRef !== saved.claim.nativeRef || attempt.finishedAt !== null ||
        attempt.terminationConfirmed) throw new StoreConflict();
      if (!this.claimAuthority?.verifyClaudeModelTreeReceipt?.(structuredClone(saved.claim),
        structuredClone(resource), structuredClone(fact), structuredClone(saved.observation), receipt))
        throw new StoreConflict();
      const current = clock();
      this.preflightClaudeModelCleanup(saved.claim, current);
      if (!isDeepStrictEqual(this.get(saved.claim.requestId), record)) throw new StoreConflict();
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const updated: InvestigationRecord = {...record, state, result: null,
        failureReason: 'model_tree_terminated_without_outcome', attempts: record.attempts.map(item =>
          item.id === saved.claim.attemptId ? {...item, state, finishedAt: current.toISOString(),
            terminationConfirmed: true} : item)};
      this.db.prepare('INSERT INTO investigation_model_tree_facts VALUES (?,?,?,?,?)')
        .run(saved.claim.attemptId, saved.claim.requestId, saved.claim.workerEpoch,
          JSON.stringify(saved.observation), current.toISOString());
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify(updated), saved.claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(saved.claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(saved.claim.requestId);
      return updated;
    });
  }

  /** Original started owner: tree termination and result publication share one transaction. */
  settleClaudeModelOriginalOutcome(claim: InvestigationClaim,
    observation: ClaudeModelTreeTerminalObservation, treeReceipt: string,
    verified: (VerifiedClaudeModelOriginalOutcome & {receipt: string}) | null,
    now: Date): InvestigationRecord {
    if (!treeReceipt || !(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new Error('INVALID_ARGUMENT');
    const clock = this.modelAuthorityClock(now);
    const saved = structuredClone({claim, observation, verified});
    return this.withTransaction(() => {
      const active = this.activeFor(saved.claim);
      const {resource, launch} = this.modelResource(saved.claim);
      const fact = this.getModelOuterFact(saved.claim);
      const running = this.getModelRunningObservation(saved.claim);
      const intent = this.getModelPromptIntent(saved.claim);
      const record = this.get(saved.claim.requestId);
      const attempt = record?.attempts.find(item => item.id === saved.claim.attemptId);
      if (active.phase !== 'started' || saved.claim.phase !== 'started' ||
        active.native_ref !== saved.claim.nativeRef ||
        active.worker_epoch !== launch.workerEpoch || saved.claim.workerEpoch !== launch.workerEpoch ||
        now.toISOString() >= active.lease_until || this.hasNativeThreadIntent(saved.claim.attemptId) ||
        !fact || !validateCurrentClaudeModelOuterFact(fact) ||
        !running || !isDeepStrictEqual(fact.observation.candidate.running, running) ||
        !intent || intent.launchEpoch !== launch.workerEpoch ||
        intent.nativeRef !== saved.claim.nativeRef ||
        intent.commandDigest !== launch.commandDigest ||
        !validateClaudeModelTreeTerminal(fact, saved.observation) ||
        !record || record.workspaceId !== saved.claim.workspaceId ||
        !['running', 'recovery_required'].includes(record.state) ||
        record.result !== null || record.attempts.length !== 1 || !attempt ||
        attempt.workerEpoch !== saved.claim.workerEpoch ||
        attempt.nativeRef !== saved.claim.nativeRef ||
        attempt.state !== 'running' || attempt.finishedAt !== null || attempt.terminationConfirmed)
        throw new StoreConflict();
      if (!this.claimAuthority?.verifyClaudeModelOriginalTreeReceipt?.(
        structuredClone(saved.claim), structuredClone(resource), structuredClone(fact),
        structuredClone(saved.observation), treeReceipt)) throw new StoreConflict();
      if (saved.verified) {
        const outcome = saved.verified;
        const candidate = outcome.candidate;
        const result = outcome.result;
        const started = attempt.startedAt ? Date.parse(attempt.startedAt) : NaN;
        const verifiedAt = Date.parse(outcome.verifiedAt);
        const receipts = this.getSucceededReadReceipts(saved.claim);
        if (!Number.isFinite(started) || !Number.isFinite(verifiedAt) ||
          verifiedAt < started || verifiedAt >= started + record.budget.maxWallSeconds * 1000 ||
          candidate.kind !== 'claude_model_original_owner_candidate_v1' ||
          candidate.requestId !== record.id || candidate.attemptId !== attempt.id ||
          candidate.workspaceId !== record.workspaceId || candidate.workerEpoch !== launch.workerEpoch ||
          candidate.nativeRef !== active.native_ref || candidate.promptHash !== intent.promptHash ||
          candidate.commandDigest !== intent.commandDigest ||
          result.requestId !== record.id || result.attemptId !== attempt.id ||
          result.snapshotRef !== record.snapshotRef ||
          result.contextRevisionId !== record.contextRevisionId ||
          result.resultState !== 'completed' ||
          new Set(result.evidence.map(item => item.toolReceipt)).size > record.budget.maxToolCalls ||
          !isDeepStrictEqual(outcome.evidenceReceiptIds,
            result.evidence.map(item => item.toolReceipt)) ||
          outcome.evidenceReceiptIds.some(id => !receipts.some(row => row.id === id)) ||
          !this.claimAuthority?.verifyClaudeModelOriginalOutcomeReceipt?.(
            structuredClone(saved.claim), structuredClone(resource), structuredClone(fact),
            structuredClone(intent), structuredClone({candidate: outcome.candidate,
              result: outcome.result, verifiedAt: outcome.verifiedAt,
              evidenceReceiptIds: outcome.evidenceReceiptIds}), outcome.receipt)) throw new StoreConflict();
      }
      const current = clock();
      const stillActive = this.activeFor(saved.claim);
      const currentRecord = this.get(saved.claim.requestId);
      if (stillActive.phase !== 'started' || stillActive.worker_epoch !== launch.workerEpoch ||
        stillActive.native_ref !== saved.claim.nativeRef || current.toISOString() >= stillActive.lease_until ||
        !currentRecord || currentRecord.result !== null || currentRecord.attempts.length !== 1 ||
        currentRecord.attempts[0]?.workerEpoch !== launch.workerEpoch ||
        currentRecord.attempts[0]?.nativeRef !== saved.claim.nativeRef ||
        currentRecord.attempts[0]?.finishedAt !== null) throw new StoreConflict();
      let authorized = stillActive.permission_epoch === this.currentPermissionEpoch(currentRecord);
      try {
        this.requireGrant(currentRecord, currentRecord.grantId, 'investigation.request');
        if (!this.hasReadScope(currentRecord, [...currentRecord.scope.paths,
          ...currentRecord.scope.relatedTests, ...(saved.verified?.result.coverage.searchedScope ?? []),
          ...(saved.verified?.result.evidence.map(item => item.path) ?? [])])) authorized = false;
        if (saved.verified && !currentRecord.cancelRequested) {
          const paths = [...new Set([...currentRecord.scope.paths,
            ...currentRecord.scope.relatedTests])].sort();
          for (const read of this.getSucceededReadReceipts(saved.claim)) {
            if (!read.workerGrantId || read.requestId !== currentRecord.id ||
              read.attemptId !== saved.claim.attemptId ||
              read.workspaceId !== currentRecord.workspaceId ||
              read.collaborationId !== currentRecord.collaborationId ||
              read.workingCopyId !== currentRecord.workingCopyId ||
              read.snapshotId !== currentRecord.snapshotRef ||
              read.contextRevisionId !== currentRecord.contextRevisionId ||
              read.launchEpoch !== launch.workerEpoch ||
              read.nativeRef !== saved.claim.nativeRef ||
              read.workerPrincipal !== saved.claim.workerId ||
              !paths.includes(read.path)) { authorized = false; break; }
            this.requireRunningReadAuthority(saved.claim, {
              collaborationId: read.collaborationId, workingCopyId: read.workingCopyId,
              snapshotId: read.snapshotId, paths, workerGrantId: read.workerGrantId,
              workerAudience: read.workerAudience, workerRecipient: read.workerRecipient,
            }, current);
          }
        }
      } catch { authorized = false; }
      const state = currentRecord.cancelRequested ? 'cancelled' as const :
        !authorized || !saved.verified ? 'failed' as const : 'completed' as const;
      const result: InvestigationResult | null = state === 'completed' ?
        {...saved.verified!.result,evidence:saved.verified!.result.evidence.map(
          ({byteRange: _range,...item})=>{void _range;return item;})} : null;
      const updated: InvestigationRecord = {...currentRecord, state, result,
        ...(state === 'failed' ? {failureReason: authorized ?
          'model_tree_terminated_without_outcome' as const : 'authorization_changed' as const} : {}),
        attempts: currentRecord.attempts.map(item => item.id === saved.claim.attemptId ?
          {...item, state, finishedAt: current.toISOString(), terminationConfirmed: true} : item)};
      this.db.prepare('INSERT INTO investigation_model_tree_facts VALUES (?,?,?,?,?)').run(
        saved.claim.attemptId, saved.claim.requestId, launch.workerEpoch,
        JSON.stringify(saved.observation), current.toISOString());
      if(state==='completed' && saved.verified) {
        this.db.prepare(`INSERT INTO investigation_model_outcome_provenance VALUES (?,?,?,?,?,?)`).run(
          saved.claim.attemptId,saved.claim.requestId,launch.workerEpoch,
          saved.claim.nativeRef,JSON.stringify({rawBytesSha256:saved.verified.candidate.rawBytesSha256,
            numTurns:saved.verified.candidate.numTurns,promptHash:saved.verified.candidate.promptHash,
            commandDigest:saved.verified.candidate.commandDigest,
            verifiedAt:saved.verified.verifiedAt,evidence:saved.verified.result.evidence}),
          current.toISOString());
      }
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify(updated), saved.claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(saved.claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(saved.claim.requestId);
      return updated;
    });
  }

  private requireClosedWindowsLaunch(claim: InvestigationClaim,
    source: WindowsSourceReservation, now: Date): CurrentWindowsAppServerLaunchRecord {
    const launch=this.readWindowsLaunch(claim.attemptId);
    if (!launch || !validCurrentWindowsAppServerLaunchBinding(launch.binding) ||
      source.descriptor.attemptId!==claim.attemptId ||
      source.descriptor.workspaceId!==claim.workspaceId ||
      launch.requestId!==claim.requestId || launch.attemptId!==claim.attemptId ||
      launch.workspaceId!==claim.workspaceId || launch.launchEpoch!==source.descriptor.workerEpoch ||
      launch.binding.sourceDigest!==source.descriptor.sourceDigest ||
      !launch.identity || !['observed','recovery_required'].includes(launch.state))
      throw new StoreConflict();
    const closure=this.readWindowsLaunchClosure(launch.launchId);
    if (!closure || closure.launchId!==launch.launchId ||
      closure.observation.launchId!==launch.launchId ||
      closure.observation.hostScopeId!==launch.binding.hostScopeId ||
      closure.observation.executionInstanceId!==launch.binding.executionInstanceId ||
      closure.observation.root.pid!==launch.identity.pid ||
      closure.observation.root.creationFiletime!==launch.identity.creationFiletime ||
      launch.identity.hostScopeId!==launch.binding.hostScopeId ||
      launch.identity.executionInstanceId!==launch.binding.executionInstanceId ||
      Date.parse(closure.recordedAt)>now.getTime())
      throw new StoreConflict();
    return {...launch,binding:launch.binding};
  }

  private requireNotStartedWindowsLaunch(claim: InvestigationClaim,
    source: WindowsSourceReservation, now: Date): CurrentWindowsAppServerLaunchRecord {
    const launch=this.readWindowsLaunch(claim.attemptId);
    if (!launch || !validCurrentWindowsAppServerLaunchBinding(launch.binding) ||
      launch.state!=='recovery_required' || launch.identity!==null || launch.observedAt!==null ||
      source.descriptor.attemptId!==claim.attemptId ||
      source.descriptor.workspaceId!==claim.workspaceId ||
      launch.requestId!==claim.requestId || launch.workspaceId!==claim.workspaceId ||
      launch.launchEpoch!==source.descriptor.workerEpoch ||
      launch.binding.sourceDigest!==source.descriptor.sourceDigest ||
      this.readWindowsLaunchClosure(launch.launchId) ||
      this.db.prepare('SELECT 1 FROM investigation_native_threads WHERE attempt_id=?')
        .get(claim.attemptId) ||
      this.db.prepare('SELECT 1 FROM investigation_native_turns WHERE attempt_id=?')
        .get(claim.attemptId)) throw new StoreConflict();
    const intent=this.readWindowsLaunchStartIntent(launch.launchId);
    const fact=this.readWindowsLaunchNotStarted(launch.launchId);
    if (!intent || intent.reservedAt!==launch.intentAt || !fact ||
      fact.observation.launchId!==launch.launchId ||
      fact.observation.hostScopeId!==launch.binding.hostScopeId ||
      fact.observation.executionInstanceId!==launch.binding.executionInstanceId ||
      Date.parse(fact.recordedAt)>now.getTime()) throw new StoreConflict();
    return {...launch,binding:launch.binding};
  }

  /** One cleanup takeover after an independently verified no-child transcript. */
  acquireNotStartedWindowsLaunchCleanupLease(claim: InvestigationClaim, workerId: string,
    now: Date): InvestigationClaim | null {
    if (!workerId || !(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active=this.activeFor(claim),source=windowsSourceFromRow(active);
      if (!source || !claim.windowsSource || JSON.stringify(source)!==JSON.stringify(claim.windowsSource) ||
        source.preparedAt===null || active.launch_protocol!=='resource_reservation_v1' ||
        active.native_ref!==null || active.container_name!==null || active.container_id!==null ||
        active.scratch_root!==null || wslResourceFromRow(active) || sourceViewFromRow(active))
        throw new StoreConflict();
      const launch=this.requireNotStartedWindowsLaunch(claim,source,now);
      const lease=Date.parse(active.lease_until);
      if (!Number.isFinite(lease)) throw new StoreConflict();
      if (now.getTime()<=lease) return null;
      const record=this.get(claim.requestId);
      const attempt=record?.attempts.find(item=>item.id===claim.attemptId);
      if (!record || record.workspaceId!==claim.workspaceId ||
        record.collaborationId!==launch.collaborationId || record.result!==null ||
        record.attempts.length!==1 || !attempt || attempt.finishedAt!==null ||
        attempt.terminationConfirmed || attempt.nativeRef!==null || attempt.startedAt!==null ||
        attempt.workerEpoch!==active.worker_epoch ||
        !['queued','running','recovery_required'].includes(record.state) ||
        !['claimed','running','recovery_required'].includes(attempt.state)) throw new StoreConflict();
      const workerEpoch=active.worker_epoch+1;
      this.db.prepare(`UPDATE investigation_active_attempts SET worker_id=?,worker_epoch=?,
        phase='reconcile',lease_until=? WHERE request_id=?`).run(workerId,workerEpoch,
        new Date(now.getTime()+120_000).toISOString(),claim.requestId);
      const attempts=record.attempts.map(item=>item.id===claim.attemptId ?
        {...item,state:'recovery_required' as const,workerEpoch} : item);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(
        JSON.stringify({...record,state:'recovery_required',attempts,result:null}),claim.requestId);
      return {...claim,workerId,workerEpoch,nativeRef:null,phase:'reconcile' as const,
        windowsSource:source};
    });
  }

  settleNotStartedWindowsLaunchAttempt(claim: InvestigationClaim, sourceClosed: {
    kind:'closed';descriptor:WindowsSourceDescriptor;viewPath:string;isolationVerified:false
  }, now: Date): InvestigationRecord {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active=this.activeFor(claim),source=windowsSourceFromRow(active);
      if (!source || !claim.windowsSource || JSON.stringify(source)!==JSON.stringify(claim.windowsSource) ||
        source.preparedAt===null || active.launch_protocol!=='resource_reservation_v1' ||
        active.phase!=='reconcile' || active.native_ref!==null ||
        active.container_name!==null || active.container_id!==null || active.scratch_root!==null ||
        wslResourceFromRow(active) || sourceViewFromRow(active) ||
        !(Date.parse(active.lease_until)>now.getTime())) throw new StoreConflict();
      const launch=this.requireNotStartedWindowsLaunch(claim,source,now);
      const fact:WindowsLaunchSettlementFact={cleanupWorkerId:claim.workerId,
        cleanupEpoch:claim.workerEpoch,settledAt:now.toISOString(),privateRoot:source.privateRoot,
        sourceClosed};
      if (!validWindowsLaunchSettlementFact(fact) ||
        !isDeepStrictEqual(sourceClosed.descriptor,source.descriptor) ||
        sourceClosed.viewPath!==win32.join(source.privateRoot,`${claim.attemptId}.view`) ||
        claim.workerEpoch<=launch.launchEpoch) throw new StoreConflict();
      const record=this.get(claim.requestId),attempt=record?.attempts.find(item=>item.id===claim.attemptId);
      if (!record || record.workspaceId!==claim.workspaceId ||
        record.collaborationId!==launch.collaborationId || record.state!=='recovery_required' ||
        record.result!==null || record.attempts.length!==1 || !attempt ||
        attempt.state!=='recovery_required' || attempt.workerEpoch!==claim.workerEpoch ||
        attempt.nativeRef!==null || attempt.startedAt!==null ||
        attempt.finishedAt!==null || attempt.terminationConfirmed)
        throw new StoreConflict();
      const state=record.cancelRequested?'cancelled' as const:'failed' as const;
      const attempts=record.attempts.map(item=>item.id===claim.attemptId ?
        {...item,state,finishedAt:now.toISOString(),terminationConfirmed:false} : item);
      const updated:InvestigationRecord={...record,state,attempts,result:null,
        failureReason:'windows_launch_not_started'};
      this.db.prepare(`INSERT INTO investigation_windows_not_started_settlement_facts
        (attempt_id,request_id,launch_id,cleanup_epoch,fact_json) VALUES (?,?,?,?,?)`).run(
        claim.attemptId,claim.requestId,launch.launchId,claim.workerEpoch,JSON.stringify(fact));
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(
        JSON.stringify(updated),claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Only a saved exact Job closure permits takeover of a launched Windows attempt. */
  acquireClosedWindowsLaunchCleanupLease(claim: InvestigationClaim, workerId: string,
    now: Date): InvestigationClaim | null {
    if (!workerId || !(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active=this.activeFor(claim);
      const source=windowsSourceFromRow(active);
      if (!source || !claim.windowsSource || JSON.stringify(source)!==JSON.stringify(claim.windowsSource) ||
        source.preparedAt===null || active.launch_protocol!=='resource_reservation_v1' ||
        active.native_ref!==null || active.container_name!==null || active.container_id!==null ||
        active.scratch_root!==null || wslResourceFromRow(active) || sourceViewFromRow(active))
        throw new StoreConflict();
      const launch=this.requireClosedWindowsLaunch(claim,source,now);
      const lease=Date.parse(active.lease_until);
      if (!Number.isFinite(lease)) throw new StoreConflict();
      if (now.getTime()<=lease) return null;
      const record=this.get(claim.requestId);
      const attempt=record?.attempts.find(item=>item.id===claim.attemptId);
      if (!record || record.workspaceId!==claim.workspaceId ||
        record.collaborationId!==launch.collaborationId || record.result!==null ||
        record.attempts.length!==1 || !attempt || attempt.finishedAt!==null ||
        attempt.terminationConfirmed || attempt.nativeRef!==null ||
        attempt.workerEpoch!==active.worker_epoch ||
        !['queued','running','recovery_required'].includes(record.state) ||
        !['claimed','running','recovery_required'].includes(attempt.state)) throw new StoreConflict();
      const workerEpoch=active.worker_epoch+1;
      this.db.prepare(`UPDATE investigation_active_attempts SET worker_id=?,worker_epoch=?,
        phase='reconcile',lease_until=? WHERE request_id=?`).run(workerId,workerEpoch,
        new Date(now.getTime()+120_000).toISOString(),claim.requestId);
      const attempts=record.attempts.map(item=>item.id===claim.attemptId ?
        {...item,state:'recovery_required' as const,workerEpoch} : item);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(
        JSON.stringify({...record,state:'recovery_required',attempts,result:null}),claim.requestId);
      if (launch.state!=='recovery_required') {
        const updated={...launch,state:'recovery_required' as const,
          recoveryRequiredAt:now.toISOString()};
        this.db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?
          WHERE launch_id=?`).run(JSON.stringify(updated),launch.launchId);
      }
      return {...claim,workerId,workerEpoch,nativeRef:null,phase:'reconcile' as const,
        windowsSource:source};
    });
  }

  /** Atomically record exact local Job and source closure, then release the occupied slot. */
  settleClosedWindowsLaunchAttempt(claim: InvestigationClaim, sourceClosed: {
    kind:'closed';descriptor:WindowsSourceDescriptor;viewPath:string;isolationVerified:false
  }, now: Date): InvestigationRecord {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active=this.activeFor(claim);
      const source=windowsSourceFromRow(active);
      if (!source || !claim.windowsSource || JSON.stringify(source)!==JSON.stringify(claim.windowsSource) ||
        source.preparedAt===null || active.launch_protocol!=='resource_reservation_v1' ||
        active.phase!=='reconcile' || active.native_ref!==null ||
        active.container_name!==null || active.container_id!==null || active.scratch_root!==null ||
        wslResourceFromRow(active) || sourceViewFromRow(active) ||
        !(Date.parse(active.lease_until)>now.getTime())) throw new StoreConflict();
      const launch=this.requireClosedWindowsLaunch(claim,source,now);
      const fact:WindowsLaunchSettlementFact={cleanupWorkerId:claim.workerId,
        cleanupEpoch:claim.workerEpoch,settledAt:now.toISOString(),privateRoot:source.privateRoot,
        sourceClosed};
      if (!validWindowsLaunchSettlementFact(fact) ||
        !isDeepStrictEqual(sourceClosed.descriptor,source.descriptor) ||
        sourceClosed.viewPath!==win32.join(source.privateRoot,`${claim.attemptId}.view`) ||
        claim.workerEpoch<=launch.launchEpoch) throw new StoreConflict();
      const record=this.get(claim.requestId);
      const attempt=record?.attempts.find(item=>item.id===claim.attemptId);
      if (!record || record.workspaceId!==claim.workspaceId ||
        record.collaborationId!==launch.collaborationId || record.state!=='recovery_required' ||
        record.result!==null || record.attempts.length!==1 || !attempt ||
        attempt.state!=='recovery_required' || attempt.workerEpoch!==claim.workerEpoch ||
        attempt.nativeRef!==null || attempt.finishedAt!==null || attempt.terminationConfirmed)
        throw new StoreConflict();
      const state=record.cancelRequested?'cancelled' as const:'failed' as const;
      const attempts=record.attempts.map(item=>item.id===claim.attemptId ?
        {...item,state,finishedAt:now.toISOString(),terminationConfirmed:true} : item);
      const updated:InvestigationRecord={...record,state,attempts,result:null,
        failureReason:'windows_launch_closed_without_outcome'};
      this.db.prepare(`INSERT INTO investigation_windows_launch_settlement_facts
        (attempt_id,request_id,launch_id,cleanup_epoch,fact_json) VALUES (?,?,?,?,?)`).run(
        claim.attemptId,claim.requestId,launch.launchId,claim.workerEpoch,JSON.stringify(fact));
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(
        JSON.stringify(updated),claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Cleanup-only Windows takeover retains the occupied slot and fences the staging worker. */
  acquireWindowsSourceCleanupLease(claim: InvestigationClaim, workerId: string,
    now: Date): InvestigationClaim | null {
    if (!workerId || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      this.assertNoNativeThreadIntent(claim.attemptId);
      const source = windowsSourceFromRow(active);
      if (!source || !claim.windowsSource || JSON.stringify(source) !== JSON.stringify(claim.windowsSource) ||
        active.launch_protocol !== 'resource_reservation_v1' || active.native_ref !== null ||
        active.container_name !== null || active.container_id !== null || active.scratch_root !== null ||
        wslResourceFromRow(active) || sourceViewFromRow(active)) throw new StoreConflict();
      if (now.toISOString() <= active.lease_until) return null;
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      if (!record || record.workspaceId !== claim.workspaceId || record.result !== null ||
        record.attempts.length !== 1 || !attempt || attempt.nativeRef !== null ||
        attempt.startedAt !== null || attempt.finishedAt !== null || attempt.terminationConfirmed) throw new StoreConflict();
      const workerEpoch = active.worker_epoch + 1;
      this.db.prepare(`UPDATE investigation_active_attempts SET worker_id=?,worker_epoch=?,phase='reconcile',lease_until=?
        WHERE request_id=?`).run(workerId, workerEpoch, new Date(now.getTime() + 120_000).toISOString(), claim.requestId);
      const attempts = record.attempts.map(item => item.id === claim.attemptId ?
        { ...item, state: 'recovery_required' as const, workerEpoch } : item);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...record, state: 'recovery_required', attempts, result: null }), claim.requestId);
      return { ...claim, workerId, workerEpoch, nativeRef: null, phase: 'reconcile', windowsSource: source };
    });
  }

  /** Release a Windows host staging reservation only after the exact view has been closed. */
  settleClosedWindowsSourceAttempt(claim: InvestigationClaim, closure: {
    kind: 'closed'; descriptor: WindowsSourceDescriptor; viewPath: string; isolationVerified: false
  }, now: Date): InvestigationRecord {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (this.hasNativeThreadIntent(claim.attemptId)) throw new StoreConflict();
      const source = windowsSourceFromRow(active);
      if (!source || !claim.windowsSource || JSON.stringify(source) !== JSON.stringify(claim.windowsSource) ||
        !closure || Object.keys(closure).sort().join(',') !== 'descriptor,isolationVerified,kind,viewPath' ||
        closure.kind !== 'closed' || closure.isolationVerified !== false ||
        !validWindowsSourceDescriptor(closure.descriptor) ||
        Object.keys(source.descriptor).some(key =>
          source.descriptor[key as keyof WindowsSourceDescriptor] !==
          closure.descriptor[key as keyof WindowsSourceDescriptor]) ||
        closure.viewPath !== win32.join(source.privateRoot, `${claim.attemptId}.view`) ||
        active.launch_protocol !== 'resource_reservation_v1' || active.phase !== 'reconcile' ||
        now.toISOString() >= active.lease_until || active.native_ref !== null ||
        active.container_name !== null || active.container_id !== null || active.scratch_root !== null ||
        wslResourceFromRow(active) || sourceViewFromRow(active)) throw new StoreConflict();
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      if (!record || record.workspaceId !== claim.workspaceId || record.state !== 'recovery_required' ||
        record.result !== null || record.attempts.length !== 1 || !attempt ||
        attempt.state !== 'recovery_required' || attempt.workerEpoch !== active.worker_epoch ||
        attempt.nativeRef !== null || attempt.startedAt !== null || attempt.finishedAt !== null ||
        attempt.terminationConfirmed) throw new StoreConflict();
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const attempts = record.attempts.map(item => item.id === claim.attemptId ?
        { ...item, state, finishedAt: now.toISOString(), terminationConfirmed: false } : item);
      const updated: InvestigationRecord = { ...record, state, attempts, result: null,
        failureReason: 'closed_before_native_launch' };
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** A durable closed gate proves the fixed canary payload could not enter. It is not a termination receipt. */
  settleClosedUnconsumedWslAttempt(claim: InvestigationClaim, closure: {
    kind: string; attemptId: string; workspaceId: string;
    bootId: string; uid: number; unitName: string;
  }, now: Date): InvestigationRecord {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (this.hasNativeThreadIntent(claim.attemptId)) throw new StoreConflict();
      const resource = wslResourceFromRow(active);
      this.requireClosedSourceView(active);
      if (!closure || typeof closure !== 'object' || Object.keys(closure).length !== 6 ||
        closure.kind !== 'closed_unconsumed' || closure.attemptId !== claim.attemptId ||
        closure.workspaceId !== claim.workspaceId || closure.bootId !== resource?.bootId ||
        closure.uid !== resource.uid || closure.unitName !== resource.unitName ||
        active.launch_protocol !== 'resource_reservation_v1' || active.phase !== 'reconcile' ||
        now.toISOString() >= active.lease_until || active.native_ref !== null ||
        active.container_name !== null || active.container_id !== null || active.scratch_root !== null ||
        !resource.gate || resource.gate.protocol !== 'attempt_gate_v1' ||
        resource.gate.payloadKind !== 'canary_v1' ||
        resource.invocationId !== null || resource.controlGroup !== null) throw new StoreConflict();
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      if (!record || record.workspaceId !== claim.workspaceId || record.result !== null ||
        record.attempts.length !== 1 || !attempt || attempt.state !== 'recovery_required' ||
        attempt.workerEpoch !== active.worker_epoch || attempt.nativeRef !== null ||
        attempt.startedAt !== null || attempt.finishedAt !== null || attempt.terminationConfirmed) throw new StoreConflict();
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const attempts = record.attempts.map(item => item.id === claim.attemptId ?
        { ...item, state, finishedAt: now.toISOString(), terminationConfirmed: false } : item);
      const updated: InvestigationRecord = { ...record, state, attempts, result: null,
        failureReason: 'closed_before_native_launch' };
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Legacy WSL and fixed canary settlement; model supervisors need a distinct terminal proof path. */
  finishWslCleanup(claim: InvestigationClaim, receipt: string, now: Date): InvestigationRecord {
    if (!receipt || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      this.assertNoNativeThreadIntent(claim.attemptId);
      const resource = wslResourceFromRow(active);
      this.requireClosedSourceView(active);
      if (resource?.gate && resource.gate.payloadKind !== 'canary_v1') throw new StoreConflict();
      if (active.phase !== 'reconcile' || now.toISOString() >= active.lease_until ||
        !resource || !resource.invocationId || !resource.controlGroup) throw new StoreConflict();
      if (this.claimAuthority?.verifyWslTerminationReceipt?.(claim, resource, receipt) !== true) throw new Error('NOT_AVAILABLE');
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state, finishedAt: now.toISOString(), terminationConfirmed: true } : attempt);
      const updated: InvestigationRecord = { ...record, state, attempts, result: null };
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Settle only the fixed zero-model diagnostic after an independently verified exact-unit terminal receipt. */
  settleSupervisorV2Diagnostic(claim: InvestigationClaim, expectedLaunch: NativeSupervisorLaunchBinding,
    journal: NativeSupervisorGateState, receipt: string, now: Date): InvestigationRecord {
    if (!validSupervisorLaunchBinding(expectedLaunch) || typeof receipt !== 'string' ||
      receipt.length < 1 || receipt.length > 128 ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      this.assertNoNativeThreadIntent(claim.attemptId);
      const resource = wslResourceFromRow(active);
      const source = sourceViewFromRow(active);
      const launch = resource?.gate?.launch;
      const submittedResource = claim.wslResource;
      const submittedSource = claim.sourceView;
      const expectedControlGroup = resource &&
        `/user.slice/user-${resource.uid}.slice/user@${resource.uid}.service/app.slice/${resource.unitName}`;
      if (active.launch_protocol !== 'resource_reservation_v1' ||
        claim.launchProtocol !== 'resource_reservation_v1' ||
        active.phase !== 'reconcile' || claim.phase !== 'reconcile' ||
        claim.nativeRef !== null || now.toISOString() >= active.lease_until ||
        active.native_ref !== null || active.container_name !== null || active.container_id !== null ||
        active.scratch_root !== null || !resource || resource.gate?.payloadKind !== 'native_supervisor_v2' ||
        !launch || launch.action !== 'fixed_zero_model_v1' ||
        launch.profileDigest !== FIXED_ZERO_MODEL_PROFILE_DIGEST ||
        !sameSupervisorLaunchBinding(launch, expectedLaunch) ||
        claim.workerEpoch <= launch.workerEpoch ||
        !resource.invocationId || !resource.controlGroup ||
        resource.controlGroup !== expectedControlGroup ||
        !submittedResource || submittedResource.unitName !== resource.unitName ||
        submittedResource.distro !== resource.distro || submittedResource.uid !== resource.uid ||
        submittedResource.bootId !== resource.bootId ||
        submittedResource.invocationId !== resource.invocationId ||
        submittedResource.controlGroup !== resource.controlGroup ||
        !sameGateBinding(submittedResource.gate, resource.gate) ||
        !source || source.closedAt === null || !submittedSource ||
        submittedSource.closedAt !== source.closedAt ||
        submittedSource.privateRoot !== source.privateRoot ||
        Object.keys(source.descriptor).some(key => source.descriptor[key as keyof SourceViewDescriptor] !==
          submittedSource.descriptor?.[key as keyof SourceViewDescriptor]) ||
        source.descriptor.attemptId !== claim.attemptId ||
        source.descriptor.workspaceId !== claim.workspaceId ||
        source.descriptor.workerEpoch !== launch.workerEpoch ||
        source.descriptor.sourceDigest !== launch.sourceDigest ||
        source.descriptor.distro !== resource.distro || source.descriptor.uid !== resource.uid ||
        source.descriptor.bootId !== resource.bootId ||
        source.descriptor.linuxUser !== resource.gate.linuxUser ||
        !journal || journal.protocol !== 'native_supervisor_v2' ||
        journal.phase !== 'consumed' || !journal.closed ||
        journal.attemptId !== claim.attemptId || journal.workspaceId !== claim.workspaceId ||
        journal.bootId !== resource.bootId || journal.uid !== resource.uid ||
        journal.unitName !== resource.unitName ||
        journal.invocationId !== resource.invocationId ||
        journal.controlGroup !== resource.controlGroup ||
        journal.launchWorkerEpoch !== launch.workerEpoch ||
        journal.sourceDigest !== launch.sourceDigest ||
        journal.profileDigest !== launch.profileDigest) throw new StoreConflict();
      const descriptor = { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
        distro: resource.distro, linuxUser: resource.gate.linuxUser,
        bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
        launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
        profileDigest: launch.profileDigest };
      if (parseNativeSupervisorGateOutput(JSON.stringify(journal) + '\n', descriptor)?.protocol !==
        'native_supervisor_v2') throw new StoreConflict();
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      if (!record || record.workspaceId !== claim.workspaceId ||
        record.state !== 'recovery_required' || record.result !== null ||
        record.attempts.length !== 1 || !attempt || attempt.state !== 'recovery_required' ||
        attempt.workerEpoch !== active.worker_epoch || attempt.nativeRef !== null ||
        attempt.startedAt !== null || attempt.finishedAt !== null ||
        attempt.terminationConfirmed) throw new StoreConflict();
      if (this.claimAuthority?.verifySupervisorV2TerminalReceipt?.(claim, resource,
        launch, journal, receipt) !== true) throw new Error('NOT_AVAILABLE');
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const attempts = record.attempts.map(item => item.id === claim.attemptId ?
        { ...item, state, finishedAt: now.toISOString(), terminationConfirmed: true } : item);
      const updated: InvestigationRecord = { ...record, state, attempts, result: null };
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** A closed, still-prepared v2 journal proves the fixed action never entered. */
  settleClosedPreparedSupervisorV2Attempt(claim: InvestigationClaim,
    expectedLaunch: NativeSupervisorLaunchBinding, journal: NativeSupervisorGateState,
    now: Date): InvestigationRecord {
    if (!validSupervisorLaunchBinding(expectedLaunch) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (this.hasNativeThreadIntent(claim.attemptId)) throw new StoreConflict();
      const resource = wslResourceFromRow(active);
      const source = sourceViewFromRow(active);
      const launch = resource?.gate?.launch;
      const submittedResource = claim.wslResource;
      const submittedSource = claim.sourceView;
      if (active.launch_protocol !== 'resource_reservation_v1' ||
        claim.launchProtocol !== 'resource_reservation_v1' ||
        active.phase !== 'reconcile' || claim.phase !== 'reconcile' ||
        claim.nativeRef !== null || now.toISOString() >= active.lease_until ||
        active.native_ref !== null || active.container_name !== null || active.container_id !== null ||
        active.scratch_root !== null || !resource || resource.gate?.payloadKind !== 'native_supervisor_v2' ||
        !launch || launch.action !== 'fixed_zero_model_v1' ||
        launch.profileDigest !== FIXED_ZERO_MODEL_PROFILE_DIGEST ||
        !sameSupervisorLaunchBinding(launch, expectedLaunch) ||
        claim.workerEpoch <= launch.workerEpoch ||
        resource.invocationId !== null || resource.controlGroup !== null ||
        !submittedResource || submittedResource.unitName !== resource.unitName ||
        submittedResource.distro !== resource.distro || submittedResource.uid !== resource.uid ||
        submittedResource.bootId !== resource.bootId ||
        submittedResource.invocationId !== null || submittedResource.controlGroup !== null ||
        !sameGateBinding(submittedResource.gate, resource.gate) ||
        !source || source.closedAt === null || !submittedSource ||
        submittedSource.closedAt !== source.closedAt ||
        submittedSource.privateRoot !== source.privateRoot ||
        Object.keys(source.descriptor).some(key => source.descriptor[key as keyof SourceViewDescriptor] !==
          submittedSource.descriptor?.[key as keyof SourceViewDescriptor]) ||
        source.descriptor.attemptId !== claim.attemptId ||
        source.descriptor.workspaceId !== claim.workspaceId ||
        source.descriptor.workerEpoch !== launch.workerEpoch ||
        source.descriptor.sourceDigest !== launch.sourceDigest ||
        source.descriptor.distro !== resource.distro || source.descriptor.uid !== resource.uid ||
        source.descriptor.bootId !== resource.bootId ||
        source.descriptor.linuxUser !== resource.gate.linuxUser ||
        !journal || journal.protocol !== 'native_supervisor_v2' ||
        journal.phase !== 'prepared' || !journal.closed ||
        journal.attemptId !== claim.attemptId || journal.workspaceId !== claim.workspaceId ||
        journal.bootId !== resource.bootId || journal.uid !== resource.uid ||
        journal.unitName !== resource.unitName ||
        journal.launchWorkerEpoch !== launch.workerEpoch ||
        journal.sourceDigest !== launch.sourceDigest ||
        journal.profileDigest !== launch.profileDigest) throw new StoreConflict();
      const descriptor = { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
        distro: resource.distro, linuxUser: resource.gate.linuxUser,
        bootId: resource.bootId, uid: resource.uid, unitName: resource.unitName,
        launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
        profileDigest: launch.profileDigest };
      if (parseNativeSupervisorGateOutput(JSON.stringify(journal) + '\n', descriptor)?.protocol !==
        'native_supervisor_v2') throw new StoreConflict();
      const record = this.get(claim.requestId);
      const attempt = record?.attempts.find(item => item.id === claim.attemptId);
      if (!record || record.workspaceId !== claim.workspaceId ||
        record.state !== 'recovery_required' || record.result !== null ||
        record.attempts.length !== 1 || !attempt || attempt.state !== 'recovery_required' ||
        attempt.workerEpoch !== active.worker_epoch || attempt.nativeRef !== null ||
        attempt.startedAt !== null || attempt.finishedAt !== null ||
        attempt.terminationConfirmed) throw new StoreConflict();
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const attempts = record.attempts.map(item => item.id === claim.attemptId ?
        { ...item, state, finishedAt: now.toISOString(), terminationConfirmed: false } : item);
      const updated: InvestigationRecord = { ...record, state, attempts, result: null,
        failureReason: 'closed_before_native_launch' };
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Write the observed immutable daemon identity before any removal call. */
  recordObservedContainer(claim: InvestigationClaim, id: string, now: Date): InvestigationClaim {
    if (!/^[0-9a-f]{64}$/.test(id) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (!['start_intent', 'started', 'reconcile'].includes(active.phase) || now.toISOString() >= active.lease_until ||
        !active.container_name || !active.scratch_root || (active.container_id && active.container_id !== id)) throw new StoreConflict();
      if (!active.container_id) this.db.prepare('UPDATE investigation_active_attempts SET container_id=? WHERE request_id=?')
        .run(id, claim.requestId);
      return { ...claim, containerId: id };
    });
  }

  /** Called after exact-ID removal and owned scratch deletion have both been confirmed. */
  finishCleanup(claim: InvestigationClaim, now: Date): InvestigationRecord {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_ARGUMENT');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      this.assertNoNativeThreadIntent(claim.attemptId);
      this.requireClosedSourceView(active);
      if (active.phase !== 'reconcile' || now.toISOString() >= active.lease_until || !active.container_id ||
        active.docker_volume_json !== null) throw new StoreConflict();
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      const state = record.cancelRequested ? 'cancelled' as const : 'failed' as const;
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state, finishedAt: now.toISOString(), terminationConfirmed: true } : attempt);
      const updated: InvestigationRecord = { ...record, state, attempts, result: null };
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(JSON.stringify(updated), claim.requestId);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(claim.requestId);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(claim.requestId);
      return updated;
    });
  }

  /** Accepts only an adapter-verified native identity receipt under the current fencing epoch. */
  recordNativeStart(claim: InvestigationClaim, nativeRef: string, receipt: string, now: Date): InvestigationClaim {
    if (!this.claimAuthority?.verifyNativeReceipt(claim, nativeRef, receipt) || !Number.isFinite(now.getTime())) throw new Error('NOT_AVAILABLE');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      if (active.docker_volume_json !== null) throw new StoreConflict();
      if (active.launch_protocol === 'resource_reservation_v1') {
        const dockerObserved = active.container_name !== null && active.scratch_root !== null &&
          active.container_id !== null && active.wsl_unit_name === null;
        const wslObserved = active.wsl_unit_name !== null && active.wsl_distro !== null &&
          active.wsl_uid !== null && active.wsl_boot_id !== null && active.wsl_invocation_id !== null &&
          active.wsl_control_group !== null && active.container_name === null && active.container_id === null &&
          active.scratch_root === null;
        if (active.phase !== 'start_intent' || (!dockerObserved && !wslObserved)) throw new StoreConflict();
      }
      if (active.wsl_unit_name !== null &&
        (!active.wsl_invocation_id || !active.wsl_control_group)) throw new StoreConflict();
      if (active.wsl_unit_name !== null) {
        const saved = wslResourceFromRow(active);
        const supplied = claim.wslResource;
        if (!saved || !supplied || supplied.unitName !== saved.unitName ||
          supplied.distro !== saved.distro || supplied.uid !== saved.uid ||
          supplied.bootId !== saved.bootId || supplied.invocationId !== saved.invocationId ||
          supplied.controlGroup !== saved.controlGroup || !sameGateBinding(supplied.gate, saved.gate)) {
          throw new StoreConflict();
        }
      }
      if (now.toISOString() >= active.lease_until) throw new StoreConflict();
      if (active.native_ref && active.native_ref !== nativeRef) throw new StoreConflict();
      const record = this.get(claim.requestId);
      if (!record) throw new StoreConflict();
      let launchAuthorized = !record.cancelRequested;
      if (launchAuthorized) {
        try {
          const selectedPaths = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
          if (active.launch_protocol === null && (active.phase === 'unknown' || active.phase === 'reconcile')) {
            const current = this.requireCurrentInvestigationAuthority(claim, active, now, selectedPaths);
            if (current.record.state !== 'recovery_required' || current.attempt.state !== 'recovery_required' ||
              (active.phase === 'reconcile' && active.native_ref !== nativeRef &&
                active.wsl_invocation_id === null)) throw new StoreConflict();
          } else this.requireCurrentSourceAuthority(claim, active, now, selectedPaths);
        } catch { launchAuthorized = false; }
      }
      if (!launchAuthorized) {
        this.db.prepare(`UPDATE investigation_active_attempts SET phase='reconcile',native_ref=? WHERE request_id=?`)
          .run(nativeRef, claim.requestId);
        const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
          { ...attempt, state: 'recovery_required' as const, nativeRef,
            startedAt: attempt.startedAt ?? now.toISOString() } : attempt);
        this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
          .run(JSON.stringify({ ...record, state: 'recovery_required', attempts, result: null,
            failureReason: 'authorization_changed' }), claim.requestId);
        return { ...claim, nativeRef, phase: 'reconcile' };
      }
      if (active.phase === 'reconcile' && active.native_ref === nativeRef) {
        return { ...claim, nativeRef, phase: 'reconcile' };
      }
      this.db.prepare(`UPDATE investigation_active_attempts SET phase='started',native_ref=? WHERE request_id=?`)
        .run(nativeRef, claim.requestId);
      const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
        { ...attempt, state: 'running' as const, nativeRef, startedAt: attempt.startedAt ?? now.toISOString() } : attempt);
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...record, state: 'running', attempts }), claim.requestId);
      return { ...claim, nativeRef, phase: 'started' };
    });
  }

  /** An expired original-owner intent remains unknown after restart; never replay or release its slot. */
  recoverExpiredGenericAttempts(now:Date=new Date()):void {
    if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error('NOT_AVAILABLE');
    this.withTransaction(()=>{
      const rows=this.db.prepare(`SELECT a.request_id,a.attempt_id,a.worker_epoch,a.native_ref,r.record_json
        FROM investigation_active_attempts a JOIN investigation_requests r ON r.id=a.request_id
        WHERE a.launch_protocol IS NULL AND a.container_name IS NULL AND a.wsl_unit_name IS NULL
        AND a.windows_source_json IS NULL AND a.docker_volume_json IS NULL
        AND a.lease_until<=? AND a.phase IN ('start_intent','started')`).all(now.toISOString()) as
        {request_id:string;attempt_id:string;worker_epoch:number;native_ref:string|null;record_json:string}[];
      for(const row of rows){
        const record=JSON.parse(row.record_json) as InvestigationRecord;
        if(record.result!==null||!['queued','running','recovery_required'].includes(record.state))continue;
        const attempt=record.attempts.find(a=>a.id===row.attempt_id&&a.workerEpoch===row.worker_epoch);
        if(!attempt||attempt.finishedAt!==null||attempt.terminationConfirmed)continue;
        this.db.prepare('UPDATE investigation_active_attempts SET phase=? WHERE request_id=?')
          .run(row.native_ref?'reconcile':'unknown',row.request_id);
        this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(JSON.stringify({...record,
          state:'recovery_required',attempts:record.attempts.map(a=>a.id===attempt.id?
            {...a,state:'recovery_required'}:a)}),row.request_id);
      }
    });
  }

  /** Startup reconciliation is synchronous; ordinary runtime transactions remain zero-wait. */
  recoverStartupAttempts(now:Date=new Date()):void {
    if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error('NOT_AVAILABLE');
    this.db.exec('PRAGMA busy_timeout=2000');
    const failures:unknown[]=[];
    try {
      this.recoverCodexOwnedSessions(now);
      this.recoverExpiredGenericAttempts(now);
    } catch(error) {
      failures.push(error);
    } finally {
      try { this.db.exec('PRAGMA busy_timeout=0'); }
      catch(restoreError) { failures.push(restoreError); }
    }
    if(failures.length===1)throw failures[0];
    if(failures.length>1)throw new AggregateError(failures,
      'Startup recovery timeout restoration failed',{cause:failures[1]});
  }

  /** An expired original-owner intent remains unknown after restart; never replay or release its slot. */
  recoverCodexOwnedSessions(now:Date=new Date()):void {
    if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error('NOT_AVAILABLE');
    this.withTransaction(()=>{
      const rows=this.db.prepare(`SELECT a.request_id,a.attempt_id,a.worker_epoch FROM investigation_active_attempts a
        JOIN investigation_codex_owned_sessions s ON s.attempt_id=a.attempt_id
        WHERE s.closed_at IS NULL AND a.lease_until<=?`).all(now.toISOString()) as
        {request_id:string;attempt_id:string;worker_epoch:number}[];
      for(const row of rows){
        const record=this.get(row.request_id);
        if(!record||record.result!==null||!['queued','running','recovery_required'].includes(record.state))throw new StoreConflict();
        const attempts=record.attempts.map(a=>a.id===row.attempt_id&&a.workerEpoch===row.worker_epoch?
          {...a,state:'recovery_required' as const}:a);
        this.db.prepare("UPDATE investigation_active_attempts SET phase='unknown' WHERE request_id=?").run(row.request_id);
        this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
          .run(JSON.stringify({...record,state:'recovery_required',attempts,result:null}),row.request_id);
      }
    });
  }

  /** Persist before opening any original native owner, including a lost prepare response. */
  beginCodexOwnedSession(claim:InvestigationClaim,sessionId:string,now:Date):void {
    if(!sessionId||sessionId.length>128)throw new Error('NOT_AVAILABLE');
    this.withTransaction(()=>{
      const active=this.activeFor(claim),record=this.get(claim.requestId);
      if(!record||active.native_ref!==null||active.phase!=='start_intent'||this.hasNativeThreadIntent(claim.attemptId))
        throw new StoreConflict();
      const selected=[...new Set([...record.scope.paths,...record.scope.relatedTests])].sort();
      this.requireCurrentSourceAuthority(claim,active,now,selected);
      this.db.prepare(`INSERT INTO investigation_codex_owned_sessions
        (attempt_id,request_id,workspace_id,worker_epoch,session_id,created_at) VALUES (?,?,?,?,?,?)`)
        .run(claim.attemptId,claim.requestId,claim.workspaceId,claim.workerEpoch,sessionId,now.toISOString());
    });
  }

  /** Dedicated native Codex route. An exact original Job closure is independent of model completion. */
  settleCodexSession(claim:InvestigationClaim,closure:CodexSessionClosure,
    candidate:CodexSessionCandidate|null,now:Date):InvestigationRecord {
    if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error('NOT_AVAILABLE');
    return this.withTransaction(()=>{
      const active=this.activeFor(claim),record=this.get(claim.requestId);
      const origin=this.db.prepare('SELECT session_id,worker_epoch,closed_at FROM investigation_codex_owned_sessions WHERE attempt_id=?')
        .get(claim.attemptId) as {session_id:string;worker_epoch:number;closed_at:string|null}|undefined;
      const notStarted=closure?.kind==='not_started';
      if((closure?.kind!==undefined&&closure.kind!=='job_closed'&&!notStarted)||
        (notStarted&&(candidate!==null||
          this.db.prepare('SELECT 1 FROM investigation_native_threads WHERE attempt_id=?').get(claim.attemptId)||
          this.db.prepare('SELECT 1 FROM investigation_native_turns WHERE attempt_id=?').get(claim.attemptId))))
        throw new Error('NOT_AVAILABLE');
      if(!record||active.native_ref!==null||active.wsl_unit_name!==null||active.windows_source_json!==null||
        active.docker_volume_json!==null||active.container_id!==null||active.scratch_root!==null||
        !origin||origin.closed_at!==null||origin.session_id!==closure?.sessionId||origin.worker_epoch!==claim.workerEpoch||
        !closure?.sessionId||closure.requestId!==claim.requestId||closure.attemptId!==claim.attemptId||
        closure.workerEpoch!==claim.workerEpoch||now.toISOString()>=active.lease_until||
        this.claimAuthority?.verifyCodexSessionClosure?.(claim,closure)!==true)throw new Error('NOT_AVAILABLE');
      let authorized=record.failureReason!=='authorization_changed'&&
        active.permission_epoch===this.currentPermissionEpoch(record);
      try{this.requireGrant(record,record.grantId,'investigation.request');}catch{authorized=false;}
      let result:InvestigationResult|null=null;
      if(candidate&&!record.cancelRequested&&authorized){
        const thread=this.nativeThreadRow(claim,record.collaborationId),turn=this.nativeTurnRow(claim,candidate.turn.intentId);
        const session=this.db.prepare('SELECT binding_json FROM investigation_codex_read_sessions WHERE attempt_id=?')
          .get(claim.attemptId) as {binding_json:string}|undefined;
        if(!session||thread.thread_id!==candidate.turn.threadId||turn.turn_id!==candidate.turn.turnId||
          turn.state!=='terminal')throw new StoreConflict();
        const binding=JSON.parse(session.binding_json) as RunningReadBinding;
        const paths=[...record.scope.paths,...record.scope.relatedTests,...candidate.result.coverage.searchedScope,
          ...candidate.result.evidence.map(e=>e.path)];
        if(!this.hasReadScope(record,paths))authorized=false;
        const receipts=this.getSucceededCodexReadReceipts(claim,candidate.turn);
        validateInvestigationResultEvidence(candidate.result,receipts,candidate.snapshot,{
          requestId:record.id,attemptId:claim.attemptId,workspaceId:record.workspaceId,
          collaborationId:record.collaborationId,workingCopyId:record.workingCopyId,
          snapshotId:record.snapshotRef,contextRevisionId:record.contextRevisionId,
          launchEpoch:claim.workerEpoch,...candidate.turn,workerPrincipal:claim.workerId,
          workerAudience:binding.workerAudience,workerRecipient:binding.workerRecipient,workerGrantId:binding.workerGrantId});
        const worker=this.db.prepare('SELECT revoked_at,expires_at FROM grants WHERE id=?').get(binding.workerGrantId) as
          {revoked_at:string|null;expires_at:string|null}|undefined;
        if(!worker||worker.revoked_at!==null||!worker.expires_at||Date.parse(worker.expires_at)<=now.getTime())authorized=false;
        if(authorized)result={...candidate.result,evidence:candidate.result.evidence.map(e=>({path:e.path,symbol:e.symbol,
          lineRange:e.lineRange,contentHash:e.contentHash,excerpt:e.excerpt,toolReceipt:e.toolReceipt}))};
      }
      const state=record.cancelRequested?'cancelled' as const:result?'completed' as const:'failed' as const;
      const updated:InvestigationRecord={...record,state,result:state==='completed'?result:null,
        attempts:record.attempts.map(a=>a.id===claim.attemptId?{...a,state,finishedAt:now.toISOString(),terminationConfirmed:!notStarted}:a),
        ...(notStarted?{failureReason:'windows_launch_not_started' as const}:
          !authorized?{failureReason:'authorization_changed' as const}:{})};
      this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?').run(JSON.stringify(updated),record.id);
      this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(record.id);
      this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(record.id);
      this.db.prepare('UPDATE investigation_codex_owned_sessions SET closed_at=? WHERE attempt_id=?').run(now.toISOString(),claim.attemptId);
      return updated;
    });
  }

  /** Terminal receipt and slot release are one transaction; stale epochs cannot publish. */
  completeAttempt(claim: InvestigationClaim, result: InvestigationResult, receipt: string, now: Date): InvestigationRecord {
    if (!Number.isFinite(now.getTime())) throw new Error('NOT_AVAILABLE');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      // A Codex outcome receipt does not prove that a WSL transient unit is empty.
      if (active.wsl_unit_name !== null || active.windows_source_json !== null ||
        active.docker_volume_json !== null) throw new StoreConflict();
      return this.publishVerifiedOutcome(claim, result, receipt, now, active, false);
    });
  }

  /** WSL outcome publication requires both independent native and exact-unit termination proofs. */
  completeWslAttempt(claim: InvestigationClaim, result: InvestigationResult,
    outcomeReceipt: string, terminationReceipt: string, now: Date): InvestigationRecord {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !terminationReceipt) throw new Error('NOT_AVAILABLE');
    return this.withTransaction(() => {
      const active = this.activeFor(claim);
      const resource = wslResourceFromRow(active);
      const submitted = claim.wslResource;
      // This route accepts legacy/fixed-unit terminal receipts. A model
      // supervisor requires a distinct receipt before it may publish or free a slot.
      if (resource?.gate && resource.gate.payloadKind !== 'canary_v1') throw new StoreConflict();
      if (!resource || !resource.invocationId || !resource.controlGroup || !submitted ||
        submitted.unitName !== resource.unitName || submitted.distro !== resource.distro ||
        submitted.uid !== resource.uid || submitted.bootId !== resource.bootId ||
        submitted.invocationId !== resource.invocationId || submitted.controlGroup !== resource.controlGroup ||
        claim.nativeRef !== active.native_ref || active.container_name !== null || active.container_id !== null) {
        throw new StoreConflict();
      }
      if (now.toISOString() >= active.lease_until) throw new StoreConflict();
      if (this.claimAuthority?.verifyWslTerminationReceipt?.(claim, resource, terminationReceipt) !== true) {
        throw new Error('NOT_AVAILABLE');
      }
      return this.publishVerifiedOutcome(claim, result, outcomeReceipt, now, active, true);
    });
  }

  /** Shared terminal transaction body; caller has already selected the resource route. */
  private publishVerifiedOutcome(claim: InvestigationClaim, result: InvestigationResult, receipt: string,
    now: Date, active: ReturnType<SqliteInvestigationStore['activeFor']>, wslTerminated: boolean): InvestigationRecord {
    this.assertNoNativeThreadIntent(claim.attemptId);
    this.requireClosedSourceView(active);
    if (now.toISOString() >= active.lease_until) throw new StoreConflict();
    if (!active.native_ref || !['started', 'reconcile'].includes(active.phase)) throw new Error('NOT_AVAILABLE');
    if (!this.claimAuthority?.verifyOutcomeReceipt(claim, result, active.native_ref, receipt)) throw new Error('NOT_AVAILABLE');
    const record = this.get(claim.requestId);
    if (!record || result.requestId !== record.id || result.attemptId !== claim.attemptId ||
      result.snapshotRef !== record.snapshotRef || result.contextRevisionId !== record.contextRevisionId ||
      (result.resultState === 'cancelled' && !record.cancelRequested)) throw new StoreConflict();
    // A late outcome does not prove that the legacy native resource stopped.
    // WSL callers already supplied an independent exact-unit terminal proof.
    if (record.cancelRequested && !wslTerminated && result.resultState !== 'cancelled') throw new StoreConflict();
    const attempts = record.attempts.map(attempt => attempt.id === claim.attemptId ?
      { ...attempt, state: result.resultState, finishedAt: now.toISOString(),
        terminationConfirmed: wslTerminated || result.resultState === 'cancelled' } : attempt);
    const cancellationConfirmed = record.cancelRequested &&
      (wslTerminated || result.resultState === 'cancelled');
    let authorized = record.failureReason !== 'authorization_changed' &&
      active.permission_epoch === this.currentPermissionEpoch(record);
    try { this.requireGrant(record, record.grantId, 'investigation.request'); }
    catch { authorized = false; }
    if (!this.hasReadScope(record, [...record.scope.paths, ...record.scope.relatedTests,
      ...result.coverage.searchedScope, ...result.evidence.map(item => item.path)])) authorized = false;
    const updated: InvestigationRecord = authorized ?
      { ...record, state: cancellationConfirmed ? 'cancelled' : result.resultState,
        attempts, result: cancellationConfirmed ? null : result } :
      { ...record, state: cancellationConfirmed ? 'cancelled' : 'failed',
        attempts, result: null, failureReason: 'authorization_changed' };
    this.db.prepare('UPDATE investigation_requests SET record_json=? WHERE id=?')
      .run(JSON.stringify(updated), record.id);
    this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(record.id);
    this.db.prepare('DELETE FROM investigation_active_attempts WHERE request_id=?').run(record.id);
    return updated;
  }

  requestCancel(record: InvestigationRecord, key: string, grantId: string): InvestigationRecord {
    if (!key || key.length > 128 || !grantId) throw new Error('NOT_AVAILABLE');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireGrant(record, grantId, 'investigation.cancel');
      const receipt = this.db.prepare(`SELECT request_id,result_json FROM investigation_cancel_receipts
        WHERE principal=? AND audience=? AND workspace_id=? AND operation='investigate.cancel' AND idempotency_key=?`)
        .get(record.principal, record.audience, record.workspaceId, key) as
        { request_id: string; result_json: string } | undefined;
      if (receipt) {
        if (receipt.request_id !== record.id) throw new StoreConflict();
        this.db.exec('COMMIT');
        return JSON.parse(receipt.result_json) as InvestigationRecord;
      }
      const persisted = this.get(record.id);
      if (!persisted || JSON.stringify(persisted) !== JSON.stringify(record)) throw new StoreConflict();
      const terminal = ['completed', 'failed', 'cancelled'].includes(persisted.state);
      const unstarted = persisted.state === 'queued' && persisted.attempts.length === 0 &&
        !this.db.prepare('SELECT 1 FROM investigation_active_attempts WHERE request_id=?').get(record.id);
      const updated: InvestigationRecord = terminal ? persisted : unstarted ?
        { ...persisted, state: 'cancelled', cancelRequested: true, result: null } :
        persisted.cancelRequested ? persisted : { ...persisted, cancelRequested: true };
      if (updated !== persisted) {
        const result = this.db.prepare(`UPDATE investigation_requests SET record_json=?
          WHERE id=? AND record_json=?`).run(JSON.stringify(updated), record.id, JSON.stringify(record));
        if (result.changes !== 1) throw new StoreConflict();
      }
      if (unstarted) this.db.prepare('DELETE FROM investigation_outbox WHERE request_id=?').run(record.id);
      this.db.prepare(`INSERT INTO investigation_cancel_receipts
        (principal,audience,workspace_id,operation,idempotency_key,request_id,result_json)
        VALUES (?,?,?,'investigate.cancel',?,?,?)`).run(record.principal, record.audience,
        record.workspaceId, key, record.id, JSON.stringify(updated));
      this.db.exec('COMMIT');
      return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void { this.db.close(); }
}
