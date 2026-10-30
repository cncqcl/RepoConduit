import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SqliteInvestigationStore, type InvestigationClaim,
  type InvestigationClaimAuthority } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { buildClaudeModelSealedLaunch } from
  '../../src/adapters/secondary-investigator/claude-model-sealed-launch.js';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON, CLAUDE_MODEL_BOOTSTRAP_SHA256 } from
  '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';
import { historicalClaudeModelRecipe, historicalClaudeModelParentArgv } from
  '../../src/adapters/secondary-investigator/claude-model-historical.js';
import { claudeModelSupervisorSpec } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor.js';
import { validateClaudeModelOuterFact, validateCurrentClaudeModelOuterFact,
  type ModelOuterConfinedFact } from
  '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';
import { createClaudeModelOuterTickets } from '../../src/runtime/claude-model-outer-tickets.js';
import { createClaudeModelRunningTickets } from '../../src/runtime/claude-model-running-tickets.js';
import { persistClaudeModelRunning } from '../../src/runtime/claude-model-start-observation.js';
import { runClaudeModelInvestigation, startClaudeModelOriginalLeaseHeartbeat,
  ClaudeModelPromptLimitExceeded } from '../../src/runtime/claude-model-investigation.js';
import { createPersistedInvestigatorMcpServer } from '../../src/adapters/secondary-investigator/persisted-mcp.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { RepositoryApplication } from '../../src/application/repository.js';
import { openApplication } from '../../src/runtime/application.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';
import { ContextDecisionSqlite } from '../../src/adapters/storage/context-decisions-sqlite.js';
import { authorize } from '../../src/core/policy/authorize.js';
import { createClaudeModelTreeTickets, createClaudeModelOriginalCompletionTickets } from '../../src/runtime/claude-model-tree-tickets.js';
import type { ClaudeModelTreeTerminalObservation } from
  '../../src/adapters/secondary-investigator/claude-model-tree-terminal.js';
import { readSnapshot } from '../../src/adapters/repository/queries.js';
import { parseInvestigationResult } from '../../src/core/investigation/result.js';
import { validateInvestigationResultEvidence } from '../../src/runtime/claude-model-investigation.js';

// This deidentified fixture is rebound ONLY for an offline counterfactual SQLite test.
// It does not show a new process, prompt, model turn, native receipt or current isolation.
const stem = 'tests/fixtures/legacy-runtime/outer-observer';
const sample = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
const rawSample = JSON.parse(readFileSync(`${stem}.raw.json`, 'utf8'));
const promptHash = 'c'.repeat(64);
const windowReceipt = 'synthetic-window';
const outerReceipt = 'synthetic-outer';
const profileRevision = 'synthetic-model';

