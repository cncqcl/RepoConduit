import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationMaintenance } from '../../src/runtime/installation.js';
import { assertInstallationStateQuiescent, inspectInstallationStateDatabase } from
  '../../src/runtime/installation-state-preflight.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { createInstallationTestDiagnostics, withInstallationFixtureCleanup } from
  '../support/installation-test-diagnostics.js';

function fixture(run: (db: DatabaseSync) => void, expected: 'safe' | 'unsafe' | 'limit',
  label = 'unspecified'): void {
  const parent = process.platform === 'win32' ? homedir() : tmpdir();
  const base = mkdtempSync(join(parent, 'rcac-state-preflight-'));
  const trace = createInstallationTestDiagnostics('installation-state-preflight', base);
  const started = process.hrtime.bigint();
  let stage = 'fixture';
  let failedStage: string | undefined;
  function atStage<T>(next: string, operation: () => T): T {
    stage = next;
    trace.event(next, { phase: 'begin', caseLabel: label,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 });
    try {
      const result = operation();
      trace.event(next, { phase: 'end', caseLabel: label,
        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 });
      return result;
    } catch (error) {
      failedStage ??= next;
      trace.failure(next, error);
      throw error;
    }
  }
  let owner: ReturnType<typeof acquireInstallationMaintenance> | undefined;
  let primary: unknown;
  let released = false;
  try {
    atStage('protect', () => protectNewDataDirectory(base));
    const root = join(base, 'installation');
    atStage('createManagedInstallation', () => createManagedInstallation(root));
    const manifest = atStage('manifest', () =>
      JSON.parse(readFileSync(join(root, 'managed.json'), 'utf8')) as { activeGeneration: string });
    const file = join(root, 'generations', manifest.activeGeneration, 'data', 'state.sqlite');
    const db = atStage('open', () => new DatabaseSync(file));
    withInstallationFixtureCleanup(() => atStage('seed', () => {
      db.prepare('INSERT INTO workspaces(id,name,canonical_root,registered_by) VALUES (?,?,?,?)')
        .run('w', 'fixture', 'D:/preflight-fixture', 'owner');
      db.prepare('INSERT INTO collaborations(id,workspace_id,opened_by,purpose,host_thread_id,state) VALUES (?,?,?,?,?,?)')
        .run('c', 'w', 'owner', 'fixture', null, 'open');
      run(db);
    }), () => atStage('db.close', () => db.close()));
    const readonly = atStage('readonly.open', () => new DatabaseSync(file, { readOnly: true }));
    withInstallationFixtureCleanup(() => atStage('direct-inspect', () => {
      if (expected === 'limit') assert.throws(() => inspectInstallationStateDatabase(readonly), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'INSTALLATION_STATE_UNSAFE');
        assert.deepEqual(error.cause, { component: 'installation_state_preflight', reason: 'limit' });
        return true;
      });
      else if (expected === 'unsafe') assert.throws(() => inspectInstallationStateDatabase(readonly), /INSTALLATION_STATE_UNSAFE/);
      else assert.doesNotThrow(() => inspectInstallationStateDatabase(readonly));
    }), () => atStage('readonly.close', () => readonly.close()));
    owner = atStage('maintenance.acquire', () => acquireInstallationMaintenance(root));
    atStage('maintenance.inspect', () => {
      const before = readFileSync(file);
      if (expected === 'limit') assert.throws(() => assertInstallationStateQuiescent(owner!), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'INSTALLATION_STATE_UNSAFE');
        assert.deepEqual(error.cause, { component: 'installation_state_preflight', reason: 'limit' });
        return true;
      });
      else if (expected === 'unsafe') assert.throws(() => assertInstallationStateQuiescent(owner!), /INSTALLATION_STATE_UNSAFE/);
      else assert.doesNotThrow(() => assertInstallationStateQuiescent(owner!));
      assert.deepEqual(readFileSync(file), before);
    });
    atStage('maintenance.release', () => owner!.release());
    released = true;
  } catch (error) {
    trace.failure(failedStage ?? stage, error);
    primary = error;
  }
  if (!released && owner) {
    // A failed close is unknown authority; retain the directory and original failure.
    try { atStage('maintenance.release-recovery', () => owner!.release()); released = true; }
    catch (error) {
      trace.failure('maintenance.release-recovery', error);
      primary = primary === undefined ? error : new AggregateError([primary, error], 'Preflight assertion and gate release failed',
        { cause: primary });
    }
  }
  if (!released && owner) { if (primary !== undefined) throw primary; throw new Error('Maintenance owner release unconfirmed'); }
  // Unexpected failures retain the new fixture and its original diagnostic state.
  if (primary !== undefined) throw primary;
  let cleanup: unknown;
  try {
    atStage('cleanup', () => {
      assert.match(relative(resolve(parent), resolve(base)), /^rcac-state-preflight-[A-Za-z0-9_-]{6}$/);
      rmSync(base, { recursive: true, force: true });
    });
  } catch (error) { trace.failure('cleanup', error); cleanup = error; }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], 'Preflight assertion and cleanup failed');
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
}

