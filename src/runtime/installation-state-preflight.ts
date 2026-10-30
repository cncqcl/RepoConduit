import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {validCurrentWindowsAppServerLaunchBinding,
  validWindowsAppServerLaunchRecord,
  validWindowsAppServerClosureRecord,validWindowsLaunchStartIntent,
  validWindowsAppServerNotStartedRecord,
  type WindowsAppServerLaunchRecord} from
  '../adapters/codex/investigator/windows-launch-record.js';
import {validWindowsLaunchSettlementFact} from '../adapters/storage/investigation-sqlite.js';
import { assertActiveInstallationMaintenance, retainInstallationMaintenance,
  type InstallationMaintenance } from './installation.js';

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;
const MAX_ROWS = 10_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

function unsafe(reason: 'state' | 'scope' | 'limit' | 'storage'): never {
  throw new Error('INSTALLATION_STATE_UNSAFE', { cause: Object.freeze({
    component: 'installation_state_preflight', reason,
  }) });
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsafe('state');
  return value as Json;
}
function str(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) unsafe('state');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) unsafe('state');
  return value;
}
function terminal(value: unknown): value is 'completed' | 'failed' | 'cancelled' {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

class Scan {
  private rows = 0;
  private bytes = 0;
  constructor(private readonly db: DatabaseSync) {}
  all(sql: string): Row[] {
    const remaining = MAX_ROWS - this.rows;
    if (remaining < 0) unsafe('limit');
    const boundedSql = `SELECT * FROM (${sql}) LIMIT ?`;
    const statement = this.db.prepare(boundedSql);
    const columns = statement.columns().map(column => column.name);
    if (columns.length === 0) unsafe('storage');
    const byteTerms = columns.map(name => {
      const identifier = `"${name.replaceAll('"', '""')}"`;
      return `CASE WHEN typeof(${identifier}) IN ('text','blob')
        THEN length(CAST(${identifier} AS BLOB)) ELSE 0 END`;
    });
    // SQLite computes byte counts over at most remaining+1 rows; oversized text never reaches JS .all().
    const preview = this.db.prepare(`SELECT COUNT(*) AS row_count,
      COALESCE(SUM(${byteTerms.join(' + ')}),0) AS byte_count
      FROM (${boundedSql})`).get(remaining + 1) as { row_count: number; byte_count: number };
    if (!Number.isSafeInteger(preview.row_count) || !Number.isSafeInteger(preview.byte_count) ||
        preview.row_count > remaining || preview.byte_count > MAX_JSON_BYTES - this.bytes) unsafe('limit');
    this.rows += preview.row_count;
    this.bytes += preview.byte_count;
    return statement.all(remaining) as Row[];
  }
  json(value: unknown): Json {
    if (typeof value !== 'string') unsafe('state');
    try { return object(JSON.parse(value) as unknown); }
    catch { return unsafe('state'); }
  }
}

function conversation(scan: Scan): void {
  if (scan.all('SELECT status FROM conversation_commands').some(row => row.status !== 'completed')) unsafe('state');
  for (const row of scan.all(`SELECT binding_id,workspace_id,collaboration_id,provider_id,account_id,
      native_session_id,revision,epoch,lifecycle,parent_binding_id,context_revision_id,state_json FROM session_control`)) {
    const state = scan.json(row.state_json);
    for (const [field, column] of [
      ['bindingId', 'binding_id'], ['workspaceId', 'workspace_id'], ['collaborationId', 'collaboration_id'],
      ['providerId', 'provider_id'], ['accountId', 'account_id'], ['nativeSessionId', 'native_session_id'],
    ] as const) if (str(state[field]) !== str(row[column])) unsafe('scope');
    if (integer(state.revision) !== row.revision || integer(state.epoch) !== row.epoch) unsafe('state');
    // Old bindings predate the JSON lifecycle field; their column was migrated to current.
    if ((state.lifecycle ?? 'current') !== row.lifecycle ||
        (state.parentBindingId ?? null) !== row.parent_binding_id ||
        (state.contextRevisionId ?? null) !== row.context_revision_id) unsafe('state');
    if (Object.hasOwn(state, 'sendIntent') || Object.hasOwn(state, 'pendingSyncReceipt') ||
        state.control === 'syncing' || state.control === 'reconcile_required') unsafe('state');
    if (state.control !== 'host_controlled' && state.control !== 'human_controlled') unsafe('state');
  }
}

interface RequestFact { record: Json; attempts: Map<string, Json> }
function investigations(scan: Scan): void {
  if (scan.all('SELECT request_id FROM investigation_active_attempts').length ||
      scan.all('SELECT request_id FROM investigation_outbox').length) unsafe('state');

  const requests = new Map<string, RequestFact>();
  const attempts = new Map<string, { requestId: string; record: Json; request: Json }>();
  for (const row of scan.all(`SELECT id,workspace_id,collaboration_id,principal,audience,operation,record_json
      FROM investigation_requests`)) {
    const record = scan.json(row.record_json);
    const id = str(row.id);
    if (str(record.id) !== id || str(record.workspaceId) !== str(row.workspace_id) ||
        str(record.collaborationId) !== str(row.collaboration_id) ||
        str(record.principal) !== str(row.principal) || str(record.audience) !== str(row.audience) ||
        row.operation !== 'investigate.submit') unsafe('scope');
    if (!terminal(record.state) || !Array.isArray(record.attempts) || record.result === undefined ||
        typeof record.cancelRequested !== 'boolean' ||
        (record.failureReason !== undefined && ![
          'authorization_changed', 'abandoned_before_resource_reservation', 'closed_before_native_launch',
          'model_execution_prevented', 'model_tree_terminated_without_outcome',
          'windows_launch_closed_without_outcome', 'windows_launch_not_started',
        ].includes(String(record.failureReason)))) unsafe('state');
    const ownAttempts = new Map<string, Json>();
    for (const value of record.attempts) {
      const attempt = object(value);
      const attemptId = str(attempt.id);
      if (!terminal(attempt.state) || typeof attempt.finishedAt !== 'string' ||
          !Number.isFinite(Date.parse(attempt.finishedAt)) ||
          typeof attempt.terminationConfirmed !== 'boolean' ||
          (attempt.startedAt !== null &&
           (typeof attempt.startedAt !== 'string' || !Number.isFinite(Date.parse(attempt.startedAt)))) ||
          (attempt.nativeRef !== null && typeof attempt.nativeRef !== 'string') ||
          integer(attempt.workerEpoch) < 0 || ownAttempts.has(attemptId) || attempts.has(attemptId)) unsafe('state');
      if (attempts.size >= MAX_ROWS) unsafe('limit');
      ownAttempts.set(attemptId, attempt);
      attempts.set(attemptId, { requestId: id, record: attempt, request: record });
    }
    const result = record.result;
    if (record.state === 'completed' && result === null) unsafe('state');
    if (result !== null) {
      const resolved = object(result);
      if (str(resolved.requestId) !== id || !ownAttempts.has(str(resolved.attemptId)) ||
          resolved.resultState !== record.state || !terminal(resolved.resultState) ||
          ownAttempts.get(str(resolved.attemptId))?.state !== resolved.resultState ||
          resolved.snapshotRef !== record.snapshotRef ||
          resolved.contextRevisionId !== record.contextRevisionId) unsafe('state');
    }
    requests.set(id, { record, attempts: ownAttempts });
  }

  function linked(row: Row): { requestId: string; record: Json; request: Json } {
    const attempt = attempts.get(str(row.attempt_id));
    if (!attempt || attempt.requestId !== str(row.request_id)) unsafe('scope');
    return attempt;
  }
  const prevention = new Set<string>();
  const tree = new Set<string>();
  for (const row of scan.all(`SELECT attempt_id,request_id,fact_json
      FROM investigation_supervisor_v2_running_facts`)) {
    linked(row);
    scan.json(row.fact_json);
  }
  for (const row of scan.all(`SELECT attempt_id,request_id,native_ref,fact_json,native_json,outer_json
      FROM investigation_model_running_facts`)) {
    const attempt = linked(row);
    if (str(row.native_ref) !== str(attempt.record.nativeRef)) unsafe('scope');
    scan.json(row.fact_json);
    for (const field of ['native_json', 'outer_json']) {
      if (row[field] !== null) scan.json(row[field]);
    }
  }
  for (const row of scan.all('SELECT attempt_id,request_id,native_ref FROM investigation_model_dispatch')) {
    const attempt = linked(row);
    if (str(row.native_ref) !== str(attempt.record.nativeRef)) unsafe('scope');
  }
  for (const [table, sink] of [
    ['investigation_model_prevention_facts', prevention], ['investigation_model_tree_facts', tree],
  ] as const) {
    for (const row of scan.all(`SELECT attempt_id,request_id,cleanup_epoch,observation_json,settled_at FROM ${table}`)) {
      const attempt = linked(row);
      if (integer(row.cleanup_epoch) !== integer(attempt.record.workerEpoch) ||
          typeof row.settled_at !== 'string' || !Number.isFinite(Date.parse(row.settled_at))) unsafe('state');
      scan.json(row.observation_json);
      sink.add(str(row.attempt_id));
    }
  }
  const settledWindows=new Set<string>();
  const settledNotStarted=new Set<string>();
  const windowsLaunchEpoch=new Map<string,number>();
  const hasWindowsFacts=scan.all(`SELECT name FROM sqlite_master WHERE type='table'
    AND name='investigation_windows_launch_settlement_facts'`).length===1;
  const hasLaunches=scan.all(`SELECT name FROM sqlite_master WHERE type='table'
    AND name='investigation_windows_app_server_launches'`).length===1;
  const hasClosures=scan.all(`SELECT name FROM sqlite_master WHERE type='table'
    AND name='investigation_windows_app_server_closures'`).length===1;
  const hasNotStarted=scan.all(`SELECT name FROM sqlite_master WHERE type='table'
    AND name='investigation_windows_app_server_not_started'`).length===1;
  const hasNotStartedSettlement=scan.all(`SELECT name FROM sqlite_master WHERE type='table'
    AND name='investigation_windows_not_started_settlement_facts'`).length===1;
  const launchRows=hasLaunches ? scan.all(`SELECT attempt_id,request_id,launch_id,record_json
    FROM investigation_windows_app_server_launches`) : [];
  const launches=new Map<string,Row>();
  const launchesById=new Map<string,WindowsAppServerLaunchRecord>();
  for (const row of launchRows) {
    const attemptId=str(row.attempt_id);
    const attempt=linked(row);
    const launch=scan.json(row.record_json);
    if (launches.has(attemptId) || !validWindowsAppServerLaunchRecord(launch) ||
      launch.attemptId!==attemptId || launch.requestId!==row.request_id ||
      launch.launchId!==row.launch_id ||
      launch.workspaceId!==attempt.request.workspaceId ||
      launch.collaborationId!==attempt.request.collaborationId ||
      launchesById.has(launch.launchId)) unsafe('scope');
    launches.set(attemptId,row);
    launchesById.set(launch.launchId,launch);
  }
  const hasStartIntents=scan.all(`SELECT name FROM sqlite_master WHERE type='table'
    AND name='investigation_windows_app_server_start_intents'`).length===1;
  const startIntentLaunches=new Set<string>();
  for(const row of (hasStartIntents ? scan.all(`SELECT launch_id,record_json
    FROM investigation_windows_app_server_start_intents`) : [])) {
    const launchId=str(row.launch_id);
    const launch=launchesById.get(launchId);
    const intent=scan.json(row.record_json);
    if(!launch || !validCurrentWindowsAppServerLaunchBinding(launch.binding) ||
      !validWindowsLaunchStartIntent(intent) || intent.launchId!==launchId ||
      intent.reservedAt!==launch.intentAt || startIntentLaunches.has(launchId)) unsafe('scope');
    startIntentLaunches.add(launchId);
  }
  const closures=new Map<string,Row>();
  for (const row of (hasClosures ? scan.all(`SELECT launch_id,record_json
    FROM investigation_windows_app_server_closures`) : [])) {
    const launchId=str(row.launch_id);
    const launch=launchesById.get(launchId);
    const closure=scan.json(row.record_json);
    if (closures.has(launchId) || !launch ||
      !validWindowsAppServerLaunchRecord(launch) ||
      !validWindowsAppServerClosureRecord(closure) ||
      closure.launchId!==launchId || !launch.identity ||
      closure.observation.hostScopeId!==launch.binding.hostScopeId ||
      closure.observation.executionInstanceId!==launch.binding.executionInstanceId ||
      closure.observation.root.pid!==launch.identity.pid ||
      closure.observation.root.creationFiletime!==launch.identity.creationFiletime) unsafe('scope');
    closures.set(launchId,row);
  }
  const notStarted=new Map<string,Row>();
  for (const row of (hasNotStarted ? scan.all(`SELECT launch_id,record_json
    FROM investigation_windows_app_server_not_started`) : [])) {
    const launchId=str(row.launch_id),launch=launchesById.get(launchId);
    const fact=scan.json(row.record_json);
    if (notStarted.has(launchId) || !launch || !validCurrentWindowsAppServerLaunchBinding(launch.binding) ||
      !validWindowsAppServerNotStartedRecord(fact) || fact.launchId!==launchId ||
      !startIntentLaunches.has(launchId) || launch.identity!==null ||
      launch.observedAt!==null || launch.state!=='recovery_required' ||
      closures.has(launchId) ||
      fact.observation.hostScopeId!==launch.binding.hostScopeId ||
      fact.observation.executionInstanceId!==launch.binding.executionInstanceId)
      unsafe('scope');
    notStarted.set(launchId,row);
  }
  if (hasWindowsFacts) for (const row of scan.all(`SELECT attempt_id,request_id,launch_id,
      cleanup_epoch,fact_json FROM investigation_windows_launch_settlement_facts`)) {
    const attemptId=str(row.attempt_id);
    const attempt=linked(row);
    const request=attempt.request;
    const launchRow=launches.get(attemptId);
    const launch=launchRow ? scan.json(launchRow.record_json) : null;
    const closureRow=launchRow ? closures.get(str(launchRow.launch_id)) : undefined;
    const closure=closureRow ? scan.json(closureRow.record_json) : null;
    const fact=scan.json(row.fact_json);
    if (request.failureReason!=='windows_launch_closed_without_outcome' ||
      !launchRow || !launch || !validWindowsAppServerLaunchRecord(launch) ||
      !validCurrentWindowsAppServerLaunchBinding(launch.binding) ||
      !closure || !validWindowsAppServerClosureRecord(closure) ||
      !validWindowsLaunchSettlementFact(fact) ||
      launchRow.request_id!==row.request_id || launchRow.launch_id!==row.launch_id ||
      launchRow.launch_id!==launch.launchId ||
      closureRow?.launch_id!==closure.launchId ||
      launch.attemptId!==attemptId || launch.requestId!==row.request_id ||
      launch.workspaceId!==request.workspaceId ||
      launch.collaborationId!==request.collaborationId ||
      launch.state!=='recovery_required' || !launch.identity ||
      closure.launchId!==launch.launchId ||
      closure.observation.launchId!==launch.launchId ||
      closure.observation.hostScopeId!==launch.binding.hostScopeId ||
      closure.observation.executionInstanceId!==launch.binding.executionInstanceId ||
      closure.observation.root.pid!==launch.identity.pid ||
      closure.observation.root.creationFiletime!==launch.identity.creationFiletime ||
      integer(row.cleanup_epoch)!==fact.cleanupEpoch ||
      fact.cleanupEpoch!==attempt.record.workerEpoch ||
      fact.cleanupEpoch<=launch.launchEpoch ||
      fact.settledAt!==attempt.record.finishedAt ||
      Date.parse(fact.settledAt)<Date.parse(closure.recordedAt) ||
      fact.sourceClosed.descriptor.attemptId!==attemptId ||
      fact.sourceClosed.descriptor.workspaceId!==launch.workspaceId ||
      fact.sourceClosed.descriptor.workerEpoch!==launch.launchEpoch ||
      fact.sourceClosed.descriptor.sourceDigest!==launch.binding.sourceDigest ||
      !attempt.record.terminationConfirmed || attempt.record.nativeRef!==null ||
      !['failed','cancelled'].includes(String(attempt.record.state)) ||
      attempt.record.state!==request.state || request.result!==null ||
      (Array.isArray(request.attempts) && request.attempts.length!==1) ||
      (request.state==='cancelled' && request.cancelRequested!==true) ||
      (request.state==='failed' && request.cancelRequested!==false) ||
      settledWindows.has(attemptId)) unsafe('state');
    settledWindows.add(attemptId);
    windowsLaunchEpoch.set(attemptId,launch.launchEpoch);
  }
  if (hasNotStartedSettlement) for (const row of scan.all(`SELECT attempt_id,request_id,launch_id,
      cleanup_epoch,fact_json FROM investigation_windows_not_started_settlement_facts`)) {
    const attemptId=str(row.attempt_id),attempt=linked(row),request=attempt.request;
    const launchRow=launches.get(attemptId);
    const launch=launchRow ? launchesById.get(str(launchRow.launch_id)) : undefined;
    const proofRow=launch ? notStarted.get(launch.launchId) : undefined;
    const proof=proofRow ? scan.json(proofRow.record_json) : null;
    const fact=scan.json(row.fact_json);
    if (request.failureReason!=='windows_launch_not_started' ||
      !launchRow || !launch || !validWindowsAppServerLaunchRecord(launch) ||
      !validCurrentWindowsAppServerLaunchBinding(launch.binding) ||
      !proof || !validWindowsAppServerNotStartedRecord(proof) ||
      !validWindowsLaunchSettlementFact(fact) ||
      launchRow.request_id!==row.request_id || launchRow.launch_id!==row.launch_id ||
      launch.attemptId!==attemptId || launch.requestId!==row.request_id ||
      launch.workspaceId!==request.workspaceId ||
      launch.collaborationId!==request.collaborationId ||
      launch.state!=='recovery_required' || launch.identity!==null || launch.observedAt!==null ||
      closures.has(launch.launchId) || proof.launchId!==launch.launchId ||
      proof.observation.hostScopeId!==launch.binding.hostScopeId ||
      proof.observation.executionInstanceId!==launch.binding.executionInstanceId ||
      !startIntentLaunches.has(launch.launchId) ||
      integer(row.cleanup_epoch)!==fact.cleanupEpoch ||
      fact.cleanupEpoch!==attempt.record.workerEpoch ||
      fact.cleanupEpoch<=launch.launchEpoch ||
      fact.settledAt!==attempt.record.finishedAt ||
      Date.parse(fact.settledAt)<Date.parse(proof.recordedAt) ||
      fact.sourceClosed.descriptor.attemptId!==attemptId ||
      fact.sourceClosed.descriptor.workspaceId!==launch.workspaceId ||
      fact.sourceClosed.descriptor.workerEpoch!==launch.launchEpoch ||
      fact.sourceClosed.descriptor.sourceDigest!==launch.binding.sourceDigest ||
      attempt.record.terminationConfirmed!==false || attempt.record.nativeRef!==null ||
      attempt.record.startedAt!==null ||
      !['failed','cancelled'].includes(String(attempt.record.state)) ||
      attempt.record.state!==request.state || request.result!==null ||
      (Array.isArray(request.attempts) && request.attempts.length!==1) ||
      (request.state==='cancelled' && request.cancelRequested!==true) ||
      (request.state==='failed' && request.cancelRequested!==false) ||
      settledWindows.has(attemptId) || settledNotStarted.has(attemptId)) unsafe('state');
    settledNotStarted.add(attemptId);
  }
  for (const attemptId of launches.keys())
    if (!settledWindows.has(attemptId) && !settledNotStarted.has(attemptId)) unsafe('state');
  for (const launchId of notStarted.keys())
    if (!settledNotStarted.has(launchesById.get(launchId)!.attemptId)) unsafe('state');
  for (const [id, item] of requests) {
    const reason = item.record.failureReason;
    if ((reason==='windows_launch_closed_without_outcome') !==
        [...item.attempts.keys()].some(attemptId=>settledWindows.has(attemptId))) unsafe('state');
    if ((reason==='windows_launch_not_started') !==
        [...item.attempts.keys()].some(attemptId=>settledNotStarted.has(attemptId))) unsafe('state');
    if (reason === 'model_execution_prevented') {
      if (item.attempts.size !== 1 || !prevention.has([...item.attempts.keys()][0]!) ||
          [...item.attempts.values()][0]!.terminationConfirmed !== false) unsafe('state');
    } else if (reason === 'model_tree_terminated_without_outcome') {
      if (item.attempts.size !== 1 || !tree.has([...item.attempts.keys()][0]!) ||
          [...item.attempts.values()][0]!.terminationConfirmed !== true) unsafe('state');
    }
    if (reason === 'abandoned_before_resource_reservation' || reason === 'closed_before_native_launch') {
      if (item.attempts.size !== 1 || [...item.attempts.values()][0]!.nativeRef !== null ||
          [...item.attempts.values()][0]!.startedAt !== null ||
          [...item.attempts.values()][0]!.terminationConfirmed !== false) unsafe('state');
    }
    for (const [attemptId] of item.attempts) {
      if (prevention.has(attemptId) && reason !== 'model_execution_prevented') unsafe('state');
      if (tree.has(attemptId) && reason !== 'model_tree_terminated_without_outcome') unsafe('state');
      const attempt = item.attempts.get(attemptId)!;
      if (attempt.terminationConfirmed === false) {
        const beforeLaunch = (reason === 'abandoned_before_resource_reservation' ||
          reason === 'closed_before_native_launch') && attempt.nativeRef === null && attempt.startedAt === null;
        const prevented = reason === 'model_execution_prevented' && prevention.has(attemptId);
        const noChild = reason === 'windows_launch_not_started' && settledNotStarted.has(attemptId);
        const result = item.record.result;
        const correlatedOutcome = result !== null && typeof result === 'object' &&
          (item.record.state === 'completed' || item.record.state === 'failed') &&
          (result as Json).attemptId === attemptId && (result as Json).resultState === attempt.state;
        if (!beforeLaunch && !prevented && !noChild && !correlatedOutcome) unsafe('state');
      }
    }
    if (id.length === 0) unsafe('state');
  }
  for (const row of scan.all(`SELECT attempt_id,request_id,workspace_id,collaboration_id,
    worker_epoch,thread_id FROM investigation_native_threads`)) {
    const attempt = linked(row);
    if (settledNotStarted.has(str(row.attempt_id))) unsafe('scope');
    if (str(row.workspace_id) !== str(attempt.request.workspaceId) ||
        str(row.collaboration_id) !== str(attempt.request.collaborationId) ||
        (row.thread_id===null ? !settledWindows.has(str(row.attempt_id)) :
          typeof row.thread_id!=='string' || !row.thread_id || row.thread_id.length>256)) unsafe('scope');
    if (settledWindows.has(str(row.attempt_id)) &&
        integer(row.worker_epoch)!==windowsLaunchEpoch.get(str(row.attempt_id))) unsafe('scope');
  }
  const threads=new Map<string,Row>();
  for (const row of scan.all(`SELECT attempt_id,request_id,thread_id
    FROM investigation_native_threads`)) threads.set(str(row.attempt_id),row);
  for (const row of scan.all(`SELECT t.attempt_id,t.intent_id,t.turn_id,t.state,
      t.interrupt_ack,n.request_id FROM investigation_native_turns t
      LEFT JOIN investigation_native_threads n ON n.attempt_id=t.attempt_id`)) {
    const thread=threads.get(str(row.attempt_id));
    if (!thread || typeof thread.thread_id!=='string' || !thread.thread_id ||
      thread.thread_id.length>256) unsafe('state');
    if (row.request_id===null ||
      (row.state!=='terminal' && !settledWindows.has(str(row.attempt_id)))) unsafe('state');
    if (settledWindows.has(str(row.attempt_id))) {
      if (typeof row.intent_id!=='string' || !row.intent_id ||
        row.intent_id.length>256 || !['intent','observed','terminal'].includes(String(row.state)) ||
        (row.interrupt_ack!==0 && row.interrupt_ack!==1) ||
        (row.state==='intent' ? row.turn_id!==null || row.interrupt_ack!==0 :
          typeof row.turn_id!=='string' || !row.turn_id || row.turn_id.length>256 ||
          typeof thread.thread_id!=='string' || !thread.thread_id)) unsafe('state');
    }
  }
}

/** Inspect an already opened SQLite database without changing it. Caller owns read-only opening and closure.
 * This validates stored state only; it grants no maintenance or restore authority.
 */
export function inspectInstallationStateDatabase(db: DatabaseSync): void {
  const scan = new Scan(db);
  conversation(scan);
  investigations(scan);
}

/** Read settled durable state while the caller holds its exclusive maintenance owner. */
export function assertInstallationStateQuiescent(owner: InstallationMaintenance): void {
  assertActiveInstallationMaintenance(owner);
  const file = join(owner.dataDirectory, 'state.sqlite');
  let db: DatabaseSync | undefined;
  let primary: unknown;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) unsafe('storage');
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    inspectInstallationStateDatabase(db);
  } catch (error) { primary = error instanceof Error && error.message === 'INSTALLATION_STATE_UNSAFE' ? error :
    new Error('INSTALLATION_STATE_UNSAFE', { cause: Object.freeze({ component: 'installation_state_preflight', reason: 'storage' }) }); }
  try { db?.close(); }
  catch {
    retainInstallationMaintenance(owner);
    throw new AggregateError(primary ? [primary, new Error('INSTALLATION_STATE_CLOSE_UNCONFIRMED')] :
      [new Error('INSTALLATION_STATE_CLOSE_UNCONFIRMED')], 'Installation state inspection close unconfirmed');
  }
  if (primary !== undefined) throw primary;
}