function fixture(options: { outerVerifier?: boolean; windowVerifier?: boolean;
  historical?: boolean; question?: string; bom?: boolean; exclusions?: boolean;
  composition?: boolean } = {}) {
  const outer = mkdtempSync(join(options.composition&&process.platform==='win32'?homedir():tmpdir(),
    'rcac-model-outer-db-'));
  const dir = options.composition ? join(outer, 'data') : outer;
  if(options.composition) mkdirSync(dir, { mode: 0o700 });
  if(options.composition) protectNewDataDirectory(dir);
  const file = join(dir, 'state.sqlite');
  const base = new SqliteStore(file);
  const now = new Date();
  const workspaceId = sample.descriptor.workspaceId as string;
  const snapshot = createSnapshotFromFiles('wc-outer', 'synthetic-commit',
    {'src/a.ts': Buffer.from(`${options.bom?'\uFEFF':''}synthetic source\r\n`)},
    options.exclusions?[{path:'untracked.txt',reason:'untracked'}]:[]);
  const record: InvestigationRecord = { id: `inv-${randomUUID()}`, workspaceId,
    collaborationId: 'col-outer', workingCopyId: 'wc-outer', principal: 'external',
    audience: 'chatgpt', recipient: 'web', grantId: 'request', profileRef: profileRevision,
    budgetRef: 'synthetic', budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 5 },
    snapshotRef: snapshot.id, contextRevisionId: 'ctx-outer', question: options.question ?? 'Trace flow',
    scope: { paths: ['src/a.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
    parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
    createdAt: now.toISOString() };
  base.insertWorkspace({ id: workspaceId, name: 'outer fixture', canonicalRoot: dir, registeredBy: 'owner' });
  base.insertCollaboration({ id: 'col-outer', workspaceId, purpose: 'outer fixture',
    openedBy: 'owner', hostThreadId: null, state: 'open' });
  base.insertWorkingCopy({ id: 'wc-outer', workspaceId, canonicalRoot: dir });
  base.insertGrant({ id: 'request', principal: 'external', audience: 'chatgpt', recipient: 'web',
    workspaceId, collaborationId: 'col-outer', permissions: ['investigation.request', 'investigation.cancel'],
    revokedAt: null, expiresAt: null });
  base.insertGrant({ id: 'read', principal: 'external', audience: 'chatgpt', recipient: 'web',
    workspaceId, collaborationId: 'col-outer', permissions: ['data.read'], dataPaths: ['src/a.ts'],
    revokedAt: null, expiresAt: null });
  base.insertGrant({ id: 'worker-read', principal: 'worker', audience: 'investigator', recipient: 'local',
    workspaceId, collaborationId: 'col-outer', permissions: ['data.read'], dataPaths: ['src/a.ts'],
    revokedAt: null, expiresAt: new Date(now.getTime() + 120_000).toISOString() });
  const calls: string[] = [];
  const authority: InvestigationClaimAuthority = {
    verifyIsolation: () => true, verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true,
    verifyModelRunningObservationReceipt: () => true,
    ...(options.outerVerifier === false ? {} : { verifyModelOuterReceipt:
      (_claim: unknown, _resource: unknown, fact: unknown, receipt: unknown) => {
        calls.push('outer'); return receipt === outerReceipt && validateClaudeModelOuterFact(fact as ModelOuterConfinedFact);
      } }),
    ...(options.windowVerifier === false ? {} : { verifyModelPromptWindowReceipt:
      (_claim: unknown, _fact: unknown, receipt: unknown, purpose: unknown) => {
        calls.push(String(purpose)); return receipt === windowReceipt &&
          (purpose === 'intent' || purpose === 'send');
      } }),
  };
  const store = new SqliteInvestigationStore(file, authority);
  store.enqueue(record, 'submit', 'fingerprint');
  const claim = store.claimRequest(record.id, { workerId: 'worker', isolationEvidence: 'synthetic',
    profileRevision, permissionEpoch: 0, now, launchProtocol: 'resource_reservation_v1' })!;
  const paths = structuredClone(sample.paths);
  paths.privateFifoDirectory = `${sample.root}/${claim.attemptId}-${claim.workerEpoch}.mcp`;
  const launch = { workerEpoch: claim.workerEpoch, sourceDigest: sample.descriptor.sourceDigest,
    profileDigest: sample.descriptor.profileDigest, action: 'claude_model_v1' as const,
    commandDigest: options.historical ? historicalClaudeModelRecipe(paths,sample.profile).commandDigest :
      buildClaudeModelSealedLaunch(paths, sample.profile, 2).commandDigest };
  const reservation = { unitName: sample.descriptor.unitName as string,
    distro: sample.descriptor.distro as string, uid: sample.descriptor.uid as number,
    bootId: sample.descriptor.bootId as string,
    gate: { protocol: 'attempt_gate_v1' as const, linuxUser: sample.descriptor.linuxUser as string, root: sample.root as string,
      payloadKind: 'claude_model_v1' as const, launch } };
  const binding = { collaborationId: 'col-outer', workingCopyId: 'wc-outer', snapshotId: snapshot.id,
    paths: ['src/a.ts'], workerGrantId: 'worker-read', workerAudience: 'investigator',
    workerRecipient: 'local' };
  let closed = false;
  return { dir, file, base, store, now, claim, paths, launch, reservation, binding, authority, calls, snapshot,
    historical:options.historical===true,
    closeStore() { store.close(); closed = true; },
    close() {
      if (!closed) store.close(); base.close();
      assert.match(relative(resolve(options.composition&&process.platform==='win32'?homedir():tmpdir()), resolve(outer)),
        /^rcac-model-outer-db-[A-Za-z0-9_-]{6}$/);
      rmSync(outer, { recursive: true, force: true });
    } };
}

function start(f: ReturnType<typeof fixture>, persistRunning = true) {
  const reserved = f.store.reserveWslResource(f.claim, f.reservation, f.now);
  const observed = f.store.observeWslResource(reserved, {
    invocationId: sample.running.resource.invocationId,
    controlGroup: sample.running.resource.controlGroup }, f.now);
  const current = f.store.recordNativeStart(observed, 'synthetic-native', 'synthetic-native', f.now);
  const journal = { ...sample.running.journal, attemptId: current.attemptId,
    workspaceId: current.workspaceId, launchWorkerEpoch: current.workerEpoch,
    commandDigest: f.launch.commandDigest };
  const running = { ...sample.running, resource: current.wslResource!, journal };
  if (persistRunning) f.store.recordModelRunningObservation(current, running, 'synthetic-running', f.now);
  return current;
}

function rebound(f: ReturnType<typeof fixture>, current: InvestigationClaim): ModelOuterConfinedFact {
  const oldRelay = sample.paths.privateFifoDirectory as string;
  const newRelay = f.paths.privateFifoDirectory as string;
  const probe = structuredClone(rawSample);
  const replaceRelay = (value: string) => value.split(oldRelay).join(newRelay);
  probe.hostMountinfoRaw = replaceRelay(probe.hostMountinfoRaw);
  probe.hostMountinfoRawAfter = replaceRelay(probe.hostMountinfoRawAfter);
  for (const role of ['outer', 'bootstrap'] as const) {
    probe.processes[role].mountinfoRaw = replaceRelay(probe.processes[role].mountinfoRaw);
    probe.processes[role].mountinfoRawAfter = replaceRelay(probe.processes[role].mountinfoRawAfter);
  }
  const relay = probe.backingPaths.find((item: { target: string }) => item.target === '/relay');
  assert.ok(relay);
  relay.source = newRelay; relay.realpath = newRelay;
  const descriptor = { ...sample.descriptor, attemptId: current.attemptId,
    workspaceId: current.workspaceId, launchWorkerEpoch: current.workerEpoch,
    commandDigest: f.launch.commandDigest };
  const running = { ...sample.running, resource: current.wslResource!,
    journal: { ...sample.running.journal, attemptId: current.attemptId,
      workspaceId: current.workspaceId, launchWorkerEpoch: current.workerEpoch,
      commandDigest: f.launch.commandDigest } };
  const startup = { ...sample.startup, journal: { ...running.journal, phase: 'consumed' },
    bootstrapSha256: f.historical ? sample.startup.bootstrapSha256 : CLAUDE_MODEL_BOOTSTRAP_SHA256 };
  const capturedParent=(rawSample.processes.parent.cmdline as string).slice(0,-1).split('\0');
  const parentArgs = f.historical ? historicalClaudeModelParentArgv(descriptor,
    f.reservation.gate.root,f.paths,sample.profile,60,capturedParent[4]!,capturedParent[20]!) :
    (()=>{const args=claudeModelSupervisorSpec('enter_wait_exec', descriptor,
      f.reservation.gate.root, f.paths, undefined, { maxWallSeconds: 60, maxTurns: 2 }, sample.profile).args;
      return args.slice(args.indexOf('/usr/bin/python3'));})();
  assert.ok(parentArgs);
  probe.processes.parent.cmdline = parentArgs.join('\0') + '\0';
  const sealed = f.historical ? historicalClaudeModelRecipe(f.paths,sample.profile) :
    buildClaudeModelSealedLaunch(f.paths, sample.profile, 2);
  probe.processes.wrapper.cmdline = [sealed.recipe.file, ...sealed.recipe.argv].join('\0') + '\0';
  probe.processes.outer.cmdline = probe.processes.wrapper.cmdline;
  probe.processes.bootstrap.cmdline = ['/usr/bin/python3','-I','-S',
    '/opt/rcac-bootstrap.py',...(f.historical?[]:['2'])].join('\0')+'\0';
  const fixed = probe.mountedFixedFiles.find((item: {target:string}) => item.target === '/opt/rcac-bootstrap.py')!;
  if(!f.historical) {
    fixed.byteLength = Buffer.byteLength(CLAUDE_MODEL_BOOTSTRAP_PYTHON, 'utf8');
    fixed.stat.size = fixed.byteLength;
    fixed.sha256 = CLAUDE_MODEL_BOOTSTRAP_SHA256;
  }
  probe.processes.parent.fds.find((item: { fd: number }) => item.fd === 3)!.target = f.reservation.gate.root;
  probe.processes.parent.fds.find((item: { fd: number }) => item.fd === 4)!.target =
    `${f.reservation.gate.root}/${current.attemptId}.model-supervisor.lock`;
  return { kind: 'model_outer_confined_v1', networkMode: 'host_shared_pre_srt',
    srtState: 'not_started', expectation: { descriptor, paths: f.paths, profile: sample.profile,
      profileRevision, limits: f.historical ? {maxWallSeconds:60} :
        { maxWallSeconds: 60, maxTurns: 2 } },
    observation: { kind: 'outer_journal_candidate', journalAfter: startup.journal,
      candidate: { kind: 'outer_probe_candidate', running, startup, probe } } } as ModelOuterConfinedFact;
}

function ready(f: ReturnType<typeof fixture>) {
  const claim = start(f);
  const fact = rebound(f, claim);
  assert.equal(validateClaudeModelOuterFact(fact), true, 'rebinding must preserve pure-fact validity');
  return { claim, fact };
}

test('verified outer fact persists exactly, survives reopen, and remains historical after recovery', () => {
  const f = fixture(); let reopened: SqliteInvestigationStore | undefined;
  try {
    const { claim, fact } = ready(f);
    assert.equal(f.store.getModelOuterFact(claim), null);
    f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
    assert.deepEqual(f.store.getModelOuterFact(claim), fact);
    assert.deepEqual(f.calls, ['outer']);
    f.closeStore(); reopened = new SqliteInvestigationStore(f.file, f.authority);
    assert.deepEqual(reopened.getModelOuterFact(claim), fact);
    const recovered = reopened.recoverAttempt(claim, { workerId: claim.workerId,
      isolationEvidence: 'synthetic', profileRevision, permissionEpoch: 0,
      now: new Date(f.now.getTime() + 31_000) });
    assert.deepEqual(reopened.getModelOuterFact(recovered), fact);
    assert.throws(() => reopened!.recordModelPromptIntent(recovered, f.binding,
      f.launch, promptHash, new Date(f.now.getTime() + 31_000), windowReceipt));
  } finally { reopened?.close(); f.close(); }
});

test('mixed v2 parent with v3 recipe cannot be recorded or read as history', () => {
  const f = fixture(); let reopened: SqliteInvestigationStore | undefined;
  try {
    const {claim,fact}=ready(f);
    const historical=structuredClone(fact);
    const argv=historical.observation.candidate.probe.processes.parent.cmdline.slice(0,-1).split('\0');
    const frozenArgv=(rawSample.processes.parent.cmdline as string).slice(0,-1).split('\0');
    argv[4]=frozenArgv[4]!;
    historical.observation.candidate.probe.processes.parent.cmdline=argv.join('\0')+'\0';
    assert.equal(validateClaudeModelOuterFact(historical),false);
    assert.equal(validateCurrentClaudeModelOuterFact(historical),false);
    assert.throws(() => f.store.recordModelOuterFact(claim,f.binding,historical,outerReceipt,f.now));
    assert.equal(f.store.getModelOuterFact(claim),null);
    f.store.recordModelOuterFact(claim,f.binding,fact,outerReceipt,f.now);
    f.closeStore();
    const db=new DatabaseSync(f.file);
    try { db.prepare(`UPDATE investigation_model_running_facts SET outer_json=?
      WHERE attempt_id=? AND request_id=?`).run(JSON.stringify(historical),claim.attemptId,claim.requestId); }
    finally {db.close();}
    reopened=new SqliteInvestigationStore(f.file,f.authority);
    assert.throws(() => reopened!.getModelOuterFact(claim));
  } finally {reopened?.close(); f.close();}
});

test('complete v2 fact remains readable after reopen and recovery but cannot authorize intent or send', () => {
  const f=fixture({historical:true});let reopened:SqliteInvestigationStore|undefined;
  try {
    const claim=start(f);
    const fact=rebound(f,claim);
    assert.equal(validateClaudeModelOuterFact(fact),true);
    assert.equal(validateCurrentClaudeModelOuterFact(fact),false);
    assert.throws(()=>f.store.recordModelOuterFact(claim,f.binding,fact,outerReceipt,f.now));
    f.closeStore();
    const db=new DatabaseSync(f.file);
    try {db.prepare(`UPDATE investigation_model_running_facts SET outer_json=?
      WHERE attempt_id=? AND request_id=?`).run(JSON.stringify(fact),claim.attemptId,claim.requestId);}
    finally {db.close();}
    reopened=new SqliteInvestigationStore(f.file,f.authority);
    assert.deepEqual(reopened.getModelOuterFact(claim),fact);
    assert.throws(()=>reopened!.recordModelPromptIntent(claim,f.binding,f.launch,
      promptHash,f.now,windowReceipt));
    const oldIntentDb=new DatabaseSync(f.file);
    try {oldIntentDb.prepare(`INSERT INTO investigation_model_dispatch
      (attempt_id,request_id,launch_epoch,native_ref,profile_digest,command_digest,prompt_hash,intent_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(claim.attemptId,claim.requestId,f.launch.workerEpoch,
        claim.nativeRef!,f.launch.profileDigest,f.launch.commandDigest,promptHash,f.now.toISOString());}
    finally {oldIntentDb.close();}
    assert.equal(reopened.getModelPromptIntent(claim)?.promptHash,promptHash);
    assert.throws(()=>reopened!.assertModelPromptSendAuthority(claim,f.binding,f.launch,
      promptHash,f.now,windowReceipt));
    const recovered=reopened.recoverAttempt(claim,{workerId:claim.workerId,
      isolationEvidence:'synthetic',profileRevision,permissionEpoch:0,
      now:new Date(f.now.getTime()+31_000)});
    assert.deepEqual(reopened.getModelOuterFact(recovered),fact);
  } finally {reopened?.close();f.close();}
});

test('outer fact requires its own receipt, exact current profile and budget, and one immutable value', () => {
  for (const mode of ['missing-verifier', 'bad-receipt', 'changed-profile', 'changed-limit',
    'conflict', 'intent-exists'] as const) {
    const f = fixture({ outerVerifier: mode !== 'missing-verifier' });
    try {
      const { claim, fact } = ready(f);
      if (mode === 'intent-exists') {
        const db = new DatabaseSync(f.file);
        try { db.prepare('INSERT INTO investigation_model_dispatch VALUES (?,?,?,?,?,?,?,?)').run(
          claim.attemptId, claim.requestId, claim.workerEpoch, claim.nativeRef!,
          f.launch.profileDigest, f.launch.commandDigest, promptHash, f.now.toISOString()); }
        finally { db.close(); }
      }
      if (mode === 'conflict') {
        f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
        const changed = structuredClone(fact);
        changed.observation.candidate.probe.endingIdentities.parent.state = 'R';
        assert.throws(() => f.store.recordModelOuterFact(claim, f.binding, changed, outerReceipt, f.now));
        assert.deepEqual(f.store.getModelOuterFact(claim), fact);
      } else {
        if (mode === 'changed-profile') fact.expectation.profileRevision = 'old-profile';
        if (mode === 'changed-limit') fact.expectation.limits.maxWallSeconds = 20;
        assert.throws(() => f.store.recordModelOuterFact(claim, f.binding, fact,
          mode === 'bad-receipt' ? 'invented' : outerReceipt, f.now), mode);
        assert.equal(f.store.getModelOuterFact(claim), null, mode);
      }
    } finally { f.close(); }
  }
});

test('outer fact, intent and send preflight each recheck current disclosure and execution fences', () => {
  for (const stage of ['outer', 'intent', 'send'] as const) {
    for (const mode of ['request-revoked', 'read-revoked', 'worker-revoked',
      'cancel', 'lease-expired', 'wall-expired', 'epoch'] as const) {
      const f = fixture();
      try {
        const { claim, fact } = ready(f);
        if (stage !== 'outer') f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
        if (stage === 'send') f.store.recordModelPromptIntent(claim, f.binding,
          f.launch, promptHash, f.now, windowReceipt);
        let current = claim; let now = f.now;
        if (mode === 'request-revoked') f.base.revokeGrant('request', now.toISOString());
        if (mode === 'read-revoked') f.base.revokeGrant('read', now.toISOString());
        if (mode === 'worker-revoked') f.base.revokeGrant('worker-read', now.toISOString());
        if (mode === 'cancel') f.store.requestCancel(f.store.get(claim.requestId)!, 'cancel', 'request');
        if (mode === 'lease-expired' || mode === 'wall-expired') {
          f.store.renewLease(current, new Date(now.getTime() + 20_000));
          f.store.renewLease(current, new Date(now.getTime() + 40_000));
          now = new Date(now.getTime() + (mode === 'lease-expired' ? 71_000 : 60_000));
        }
        if (mode === 'epoch') {
          now = new Date(f.now.getTime() + 31_000);
          current = f.store.recoverAttempt(claim, { workerId: claim.workerId,
            isolationEvidence: 'synthetic', profileRevision, permissionEpoch: 0, now });
        }
        const act = () => stage === 'outer' ? f.store.recordModelOuterFact(current, f.binding,
          fact, outerReceipt, now) : stage === 'intent' ?
          f.store.recordModelPromptIntent(current, f.binding, f.launch, promptHash, now, windowReceipt) :
          f.store.assertModelPromptSendAuthority(current, f.binding, f.launch,
            promptHash, now, windowReceipt);
        assert.throws(act, `${stage}/${mode}`);
        if (stage === 'outer') assert.equal(f.store.getModelOuterFact(current), null);
        if (stage === 'intent') assert.equal(f.store.getModelPromptIntent(current), null);
      } finally { f.close(); }
    }
  }
});

test('intent requires saved outer fact and an intent-window receipt; send requires exact one-shot intent', () => {
  const f = fixture();
  try {
    const { claim, fact } = ready(f);
    assert.throws(() => f.store.recordModelPromptIntent(claim, f.binding,
      f.launch, promptHash, f.now, windowReceipt));
    f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
    assert.throws(() => f.store.recordModelPromptIntent(claim, f.binding,
      f.launch, promptHash, f.now));
    assert.equal(f.store.getModelPromptIntent(claim), null);
    assert.throws(() => f.store.recordModelPromptIntent(claim, f.binding,
      f.launch, promptHash, f.now, 'invented'));
    assert.throws(() => f.store.assertModelPromptSendAuthority(claim, f.binding,
      f.launch, promptHash, f.now, windowReceipt));
    f.store.recordModelPromptIntent(claim, f.binding, f.launch, promptHash, f.now, windowReceipt);
    assert.equal(f.store.getModelPromptIntent(claim)?.promptHash, promptHash);
    assert.throws(() => f.store.recordModelPromptIntent(claim, f.binding,
      f.launch, promptHash, f.now, windowReceipt), 'repeated prompt intent is forbidden');
    assert.throws(() => f.store.assertModelPromptSendAuthority(claim, f.binding,
      f.launch, 'f'.repeat(64), f.now, windowReceipt));
    assert.throws(() => f.store.assertModelPromptSendAuthority(claim, f.binding,
      { ...f.launch, commandDigest: 'f'.repeat(64) }, promptHash, f.now, windowReceipt));
    assert.throws(() => f.store.assertModelPromptSendAuthority(claim, f.binding,
      f.launch, promptHash, f.now, 'invented'));
    assert.doesNotThrow(() => f.store.assertModelPromptSendAuthority(claim, f.binding,
      f.launch, promptHash, f.now, windowReceipt));
    assert.deepEqual(f.calls.filter(p => p === 'intent'), ['intent', 'intent']);
    assert.ok(f.calls.includes('send'));
  } finally { f.close(); }
});

test('legacy table migration never backfills outer fact or erases uncertain prompt intent', () => {
  const f = fixture(); let reopened: SqliteInvestigationStore | undefined;
  try {
    const { claim } = ready(f);
    f.closeStore();
    const db = new DatabaseSync(f.file);
    try {
      db.exec('ALTER TABLE investigation_model_running_facts DROP COLUMN outer_json');
      db.prepare('INSERT INTO investigation_model_dispatch VALUES (?,?,?,?,?,?,?,?)').run(
        claim.attemptId, claim.requestId, claim.workerEpoch, claim.nativeRef!,
        f.launch.profileDigest, f.launch.commandDigest, promptHash, f.now.toISOString());
    } finally { db.close(); }
    reopened = new SqliteInvestigationStore(f.file, f.authority);
    assert.equal(reopened.getModelOuterFact(claim), null);
    assert.equal(reopened.getModelPromptIntent(claim)?.promptHash, promptHash);
    assert.throws(() => reopened!.assertModelPromptSendAuthority(claim, f.binding,
      f.launch, promptHash, f.now, windowReceipt));
  } finally { reopened?.close(); f.close(); }
});

test('new intent without an outer fact is denied even with legacy running evidence', () => {
  const f = fixture();
  try {
    const { claim } = ready(f);
    assert.equal(f.store.getModelOuterFact(claim), null);
    assert.throws(() => f.store.recordModelPromptIntent(claim, f.binding,
      f.launch, promptHash, f.now, windowReceipt));
    assert.equal(f.store.getModelPromptIntent(claim), null);
  } finally { f.close(); }
});

test('outer fact cannot backfill a missing saved native observation', () => {
  const f = fixture();
  try {
    const claim = start(f, false);
    const fact = rebound(f, claim);
    assert.equal(validateClaudeModelOuterFact(fact), true);
    assert.equal(f.store.getModelRunningObservation(claim), null);
    assert.throws(() => f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now));
    assert.equal(f.store.getModelOuterFact(claim), null);
  } finally { f.close(); }
});

test('saved outer fact alone cannot authorize intent or send without window verifier', () => {
  const f = fixture({ windowVerifier: false });
  try {
    const { claim, fact } = ready(f);
    f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
    assert.throws(() => f.store.recordModelPromptIntent(claim, f.binding,
      f.launch, promptHash, f.now, windowReceipt));
    assert.equal(f.store.getModelPromptIntent(claim), null);
    const db = new DatabaseSync(f.file);
    try { db.prepare('INSERT INTO investigation_model_dispatch VALUES (?,?,?,?,?,?,?,?)').run(
      claim.attemptId, claim.requestId, claim.workerEpoch, claim.nativeRef!,
      f.launch.profileDigest, f.launch.commandDigest, promptHash, f.now.toISOString()); }
    finally { db.close(); }
    assert.throws(() => f.store.assertModelPromptSendAuthority(claim, f.binding,
      f.launch, promptHash, f.now, windowReceipt));
  } finally { f.close(); }
});

test('grant and lease expiry during receipt validation cannot authorize a write or send', t => {
  for (const stage of ['outer', 'intent', 'send'] as const) {
    for (const mode of ['grant', 'lease'] as const) {
      const f = fixture();
      try {
        const {claim, fact} = ready(f);
        if (stage !== 'outer') f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
        if (stage === 'send') f.store.recordModelPromptIntent(claim, f.binding, f.launch,
          promptHash, f.now, windowReceipt);
        if (mode === 'grant') {
          const db = new DatabaseSync(f.file);
          try { db.prepare('UPDATE grants SET expires_at=? WHERE id=?')
            .run(new Date(f.now.getTime()+1000).toISOString(), 'worker-read'); }
          finally { db.close(); }
        }
        let spent = 0;
        t.mock.method(performance, 'now', () => spent);
        const expire = () => { spent = mode === 'grant' ? 2000 : 31000; return true; };
        if (stage === 'outer') f.authority.verifyModelOuterReceipt = expire;
        else f.authority.verifyModelPromptWindowReceipt = expire;
        const act = () => stage === 'outer' ? f.store.recordModelOuterFact(claim, f.binding,
          fact, outerReceipt, f.now) : stage === 'intent' ?
          f.store.recordModelPromptIntent(claim, f.binding, f.launch, promptHash, f.now, windowReceipt) :
          f.store.assertModelPromptSendAuthority(claim, f.binding, f.launch, promptHash, f.now, windowReceipt);
        assert.throws(act, `${stage}/${mode} expired during receipt validation`);
        if (stage === 'outer') assert.equal(f.store.getModelOuterFact(claim), null);
        if (stage === 'intent') assert.equal(f.store.getModelPromptIntent(claim), null);
      } finally { t.mock.restoreAll(); f.close(); }
    }
  }
});

test('real process-local tickets and SQLite require original-owner outer, intent, then send in order', () => {
  const f = fixture();
  const tickets = createClaudeModelOuterTickets();
  let bridgeStore: SqliteInvestigationStore | undefined;
  try {
    const { claim, fact } = ready(f);
    // Synthetic handle: ticket-to-store sequencing only, not native owner or model proof.
    const handle = { closed: new Promise<void>(() => {}) };
    const owner = tickets.beginOwner(claim, handle, f.now, fact.expectation.limits);
    bridgeStore = new SqliteInvestigationStore(f.file, {
      ...f.authority, verifyModelOuterReceipt: tickets.verifyOuter,
      verifyModelPromptWindowReceipt: tickets.verifyPromptWindow });
    try {
      assert.throws(() => owner.issuePrompt(fact, 'intent'));
      assert.throws(() => owner.issuePrompt(fact, 'send'));
      const outer = owner.issueFact(fact);
      bridgeStore.recordModelOuterFact(claim, f.binding, fact, outer, f.now);
      assert.deepEqual(bridgeStore.getModelOuterFact(claim), fact);
      assert.equal(tickets.verifyOuter(claim, claim.wslResource!, fact, outer), false);
      assert.throws(() => owner.issueFact(fact));
      const intent = owner.issuePrompt(fact, 'intent');
      assert.throws(() => bridgeStore!.assertModelPromptSendAuthority(claim, f.binding,
        f.launch, promptHash, f.now, intent), 'intent receipt cannot authorize send');
      bridgeStore.recordModelPromptIntent(claim, f.binding, f.launch, promptHash, f.now, intent);
      assert.equal(bridgeStore.getModelPromptIntent(claim)?.promptHash, promptHash);
      assert.equal(tickets.verifyPromptWindow(claim, fact, intent, 'intent'), false);
      assert.throws(() => owner.issuePrompt(fact, 'intent'));
      const send = owner.issuePrompt(fact, 'send');
      bridgeStore.assertModelPromptSendAuthority(claim, f.binding, f.launch, promptHash, f.now, send);
      assert.equal(tickets.verifyPromptWindow(claim, fact, send, 'send'), false);
      assert.throws(() => bridgeStore!.assertModelPromptSendAuthority(claim, f.binding,
        f.launch, promptHash, f.now, send), 'send receipt is one use');
      assert.throws(() => owner.issuePrompt(fact, 'send'));
    } finally { owner.close(); }
  } finally { bridgeStore?.close(); f.close(); }
});

test('synthetic owner close denies pending send; SQLite keeps intent but recovery cannot reuse owner', async () => {
  const f = fixture();
  const tickets = createClaudeModelOuterTickets();
  let bridgeStore: SqliteInvestigationStore | undefined;
  let reopened: SqliteInvestigationStore | undefined;
  try {
    const { claim, fact } = ready(f);
    let finish!: () => void;
    const handle = { closed: new Promise<void>(resolve => { finish = resolve; }) };
    const owner = tickets.beginOwner(claim, handle, f.now, fact.expectation.limits);
    bridgeStore = new SqliteInvestigationStore(f.file, {
      ...f.authority, verifyModelOuterReceipt: tickets.verifyOuter,
      verifyModelPromptWindowReceipt: tickets.verifyPromptWindow });
    const outer = owner.issueFact(fact);
    bridgeStore.recordModelOuterFact(claim, f.binding, fact, outer, f.now);
    const intent = owner.issuePrompt(fact, 'intent');
    bridgeStore.recordModelPromptIntent(claim, f.binding, f.launch, promptHash, f.now, intent);
    const pendingSend = owner.issuePrompt(fact, 'send');
    finish(); await Promise.resolve();
    assert.throws(() => bridgeStore!.assertModelPromptSendAuthority(claim, f.binding,
      f.launch, promptHash, f.now, pendingSend));
    assert.throws(() => owner.issuePrompt(fact, 'send'));
    assert.equal(bridgeStore.getModelPromptIntent(claim)?.promptHash, promptHash);
    bridgeStore.close(); bridgeStore = undefined;
    reopened = new SqliteInvestigationStore(f.file, {
      ...f.authority, verifyModelOuterReceipt: tickets.verifyOuter,
      verifyModelPromptWindowReceipt: tickets.verifyPromptWindow });
    const recovered = reopened.recoverAttempt(claim, { workerId: claim.workerId,
      isolationEvidence: 'synthetic', profileRevision, permissionEpoch: 0,
      now: new Date(f.now.getTime() + 31_000) });
    assert.deepEqual(reopened.getModelOuterFact(recovered), fact);
    assert.equal(reopened.getModelPromptIntent(recovered)?.promptHash, promptHash);
    assert.throws(() => tickets.beginOwner(recovered, { closed: Promise.resolve() },
      new Date(), fact.expectation.limits));
    assert.throws(() => reopened!.assertModelPromptSendAuthority(recovered, f.binding,
      f.launch, promptHash, new Date(f.now.getTime() + 31_000), pendingSend));
    assert.equal(tickets.verifyPromptWindow(claim, fact, pendingSend, 'send'), false);
    owner.close();
  } finally { reopened?.close(); bridgeStore?.close(); f.close(); }
});

function treeObservation(fact: ModelOuterConfinedFact): ClaudeModelTreeTerminalObservation {
  const running = fact.observation.candidate.running;
  const p = fact.observation.candidate.probe;
  const outer = p.processes.outer;
  const sample = {kind: 'outer_absent_v1' as const, bootId: p.bootId, uid: p.uid,
    observerPidNamespace: p.observerNamespaces.pid!, outerPid: outer.pid,
    outerStartTicks: outer.startTicks, outerPidNamespace: outer.namespaces.pid,
    processState: 'absent' as const, signal: 'none' as const};
  return {kind: 'model_tree_terminal_v1', outerBefore: sample, outerAfter: structuredClone(sample),
    unitTerminal: {kind: 'model_unit_terminal', resource: running.resource,
      journal: {...fact.observation.journalAfter, closed: true}, runningFact: running,
      native: {bootId: p.bootId, uid: p.uid, unitName: running.resource.unitName,
        invocationId: running.resource.invocationId!, controlGroup: '', loadState: 'loaded',
        activeState: 'failed', subState: 'failed', mainPid: 0,
        originalPid: running.journal.enterPid!, originalStartTicks: running.journal.enterStartTicks!,
        processState: 'absent', cgroupState: 'absent'}}};
}

test('consumed tree settlement requires a private proof and atomically releases the slot without a result', () => {
  const f = fixture(); const tickets = createClaudeModelTreeTickets();
  try {
    const {claim, fact} = ready(f);
    f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
    f.store.recordModelPromptIntent(claim, f.binding, f.launch, promptHash, f.now, windowReceipt);
    const now = new Date(f.now.getTime() + 31_000);
    const cleanup = f.store.acquireWslCleanupLease(claim, 'cleanup', now)!;
    const observation = treeObservation(fact);
    assert.throws(() => f.store.settleClaudeModelTreeTerminated(cleanup, observation, 'forged', now));
    assert.equal(f.store.listUnsettled().length, 1);
    f.authority.verifyClaudeModelTreeReceipt = tickets.verify;
    const receipt = tickets.issue(cleanup, fact, observation);
    const result = f.store.settleClaudeModelTreeTerminated(cleanup, observation, receipt, now);
    assert.equal(result.state, 'failed'); assert.equal(result.result, null);
    assert.equal(result.attempts[0]!.terminationConfirmed, true);
    assert.equal(f.store.listUnsettled().length, 0);
    const history = new DatabaseSync(f.file);
    try {
      assert.equal(history.prepare('SELECT prompt_hash FROM investigation_model_dispatch WHERE attempt_id=?')
        .get(claim.attemptId)!.prompt_hash, promptHash);
      const row = history.prepare('SELECT outer_json FROM investigation_model_running_facts WHERE attempt_id=?')
        .get(claim.attemptId)!;
      assert.deepEqual(JSON.parse(String(row.outer_json)), fact);
      assert.equal(history.prepare('SELECT COUNT(*) AS n FROM investigation_model_tree_facts').get()!.n, 1);
    } finally { history.close(); }
    f.closeStore();
    const reopened = new SqliteInvestigationStore(f.file, f.authority);
    try {
      assert.equal(reopened.get(claim.requestId)?.attempts[0]!.terminationConfirmed, true);
      assert.throws(() => reopened.settleClaudeModelTreeTerminated(cleanup, observation, receipt, now));
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('original started epoch can settle a proven tree without promoting a missing outcome', () => {
  const f = fixture(); const tickets = createClaudeModelOriginalCompletionTickets();
  try {
    const {claim, fact} = ready(f);
    f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
    f.store.recordModelPromptIntent(claim, f.binding, f.launch, promptHash, f.now, windowReceipt);
    const observation = treeObservation(fact);
    assert.throws(() => f.store.settleClaudeModelOriginalOutcome(claim, observation,
      'forged', null, f.now));
    assert.throws(() => f.store.settleClaudeModelOriginalOutcome(
      {...claim,workerEpoch:claim.workerEpoch+1},observation,'forged',null,f.now));
    assert.throws(() => f.store.settleClaudeModelOriginalOutcome(claim,
      {kind:'unconfirmed'},'forged',null,f.now));
    assert.equal(f.store.listUnsettled().length, 1);
    f.authority.verifyClaudeModelOriginalTreeReceipt = tickets.verifyTree;
    const receipt = tickets.issueTree(claim, fact, observation);
    const updated = f.store.settleClaudeModelOriginalOutcome(claim, observation, receipt,
      null, f.now);
    assert.equal(updated.state, 'failed');
    assert.equal(updated.result, null);
    assert.equal(updated.attempts[0]?.terminationConfirmed, true);
    assert.equal(f.store.listUnsettled().length, 0);
  } finally { f.close(); }
});

test('original tree proof releases cancelled or revoked attempts with null result', () => {
  for (const mode of ['cancel','revoke'] as const) {
    const f=fixture();const tickets=createClaudeModelOriginalCompletionTickets();
    try {
      const {claim,fact}=ready(f);
      f.store.recordModelOuterFact(claim,f.binding,fact,outerReceipt,f.now);
      f.store.recordModelPromptIntent(claim,f.binding,f.launch,promptHash,f.now,windowReceipt);
      if(mode==='cancel') f.store.requestCancel(f.store.get(claim.requestId)!,'cancel-original','request');
      else f.base.revokeGrant('request',f.now.toISOString());
      f.authority.verifyClaudeModelOriginalTreeReceipt=tickets.verifyTree;
      const observation=treeObservation(fact);
      const receipt=tickets.issueTree(claim,fact,observation);
      const outcome=f.store.settleClaudeModelOriginalOutcome(claim,observation,receipt,null,f.now);
      assert.equal(outcome.state,mode==='cancel'?'cancelled':'failed');
      assert.equal(outcome.result,null);
      if(mode==='revoke') assert.equal(outcome.failureReason,'authorization_changed');
      assert.equal(f.store.listUnsettled().length,0);
    } finally {f.close();}
  }
});

test('original heartbeat renews past initial lease within wall and fences stale owner', () => {
  const f=fixture();let heartbeat:ReturnType<typeof startClaudeModelOriginalLeaseHeartbeat>|undefined;
  try {
    const {claim,fact}=ready(f);
    f.store.recordModelOuterFact(claim,f.binding,fact,outerReceipt,f.now);
    f.store.recordModelPromptIntent(claim,f.binding,f.launch,promptHash,f.now,windowReceipt);
    let clock=f.now;
    heartbeat=startClaudeModelOriginalLeaseHeartbeat({claim,store:f.store,binding:f.binding,
      profileRevision,maxWallSeconds:60,commandDigest:f.launch.commandDigest,
      now:()=>clock,intervalMs:100000});
    clock=new Date(f.now.getTime()+25_000);
    assert.equal(heartbeat.tick(),true);
    clock=new Date(f.now.getTime()+31_000);
    assert.doesNotThrow(()=>f.store.preflightClaudeModelOriginalTermination(claim,clock));
    assert.doesNotThrow(()=>f.store.preflightClaudeModelOriginalTermination(claim,clock,17_000));
    clock=new Date(f.now.getTime()+56_000);
    assert.equal(heartbeat.tick(),false);
    assert.equal(heartbeat.signal.aborted,true);
    assert.throws(()=>heartbeat!.ensure());
    const cleanup=f.store.acquireWslCleanupLease(claim,'cleanup',clock);
    assert.equal(cleanup?.workerEpoch,claim.workerEpoch+1);
    assert.throws(()=>f.store.preflightClaudeModelOriginalTermination(claim,clock));
  } finally {heartbeat?.stop();f.close();}
});

test('original result publish rechecks current worker grant and nulls revoked result', async () => {
  for(const mode of ['valid','worker-revoked'] as const) {
  const f = fixture(); const tickets = createClaudeModelOriginalCompletionTickets();
  try {
    const {claim, fact} = ready(f);
    f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
    f.store.recordModelPromptIntent(claim, f.binding, f.launch, promptHash, f.now, windowReceipt);
    const read = {workspaceId: claim.workspaceId, collaborationId: f.binding.collaborationId,
      workingCopyId: f.binding.workingCopyId, snapshotId: f.binding.snapshotId, path:'src/a.ts'};
    const page = readSnapshot(f.snapshot, {principal: claim.workerId, scopePaths:['src/a.ts']},
      {path:'src/a.ts'});
    const reservation = f.store.reserveRunningRead(claim, f.binding, read, f.now);
    const receiptId = await reservation.complete({...page, decoding:'utf-8'});
    const result = parseInvestigationResult(JSON.stringify({kind:'investigation_result_v1',
      requestId:claim.requestId, attemptId:claim.attemptId, resultState:'completed',
      snapshotRef:f.snapshot.id, contextRevisionId:'ctx-outer',
      findings:[{statement:'The file contains source.',classification:'source_confirmed',
        evidenceRefs:[receiptId]}], evidence:[{path:'src/a.ts',symbol:null,
        lineRange:[1,1], byteRange:[0,page.byteRange.end],contentHash:page.contentHash,
        excerpt:page.content,toolReceipt:receiptId}],
      coverage:{searchedScope:['src/a.ts'],excludedCategories:[],truncated:false,
        missingDependencies:[]},openQuestions:[],limitsAndWarnings:[]}));
    const receipts = f.store.getSucceededReadReceipts(claim);
    validateInvestigationResultEvidence(result, receipts, f.snapshot, {
      requestId:claim.requestId,attemptId:claim.attemptId,workspaceId:claim.workspaceId,
      collaborationId:f.binding.collaborationId,workingCopyId:f.binding.workingCopyId,
      snapshotId:f.snapshot.id,contextRevisionId:'ctx-outer',launchEpoch:claim.workerEpoch,
      nativeRef:claim.nativeRef!,workerPrincipal:claim.workerId,
      workerAudience:f.binding.workerAudience,workerRecipient:f.binding.workerRecipient,
      workerGrantId:f.binding.workerGrantId});
    const candidate = {kind:'claude_model_original_owner_candidate_v1' as const,
      requestId:claim.requestId,attemptId:claim.attemptId,workspaceId:claim.workspaceId,
      workerEpoch:claim.workerEpoch,nativeRef:claim.nativeRef!,promptHash,
      commandDigest:f.launch.commandDigest,formatContract:'claude_print_json_sdk_0_3_284' as const,
      result:JSON.stringify({kind:'investigation_result_v1',...result}),
      numTurns:1,rawBytesSha256:'a'.repeat(64)};
    const verified = {candidate,result,verifiedAt:f.now.toISOString(),
      evidenceReceiptIds:[receiptId]};
    const intent = f.store.getModelPromptIntent(claim)!;
    f.authority.verifyClaudeModelOriginalTreeReceipt = tickets.verifyTree;
    f.authority.verifyClaudeModelOriginalOutcomeReceipt = tickets.verifyOutcome;
    const observation = treeObservation(fact);
    const treeReceipt = tickets.issueTree(claim,fact,observation);
    assert.throws(()=>tickets.issueOutcome(claim,fact,intent,{...verified,
      candidate:{...candidate,result:JSON.stringify({kind:'investigation_result_v1',
        ...result,openQuestions:['tampered']})}}));
    const outcomeReceipt = tickets.issueOutcome(claim,fact,intent,verified);
    if(mode==='worker-revoked') f.base.revokeGrant('worker-read',f.now.toISOString());
    const published = f.store.settleClaudeModelOriginalOutcome(claim,observation,
      treeReceipt,{...verified,receipt:outcomeReceipt},f.now);
    assert.equal(published.state,mode==='valid'?'completed':'failed');
    if(mode==='valid') {
      assert.equal(published.result?.evidence[0] &&
        Object.hasOwn(published.result.evidence[0],'byteRange'),false);
      const check=new DatabaseSync(f.file);
      try {
        const row=check.prepare(`SELECT provenance_json FROM investigation_model_outcome_provenance
          WHERE attempt_id=?`).get(claim.attemptId) as {provenance_json:string};
        const provenance=JSON.parse(row.provenance_json);
        assert.deepEqual(provenance.evidence[0].byteRange,[0,page.byteRange.end]);
        assert.equal(provenance.rawBytesSha256,candidate.rawBytesSha256);
      } finally {check.close();}
    } else assert.equal(published.result,null);
    if(mode==='worker-revoked') assert.equal(published.failureReason,'authorization_changed');
    assert.equal(f.store.listUnsettled().length,0);
  } finally {f.close();}
  }
});

test('offline synthetic native owner completes through real SQLite, dispatch and scoped MCP read in direct and app composition', async () => {
  for(const composition of [false,true]) {
  const f = fixture({bom:true,exclusions:true,composition}); const runningTickets = createClaudeModelRunningTickets();
  const outerTickets = createClaudeModelOuterTickets();
  const completionTickets = createClaudeModelOriginalCompletionTickets();
  let client: Client | undefined;
  let server: ReturnType<typeof createPersistedInvestigatorMcpServer> | undefined;
  let app: ReturnType<typeof openApplication> | undefined;
  try {
    await f.base.saveSnapshot({workspaceId:f.claim.workspaceId,collaborationId:'col-outer',
      workingCopyId:'wc-outer',snapshot:f.snapshot.toPersisted()},
    {workspaceId:f.claim.workspaceId,collaborationId:'col-outer',workingCopyId:'wc-outer',
      commitRef:'synthetic-commit'},'capture','owner','local_cli');
    f.authority.verifyNativeReceipt = runningTickets.verifyNativeStart;
    f.authority.verifyModelRunningObservationReceipt = runningTickets.verifyRunningObservation;
    f.authority.verifyModelOuterReceipt = outerTickets.verifyOuter;
    f.authority.verifyModelPromptWindowReceipt = outerTickets.verifyPromptWindow;
    f.authority.verifyClaudeModelOriginalTreeReceipt = completionTickets.verifyTree;
    f.authority.verifyClaudeModelOriginalOutcomeReceipt = completionTickets.verifyOutcome;
    const claim = f.store.reserveWslResource(f.claim,f.reservation,f.now);
    const descriptor = {...sample.descriptor,attemptId:claim.attemptId,
      workspaceId:claim.workspaceId,launchWorkerEpoch:claim.workerEpoch,
      commandDigest:f.launch.commandDigest};
    const repository = new RepositoryApplication({
      authorize:async ({context,operation,workspaceId,collaborationId}) => {
        await context.assertFreshAuthority?.();
        return authorize({...context,now:new Date()},operation,{workspaceId,collaborationId},
          f.base.grantsFor(context.principal,context.audience));
      },
      getWorkingCopy:(ws,wc)=>f.base.getWorkingCopy(ws,wc),
      collaborationBelongsToWorkspace:(ws,col)=>f.base.collaborationBelongsToWorkspace(ws,col),
      lookupCapture:(input,key,principal,audience)=>f.base.lookupCapture(input,key,principal,audience),
      saveSnapshot:(record,input,key,principal,audience)=>f.base.saveSnapshot(record,input,key,principal,audience),
      getSnapshot:(id,ws,col)=>f.base.getSnapshot(id,ws,col),
    });
    const dispatcher = new DispatchService(f.base,undefined,undefined,{repository});
    let resolveClosed!: (value: {bridgeExitCode:number;stdout:Buffer;stderrBytes:number;uncertain:false})=>void;
    let resolveReady!: (value: unknown)=>void;
    const handle = {closed:new Promise(resolve=>{resolveClosed=resolve;}),
      ready:new Promise(resolve=>{resolveReady=resolve;}),
      writePrompt:async (bytes:Buffer) => {
        assert.match(bytes.toString('utf8'),/"excludedCategories":\["untracked"\]/);
        assert.match(bytes.toString('utf8'),new RegExp(claim.attemptId));
        assert.match(bytes.toString('utf8'),/investigation_result_v1/);
        const response = await client!.callTool({name:'repo.read',arguments:{
          scope:{workspaceId:claim.workspaceId,collaborationId:'col-outer'},
          payload:{workingCopyId:'wc-outer',snapshotId:f.snapshot.id,path:'src/a.ts'}}});
        assert.equal(response.isError,undefined);
        const page = JSON.parse((response.content[0] as {text:string}).text);
        assert.match(page.toolReceipt,/^[0-9a-f-]{36}$/);
        assert.ok(page.content.startsWith('\uFEFF'));
        const result = {kind:'investigation_result_v1',requestId:claim.requestId,
          attemptId:claim.attemptId,resultState:'completed',snapshotRef:f.snapshot.id,
          contextRevisionId:'ctx-outer',findings:[{statement:'Synthetic file content',
            classification:'source_confirmed',evidenceRefs:[page.toolReceipt]}],
          evidence:[{path:'src/a.ts',symbol:null,lineRange:[1,1],
            byteRange:[0,page.byteRange.end],contentHash:page.contentHash,
            excerpt:page.content,toolReceipt:page.toolReceipt}],
          coverage:{searchedScope:['src/a.ts'],excludedCategories:['untracked'],truncated:false,
            missingDependencies:[]},openQuestions:[],limitsAndWarnings:[]};
        resolveClosed({bridgeExitCode:0,stdout:Buffer.from(JSON.stringify({type:'result',
          subtype:'success',is_error:false,num_turns:1,result:JSON.stringify(result)})),
          stderrBytes:0,uncertain:false});
      },
      closeBridge:async()=>({bridgeExitCode:null,stdout:null,stderrBytes:0,uncertain:true})};
    let current: InvestigationClaim | undefined;
    let fact: ModelOuterConfinedFact | undefined;
    const entered = {...sample.running.journal,attemptId:claim.attemptId,
      workspaceId:claim.workspaceId,launchWorkerEpoch:claim.workerEpoch,
      commandDigest:f.launch.commandDigest};
    const ports = {
      prepare:async()=>({directory:f.paths.privateFifoDirectory}),
      operation:async (operation:string) => operation==='prepare' ?
        {...entered,phase:'prepared',invocationId:undefined,controlGroup:undefined,
          enterPid:undefined,enterStartTicks:undefined} :
        operation==='release' ? {...entered,phase:'released'} :
        operation==='close' ? {...fact!.observation.journalAfter,closed:true} : entered,
      start:()=>handle,
      persist:async (input:Parameters<typeof persistClaudeModelRunning>[0]) => {
        current = await persistClaudeModelRunning(input,async (resource,journal) =>
          ({...sample.running,resource,journal,native:{...sample.running.native,
            bootId:resource.bootId,uid:resource.uid,unitName:resource.unitName,
            invocationId:resource.invocationId!,controlGroup:resource.controlGroup!,
            mainPid:journal.enterPid!,startTicks:journal.enterStartTicks!,
            procControlGroup:resource.controlGroup!}}));
        fact = rebound(f,current);
        resolveReady(fact.observation.candidate.startup);
        return current;
      },
      attach:async (attached: {claim:InvestigationClaim;store:SqliteInvestigationStore;
        dispatcher:DispatchService}) => {
        server=createPersistedInvestigatorMcpServer({claim:current!,store:attached.store,
          workerGrantId:'worker-read',workerAudience:'investigator',workerRecipient:'local',
          dispatcher:attached.dispatcher});
        client=new Client({name:'synthetic-model',version:'1'});
        const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);await client.connect(clientTransport);
        return {closed:new Promise<void>(()=>{}),closeTransport:async()=>{
          await client!.close();await server!.close();}};
      },
      observe:async()=>fact!.observation,
    };
    const contextRevision = {kind:'revision' as const,id:'ctx-outer',
      workspaceId:claim.workspaceId,collaborationId:'col-outer',snapshotId:f.snapshot.id,
      parentRevisionId:null,sourceProposalId:'proposal',sourceRefs:['synthetic'],
      acceptedBy:'owner',content:{goal:'Inspect synthetic source',constraints:[],
        acceptedDecisions:[],rejectedDecisions:[],currentQuestions:[],evidenceRefs:[],
        expectedDeliverables:[],unknowns:[],recentChanges:[]}};
    if(composition) {
      const contextDb=new ContextDecisionSqlite(f.file);contextDb.close();
      const db=new DatabaseSync(f.file);
      try {db.prepare(`INSERT INTO context_revisions(id,workspace_id,collaboration_id,revision_json)
        VALUES (?,?,?,?)`).run(contextRevision.id,claim.workspaceId,'col-outer',
          JSON.stringify(contextRevision));} finally {db.close();}
      app=openApplication(f.dir);
      await app.ready;
    }
    const testPorts={owner:ports as never,observeTree:async (existing:ModelOuterConfinedFact)=>
      treeObservation(existing)};
    const outcome = composition ? await app!.runModelInvestigation({claim,binding:f.binding,
      descriptor,paths:f.paths,profile:sample.profile,profileRevision,
      limits:{maxWallSeconds:60,maxTurns:2}},testPorts) :
      await runClaudeModelInvestigation({claim,store:f.store,binding:f.binding,
        descriptor,paths:f.paths,profile:sample.profile,profileRevision,
        limits:{maxWallSeconds:60,maxTurns:2},runningTickets,outerTickets,dispatcher,
        contextRevision,getSnapshot:(id,ws,col)=>f.base.getSnapshot(id,ws,col),
        completionTickets},testPorts);
    assert.equal(outcome?.state,'completed');
    assert.equal(outcome?.result?.evidence.length,1);
    assert.equal(Object.hasOwn(outcome!.result!.evidence[0]!,'byteRange'),false);
    assert.equal(f.store.listUnsettled().length,0);
    assert.equal(f.store.get(claim.requestId)?.state,'completed');
  } finally {await client?.close();await server?.close();await app?.close();f.close();}
  }
});

test('oversize prompt records recoverable rejection before any native port, persisting across reopen', async () => {
  const f=fixture({question:'"'.repeat(9000)});
  let reopened:SqliteInvestigationStore|undefined;
  try {
    await f.base.saveSnapshot({workspaceId:f.claim.workspaceId,collaborationId:'col-outer',
      workingCopyId:'wc-outer',snapshot:f.snapshot.toPersisted()},
    {workspaceId:f.claim.workspaceId,collaborationId:'col-outer',workingCopyId:'wc-outer',
      commitRef:'synthetic-commit'},'capture','owner','local_cli');
    const claim=f.store.reserveWslResource(f.claim,f.reservation,f.now);
    const descriptor={...sample.descriptor,attemptId:claim.attemptId,workspaceId:claim.workspaceId,
      launchWorkerEpoch:claim.workerEpoch,commandDigest:f.launch.commandDigest};
    const contextRevision={kind:'revision' as const,id:'ctx-outer',workspaceId:claim.workspaceId,
      collaborationId:'col-outer',snapshotId:f.snapshot.id,parentRevisionId:null,
      sourceProposalId:'p',sourceRefs:['s'],acceptedBy:'owner',
      content:{goal:'read',constraints:[],acceptedDecisions:[],rejectedDecisions:[],
        currentQuestions:[],evidenceRefs:[],expectedDeliverables:[],unknowns:[],recentChanges:[]}};
    let nativeCalls=0;
    const ports={prepare:async()=>{nativeCalls++;throw new Error('unexpected');},
      operation:async()=>{nativeCalls++;throw new Error('unexpected');},
      start:()=>{nativeCalls++;throw new Error('unexpected');},
      persist:async()=>{nativeCalls++;throw new Error('unexpected');},
      attach:async()=>{nativeCalls++;throw new Error('unexpected');},
      observe:async()=>{nativeCalls++;throw new Error('unexpected');}};
    await assert.rejects(runClaudeModelInvestigation({claim,store:f.store,binding:f.binding,
      descriptor,paths:f.paths,profile:sample.profile,profileRevision,
      limits:{maxWallSeconds:60,maxTurns:2},runningTickets:createClaudeModelRunningTickets(),
      outerTickets:createClaudeModelOuterTickets(),dispatcher:{dispatch:async()=>null} as never,
      contextRevision,getSnapshot:(id,ws,col)=>f.base.getSnapshot(id,ws,col),
      completionTickets:createClaudeModelOriginalCompletionTickets()},
    {owner:ports as never}), (error:unknown)=>error instanceof ClaudeModelPromptLimitExceeded &&
      error.actualBytes>16384 && error.maxBytes===16384);
    assert.equal(nativeCalls,0);
    assert.equal(f.store.get(claim.requestId)?.failureReason,'model_prompt_limit_exceeded');
    assert.equal(f.store.listUnsettled().length,1);
    f.closeStore(); reopened=new SqliteInvestigationStore(f.file);
    assert.equal(reopened.get(claim.requestId)?.state,'recovery_required');
    assert.equal(reopened.get(claim.requestId)?.failureReason,'model_prompt_limit_exceeded');
    assert.equal(reopened.listUnsettled()[0]?.phase,'unknown');
  } finally {reopened?.close();f.close();}
});

test('tree settlement cannot upgrade a missing outer fact or survive receipt-callback lease expiry', () => {
  const f = fixture(); const tickets = createClaudeModelTreeTickets();
  try {
    const {claim, fact} = ready(f);
    const now = new Date(f.now.getTime() + 31_000);
    const cleanup = f.store.acquireWslCleanupLease(claim, 'cleanup', now)!;
    const observation = treeObservation(fact);
    f.authority.verifyClaudeModelTreeReceipt = tickets.verify;
    assert.throws(() => f.store.settleClaudeModelTreeTerminated(cleanup, observation,
      tickets.issue(cleanup, fact, observation), now));
    assert.equal(f.store.listUnsettled().length, 1);
  } finally { f.close(); }
  const g = fixture();
  try {
    const {claim, fact} = ready(g);
    g.store.recordModelOuterFact(claim, g.binding, fact, outerReceipt, g.now);
    const cleanupAt = new Date(g.now.getTime() + 31_000);
    const cleanup = g.store.acquireWslCleanupLease(claim, 'cleanup', cleanupAt)!;
    const observation = treeObservation(fact);
    g.authority.verifyClaudeModelTreeReceipt = (...args) => {
      const end = performance.now() + 50;
      while (performance.now() < end) { /* Deliberately consume remaining lease time. */ }
      return tickets.verify(...args);
    };
    const receipt = tickets.issue(cleanup, fact, observation);
    assert.throws(() => g.store.settleClaudeModelTreeTerminated(cleanup, observation, receipt,
      new Date(cleanupAt.getTime() + 120_000 - 20)));
    assert.equal(g.store.listUnsettled().length, 1);
    assert.equal(g.store.get(claim.requestId)?.attempts[0]!.terminationConfirmed, false);
    const db = new DatabaseSync(g.file);
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM investigation_model_tree_facts').get()!.n, 0); }
    finally { db.close(); }
  } finally { g.close(); }
});