const state = { bindingId: 'b', lifecycle: 'current', workspaceId: 'w', collaborationId: 'c',
  providerId: 'p', accountId: 'a', nativeSessionId: 'n', cursor: 'cursor', control: 'host_controlled', epoch: 0, revision: 0 };
function binding(db: DatabaseSync, override: Record<string, unknown> = {}): void {
  const value = { ...state, ...override };
  db.prepare(`INSERT INTO session_control(binding_id,workspace_id,collaboration_id,provider_id,account_id,
    native_session_id,revision,epoch,state_json,lifecycle) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('b', 'w', 'c', 'p', 'a', 'n', 0, 0, JSON.stringify(value), 'current');
}
function command(db: DatabaseSync, status: string, outcome: string | null): void {
  db.prepare(`INSERT INTO conversation_commands(command_id,principal,audience,workspace_id,collaboration_id,
    operation,idempotency_key,payload_hash,send_text,binding_id,grant_id,recipient,
    expected_revision,expected_epoch,status,outcome,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('cmd', 'actor', 'external', 'w', 'c', 'conversation.send', 'key', 'hash', 'text', 'b', 'grant', 'r',
      0, 0, status, outcome, status === 'completed' ? '{}' : null);
}

test('conversation preflight rejects every unfinished command and pending durable send state', () => {
  for (const status of ['prepared', 'sending', 'reconcile_required']) {
    fixture(db => { binding(db); command(db, status, null); }, 'unsafe');
  }
  for (const extra of [
    { sendIntent: { id: 'cmd', text: 'text', status: 'unknown' } },
    { pendingSyncReceipt: { receiptId: 'receipt', fromEpoch: 0, fromCursor: 'cursor', nextCursor: 'next', messages: [] } },
    { control: 'syncing' }, { control: 'reconcile_required' }, { revision: 1 }, { epoch: 1 },
  ]) fixture(db => binding(db, extra), 'unsafe');
});

test('completed unknown command with cleared correlated intent is safe', () => {
  fixture(db => { binding(db); command(db, 'completed', 'unknown'); }, 'safe');
  fixture(db => binding(db, { lifecycle: undefined }), 'safe');
});

const record = { id: 'inv', workspaceId: 'w', collaborationId: 'c', workingCopyId: 'copy',
  principal: 'actor', audience: 'external', recipient: 'r', grantId: 'grant', profileRef: 'fixed',
  budgetRef: 'fixed', budget: { maxWallSeconds: 60, maxTurns: 1, maxToolCalls: 1 },
  contextRevisionId: 'ctx', snapshotRef: 'snap', question: 'question',
  scope: { paths: [], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'], parentInvestigationId: null,
  state: 'failed', cancelRequested: false, attempts: [{ id: 'attempt', state: 'failed', nativeRef: null,
    workerEpoch: 1, startedAt: null, finishedAt: '2026-01-01T00:00:00.000Z', terminationConfirmed: false }],
  result: null, failureReason: 'abandoned_before_resource_reservation', createdAt: '2026-01-01T00:00:00.000Z' };
function request(db: DatabaseSync, override: Record<string, unknown> = {},
  operation = 'investigate.submit'): void {
  db.prepare(`INSERT INTO investigation_requests(id,workspace_id,collaboration_id,principal,audience,operation,
    idempotency_key,fingerprint,record_json) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('inv', 'w', 'c', 'actor', 'external', operation, 'key', 'hash', JSON.stringify({ ...record, ...override }));
}

test('historical failed attempt with explicitly unreserved resources is safe', () => {
  fixture(db => request(db), 'safe');
});

test('investigation preflight rejects a noncanonical operation', () => {
  fixture(db => request(db, {}, 'investigate.request'), 'unsafe');
});

function settledWindowsLaunch(db:DatabaseSync, changed: {
  fact?:Record<string,unknown>|null; launch?:Record<string,unknown>;
  closure?:Record<string,unknown>; reason?:string|null;
  nativeUnknown?:'thread'|'turn'|'invalid-parent';
}={}) {
  const attemptId='attempt_11111111-1111-4111-8111-111111111111';
  const launchId='22222222-2222-4222-8222-222222222222';
  const t0='2026-01-01T00:00:00.000Z';
  const t1='2026-01-01T00:00:01.000Z';
  const binding={collaborationId:'c',sourceDigest:'a'.repeat(64),profileRevision:'fixed',
    permissionEpoch:0,protocolTarget:
      'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1',
    recipe:'windows_app_server_readonly_v1',hostScopeId:'33333333-3333-4333-8333-333333333333',
    executionInstanceId:'44444444-4444-4444-8444-444444444444',
    runtimeId:'55555555-5555-4555-8555-555555555555',configSha256:'b'.repeat(64)};
  const identity={pid:42,creationFiletime:'133000000000000000',
    hostScopeId:binding.hostScopeId,executionInstanceId:binding.executionInstanceId};
  const launch={launchId,requestId:'inv',attemptId,workspaceId:'w',collaborationId:'c',
    launchWorkerId:'worker',launchEpoch:1,binding,state:'recovery_required',identity,
    intentAt:t0,observedAt:t0,recoveryRequiredAt:t0,...changed.launch};
  const observation={protocol:'windows_job_stdio_v1',helperVersion:'3',kind:'job_closed',
    recipe:'windows_app_server_readonly_v1',launchId,hostScopeId:binding.hostScopeId,
    executionInstanceId:binding.executionInstanceId,
    root:{pid:42,creationFiletime:identity.creationFiletime},rootExited:true,
    stdoutEof:true,stderrEof:true,members:{complete:true,assigned:0,listed:0,pids:[]},
    helperExitCode:0,sequence:5};
  const closure={launchId,observation,recordedAt:t0,...changed.closure};
  const descriptor={attemptId,workspaceId:'w',workerEpoch:1,sourceDigest:binding.sourceDigest};
  const privateRoot='C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator';
  const fact={cleanupWorkerId:'cleanup',cleanupEpoch:2,settledAt:t1,privateRoot,
    sourceClosed:{kind:'closed',descriptor,viewPath:`${privateRoot}\\${attemptId}.view`,
      isolationVerified:false},...changed.fact};
  request(db,{state:'failed',failureReason:changed.reason===undefined ?
    'windows_launch_closed_without_outcome':changed.reason,
    attempts:[{id:attemptId,state:'failed',nativeRef:null,workerEpoch:2,
      startedAt:null,finishedAt:t1,terminationConfirmed:true}]});
  db.prepare(`INSERT INTO investigation_windows_app_server_launches
    (attempt_id,request_id,launch_id,record_json) VALUES (?,?,?,?)`)
    .run(attemptId,'inv',launchId,JSON.stringify(launch));
  db.prepare(`INSERT INTO investigation_windows_app_server_closures
    (launch_id,record_json) VALUES (?,?)`).run(launchId,JSON.stringify(closure));
  if (changed.fact!==null) db.prepare(`INSERT INTO investigation_windows_launch_settlement_facts
    (attempt_id,request_id,launch_id,cleanup_epoch,fact_json) VALUES (?,?,?,?,?)`)
    .run(attemptId,'inv',launchId,2,JSON.stringify(fact));
  if (changed.nativeUnknown) {
    db.prepare(`INSERT INTO investigation_native_threads
      (attempt_id,request_id,workspace_id,collaboration_id,worker_epoch,thread_id)
      VALUES (?,?,?,?,?,?)`).run(attemptId,'inv','w','c',1,
        changed.nativeUnknown==='turn'?'thread-1':null);
    if (changed.nativeUnknown!=='thread') db.prepare(`INSERT INTO investigation_native_turns
      (attempt_id,intent_id,turn_id,state) VALUES (?,?,?,?)`)
      .run(attemptId,'intent',null,'intent');
  }
}

function windowsStartIntent(db:DatabaseSync, override:Record<string,unknown>={},
  rowLaunchId='22222222-2222-4222-8222-222222222222'):void {
  db.exec(`CREATE TABLE IF NOT EXISTS investigation_windows_app_server_start_intents (
    launch_id TEXT PRIMARY KEY REFERENCES investigation_windows_app_server_launches(launch_id),
    record_json TEXT NOT NULL)`);
  db.prepare(`INSERT INTO investigation_windows_app_server_start_intents
    (launch_id,record_json) VALUES (?,?)`).run(rowLaunchId,JSON.stringify({
      kind:'windows_app_server_start_intent_v1',
      launchId:'22222222-2222-4222-8222-222222222222',
      reservedAt:'2026-01-01T00:00:00.000Z',consumedAt:'2026-01-01T00:00:00.000Z',
      ...override,
    }));
}

test('Windows start reservation preflight accepts consumed facts without minting historical rights',()=>{
  fixture(db=>{settledWindowsLaunch(db);windowsStartIntent(db);},'safe');
  fixture(db=>{settledWindowsLaunch(db);windowsStartIntent(db,{
    consumedAt:'2025-12-31T23:59:59.000Z',
  });},'safe');
  fixture(db=>{settledWindowsLaunch(db);windowsStartIntent(db,{consumedAt:null});},'safe');
  fixture(db=>{
    settledWindowsLaunch(db);
    db.exec('DROP TABLE IF EXISTS investigation_windows_app_server_start_intents');
  },'safe');
  fixture(db=>{
    settledWindowsLaunch(db);
    db.exec(`CREATE TABLE IF NOT EXISTS investigation_windows_app_server_start_intents (
      launch_id TEXT PRIMARY KEY,record_json TEXT NOT NULL)`);
  },'safe');
});

test('Windows start reservation preflight rejects malformed and noncanonical time facts',()=>{
  for(const override of [
    {kind:'start'}, {extra:true},
    {reservedAt:'2026-01-01T00:00:00Z'}, {consumedAt:'2026-01-01T00:00:00Z'},
  ]) fixture(db=>{settledWindowsLaunch(db);windowsStartIntent(db,override);},'unsafe');
});

const originPrefix = 'Windows start reservation preflight rejects orphan, mismatched and retimed origins';
test(`${originPrefix}: orphan origin`,()=>{
  fixture(db=>{db.exec('PRAGMA foreign_keys=OFF');windowsStartIntent(db);},'unsafe','orphan origin');
});
test(`${originPrefix}: mismatched origin`,()=>{
  fixture(db=>{settledWindowsLaunch(db);windowsStartIntent(db,{
    launchId:'99999999-9999-4999-8999-999999999999',
  });},'unsafe','mismatched origin');
});
test(`${originPrefix}: retimed origin`,()=>{
  fixture(db=>{settledWindowsLaunch(db);windowsStartIntent(db,{
    reservedAt:'2025-12-31T23:59:59.000Z',
  });},'unsafe','retimed origin');
});

const chainPrefix = 'settled Windows launch requires the exact durable fact chain, including unknown native IDs';
test(`${chainPrefix}: unknown thread ID`,()=>{
  fixture(db=>settledWindowsLaunch(db,{nativeUnknown:'thread'}),'safe','unknown thread ID');
});
test(`${chainPrefix}: unknown turn ID`,()=>{
  fixture(db=>settledWindowsLaunch(db,{nativeUnknown:'turn'}),'safe','unknown turn ID');
});
test(`${chainPrefix}: invalid native parent`,()=>{
  fixture(db=>settledWindowsLaunch(db,{nativeUnknown:'invalid-parent'}),'unsafe','invalid native parent');
});
test(`${chainPrefix}: missing settlement fact`,()=>{
  fixture(db=>settledWindowsLaunch(db,{fact:null}),'unsafe','missing settlement fact');
});
test(`${chainPrefix}: mismatched cleanup epoch`,()=>{
  fixture(db=>settledWindowsLaunch(db,{fact:{cleanupEpoch:1}}),'unsafe','mismatched cleanup epoch');
});
test(`${chainPrefix}: mismatched source digest`,()=>{
  fixture(db=>settledWindowsLaunch(db,{fact:{sourceClosed:{kind:'closed',
    descriptor:{attemptId:'attempt_11111111-1111-4111-8111-111111111111',workspaceId:'w',
      workerEpoch:1,sourceDigest:'c'.repeat(64)},viewPath:
      'C:\\Users\\owner\\AppData\\Local\\RepoConduit\\investigator\\attempt_11111111-1111-4111-8111-111111111111.view',
    isolationVerified:false}}}),'unsafe','mismatched source digest');
});
test(`${chainPrefix}: mismatched root identity`,()=>{
  fixture(db=>settledWindowsLaunch(db,{closure:{observation:{protocol:'windows_job_stdio_v1',
    helperVersion:'3',kind:'job_closed',recipe:'windows_app_server_readonly_v1',
    launchId:'22222222-2222-4222-8222-222222222222',hostScopeId:'33333333-3333-4333-8333-333333333333',
    executionInstanceId:'44444444-4444-4444-8444-444444444444',
    root:{pid:42,creationFiletime:'133000000000000001'},rootExited:true,stdoutEof:true,
    stderrEof:true,members:{complete:true,assigned:0,listed:0,pids:[]},helperExitCode:0,sequence:5}}}),'unsafe','mismatched root identity');
});
test(`${chainPrefix}: mismatched workspace`,()=>{
  fixture(db=>settledWindowsLaunch(db,{launch:{workspaceId:'other'}}),'unsafe','mismatched workspace');
});
test(`${chainPrefix}: mismatched failure reason`,()=>{
  fixture(db=>settledWindowsLaunch(db,{reason:'closed_before_native_launch'}),'unsafe','mismatched failure reason');
});
test(`${chainPrefix}: absent settlement table without launch`,()=>{
  fixture(db=>{request(db);db.exec('DROP TABLE investigation_windows_launch_settlement_facts');},'safe',
    'absent settlement table without launch');
});
test(`${chainPrefix}: absent launch tables without launch`,()=>{
  fixture(db=>{request(db);db.exec(`DROP TABLE investigation_windows_launch_settlement_facts;
    DROP TABLE investigation_windows_app_server_closures;
    DROP TABLE investigation_windows_app_server_launches`);},'safe','absent launch tables without launch');
});

test('closed-launch native journal exception rejects malformed parent and turn states',()=>{
  fixture(db=>{
    settledWindowsLaunch(db,{nativeUnknown:'thread'});
    db.prepare(`UPDATE investigation_native_threads SET thread_id=''`).run();
  },'unsafe');
  for (const update of [
    `UPDATE investigation_native_turns SET intent_id=''`,
    `UPDATE investigation_native_turns SET turn_id='turn-1'`,
    `UPDATE investigation_native_turns SET interrupt_ack=1`,
    `UPDATE investigation_native_turns SET state='observed'`,
  ]) fixture(db=>{settledWindowsLaunch(db,{nativeUnknown:'turn'});db.exec(update);},'unsafe');
  fixture(db=>{
    settledWindowsLaunch(db,{nativeUnknown:'turn'});
    db.prepare(`UPDATE investigation_native_threads SET thread_id='thread-1'`).run();
    db.prepare(`UPDATE investigation_native_turns SET state='observed',turn_id='turn-1'`).run();
  },'safe');
});

test('closed-launch exception requires one attempt and matching launch and closure row keys',()=>{
  fixture(db=>{
    settledWindowsLaunch(db);
    const row=db.prepare(`SELECT record_json FROM investigation_requests WHERE id='inv'`)
      .get() as {record_json:string};
    const value=JSON.parse(row.record_json) as {attempts:Record<string,unknown>[]};
    value.attempts.push({...value.attempts[0],id:'extra'});
    db.prepare(`UPDATE investigation_requests SET record_json=? WHERE id='inv'`)
      .run(JSON.stringify(value));
  },'unsafe');
  fixture(db=>{
    settledWindowsLaunch(db);
    const row=db.prepare(`SELECT record_json FROM investigation_windows_app_server_launches`)
      .get() as {record_json:string};
    const value=JSON.parse(row.record_json) as Record<string,unknown>;
    value.launchId='99999999-9999-4999-8999-999999999999';
    db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?`)
      .run(JSON.stringify(value));
  },'unsafe');
  fixture(db=>{
    settledWindowsLaunch(db);
    const row=db.prepare(`SELECT record_json FROM investigation_windows_app_server_closures`)
      .get() as {record_json:string};
    const value=JSON.parse(row.record_json) as {launchId:string;observation:{launchId:string}};
    value.launchId='99999999-9999-4999-8999-999999999999';
    value.observation.launchId=value.launchId;
    db.prepare(`UPDATE investigation_windows_app_server_closures SET record_json=?`)
      .run(JSON.stringify(value));
  },'unsafe');
});

test('all Windows launch rows require a current settled chain at quiescence',()=>{
  fixture(db=>{
    request(db);
    db.prepare(`INSERT INTO investigation_windows_app_server_launches
      (attempt_id,request_id,launch_id,record_json) VALUES (?,?,?,?)`)
      .run('orphan','inv','22222222-2222-4222-8222-222222222222','{}');
  },'unsafe');
  fixture(db=>{
    settledWindowsLaunch(db);
    const row=db.prepare(`SELECT record_json FROM investigation_windows_app_server_launches`)
      .get() as {record_json:string};
    const launch=JSON.parse(row.record_json) as {binding:Record<string,unknown>};
    delete launch.binding.runtimeId;
    delete launch.binding.configSha256;
    db.prepare(`UPDATE investigation_windows_app_server_launches SET record_json=?`)
      .run(JSON.stringify(launch));
  },'unsafe');
});

test('investigation preflight rejects queued outbox, expired active attempt, and unobserved native thread or turn', () => {
  fixture(db => { request(db); db.prepare('INSERT INTO investigation_outbox VALUES (?,?,?,?)')
    .run('inv', 'w', 'c', '2026-01-01T00:00:00.000Z'); }, 'unsafe');
  fixture(db => { request(db); db.prepare(`INSERT INTO investigation_active_attempts
    (request_id,attempt_id,workspace_id,worker_id,worker_epoch,phase,lease_until,profile_revision,
    permission_epoch,isolation_evidence) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('inv', 'attempt', 'w', 'worker', 1, 'start_intent', '2000-01-01T00:00:00.000Z', 'fixed', 0, 'verified'); }, 'unsafe');
  fixture(db => { request(db); db.prepare(`INSERT INTO investigation_native_threads
    (attempt_id,request_id,workspace_id,collaboration_id,worker_epoch,thread_id) VALUES (?,?,?,?,?,?)`)
    .run('attempt', 'inv', 'w', 'c', 1, null); }, 'unsafe');
  fixture(db => { request(db); db.prepare(`INSERT INTO investigation_native_threads
    (attempt_id,request_id,workspace_id,collaboration_id,worker_epoch,thread_id) VALUES (?,?,?,?,?,?)`)
    .run('attempt', 'inv', 'w', 'c', 1, 'native'); db.prepare(`INSERT INTO investigation_native_turns
    (attempt_id,intent_id,turn_id,state) VALUES (?,?,?,?)`).run('attempt', 'intent', null, 'intent'); }, 'unsafe');
});

test('terminal records without a native launch remain eligible, while unsettled and orphan model facts do not', () => {
  fixture(db => request(db, { failureReason: 'closed_before_native_launch' }), 'safe');
  fixture(db => request(db, { state: 'running' }), 'unsafe');
  fixture(db => {
    request(db);
    db.prepare(`INSERT INTO investigation_model_dispatch
      (attempt_id,request_id,launch_epoch,native_ref,profile_digest,command_digest,prompt_hash,intent_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run('orphan', 'inv', 1, 'native', 'profile', 'command', 'hash', '2026-01-01T00:00:00.000Z');
  }, 'unsafe');
});

test('model prevention and tree closure require their own correlated durable facts', () => {
  const attempt = { ...record.attempts[0], nativeRef: 'native-model',
    startedAt: '2026-01-01T00:00:00.000Z' };
  fixture(db => request(db, { failureReason: 'model_execution_prevented', attempts: [attempt] }), 'unsafe');
  fixture(db => {
    request(db, { failureReason: 'model_execution_prevented', attempts: [attempt] });
    db.prepare(`INSERT INTO investigation_model_prevention_facts
      (attempt_id,request_id,cleanup_epoch,observation_json,settled_at) VALUES (?,?,?,?,?)`)
      .run('attempt', 'inv', 1, '{}', '2026-01-01T00:00:00.000Z');
  }, 'safe');
  fixture(db => {
    request(db, { failureReason: 'model_tree_terminated_without_outcome',
      attempts: [{ ...attempt, terminationConfirmed: true }] });
    db.prepare(`INSERT INTO investigation_model_tree_facts
      (attempt_id,request_id,cleanup_epoch,observation_json,settled_at) VALUES (?,?,?,?,?)`)
      .run('attempt', 'inv', 1, '{}', '2026-01-01T00:00:00.000Z');
  }, 'safe');
});

test('native-started unknown termination cannot pass without correlated result or special closure fact', () => {
  const attempt = { ...record.attempts[0], nativeRef: 'native-attempt',
    startedAt: '2026-01-01T00:00:00.000Z' };
  fixture(db => request(db, { attempts: [attempt], failureReason: undefined }), 'unsafe');
  fixture(db => request(db, { attempts: [attempt], failureReason: 'authorization_changed' }), 'unsafe');
  fixture(db => request(db, { attempts: [attempt], failureReason: undefined,
    result: { requestId: 'inv', attemptId: 'attempt', resultState: 'failed',
      snapshotRef: 'snap', contextRevisionId: 'ctx' } }), 'safe');
});

test('preflight limits one SQLite row and cumulative string bytes before loading row bodies', () => {
  fixture(db => {
    binding(db);
    db.exec("UPDATE session_control SET state_json=CAST(zeroblob(16777217) AS TEXT) WHERE binding_id='b'");
  }, 'limit');
  fixture(db => {
    binding(db);
    db.exec(`UPDATE session_control SET state_json=json_set(state_json,'$.filler',
      printf('%.*c',8388608,120)) WHERE binding_id='b'`);
    db.exec(`INSERT INTO session_control(binding_id,workspace_id,collaboration_id,provider_id,account_id,
      native_session_id,revision,epoch,state_json,lifecycle)
      SELECT 'b2',workspace_id,collaboration_id,provider_id,'a2','n2',revision,epoch,
      json_set(state_json,'$.bindingId','b2','$.accountId','a2','$.nativeSessionId','n2'),lifecycle
      FROM session_control WHERE binding_id='b'`);
  }, 'limit');
});

function settledNotStartedWindowsLaunch(db:DatabaseSync):void {
  settledWindowsLaunch(db);
  const launchRow=db.prepare('SELECT launch_id,record_json FROM investigation_windows_app_server_launches')
    .get() as {launch_id:string;record_json:string};
  const launch=JSON.parse(launchRow.record_json) as Record<string,unknown> &
    {binding:Record<string,unknown>};
  launch.binding.protocolTarget='windows-desktop-26.930.4958.0-codex-0.160.0';
  launch.identity=null;launch.observedAt=null;
  db.prepare('UPDATE investigation_windows_app_server_launches SET record_json=? WHERE launch_id=?')
    .run(JSON.stringify(launch),launchRow.launch_id);
  const requestRow=db.prepare("SELECT record_json FROM investigation_requests WHERE id='inv'")
    .get() as {record_json:string};
  const request=JSON.parse(requestRow.record_json) as Record<string,unknown> &
    {attempts:Array<Record<string,unknown>>};
  request.failureReason='windows_launch_not_started';
  request.attempts[0]!.terminationConfirmed=false;
  db.prepare("UPDATE investigation_requests SET record_json=? WHERE id='inv'")
    .run(JSON.stringify(request));
  const settlement=db.prepare('SELECT * FROM investigation_windows_launch_settlement_facts').get() as
    {attempt_id:string;request_id:string;launch_id:string;cleanup_epoch:number;fact_json:string};
  db.prepare('DELETE FROM investigation_windows_launch_settlement_facts').run();
  db.prepare('DELETE FROM investigation_windows_app_server_closures').run();
  windowsStartIntent(db);
  const observation={kind:'windows_app_server_not_started_v1',protocol:'windows_job_stdio_v1',
    helperVersion:'3',recipe:'windows_app_server_readonly_v1',launchId:launchRow.launch_id,
    hostScopeId:launch.binding.hostScopeId,executionInstanceId:launch.binding.executionInstanceId,
    helper:{pid:1234,creationFiletime:'133000000000000000'},
    prepared:{kind:'prepared',sequence:1,childPresent:false},
    preparedClosed:{kind:'prepared_closed',sequence:2,childPresent:false,
      members:{complete:true,assigned:0,listed:0,pids:[]}},helperExitCode:0};
  db.prepare(`INSERT INTO investigation_windows_app_server_not_started
    (launch_id,record_json) VALUES (?,?)`).run(launchRow.launch_id,
      JSON.stringify({launchId:launchRow.launch_id,observation,recordedAt:launch.intentAt}));
  db.prepare(`INSERT INTO investigation_windows_not_started_settlement_facts
    (attempt_id,request_id,launch_id,cleanup_epoch,fact_json) VALUES (?,?,?,?,?)`).run(
      settlement.attempt_id,settlement.request_id,settlement.launch_id,
      settlement.cleanup_epoch,settlement.fact_json);
}

test('not-started preflight requires exact no-child proof, reservation and separate settlement',()=>{
  fixture(db=>settledNotStartedWindowsLaunch(db),'safe');
  fixture(db=>{settledNotStartedWindowsLaunch(db);
    db.prepare('DELETE FROM investigation_windows_app_server_not_started').run();},'unsafe');
  fixture(db=>{settledNotStartedWindowsLaunch(db);
    db.prepare('DELETE FROM investigation_windows_app_server_start_intents').run();},'unsafe');
  fixture(db=>{settledNotStartedWindowsLaunch(db);
    db.prepare(`INSERT INTO investigation_native_threads
      (attempt_id,request_id,workspace_id,collaboration_id,worker_epoch,thread_id)
      VALUES (?,?,?,?,?,?)`).run('attempt_11111111-1111-4111-8111-111111111111','inv','w','c',1,null);
  },'unsafe');
});
