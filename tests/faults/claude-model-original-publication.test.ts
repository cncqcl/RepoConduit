import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteInvestigationStore, type InvestigationClaim,
  type InvestigationClaimAuthority } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { buildClaudeModelSealedLaunch } from
  '../../src/adapters/secondary-investigator/claude-model-sealed-launch.js';
import { historicalClaudeModelRecipe, historicalClaudeModelParentArgv } from
  '../../src/adapters/secondary-investigator/claude-model-historical.js';
import { CLAUDE_MODEL_BOOTSTRAP_PYTHON, CLAUDE_MODEL_BOOTSTRAP_SHA256 } from
  '../../src/adapters/secondary-investigator/claude-model-bootstrap.js';
import { claudeModelSupervisorSpec } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor.js';
import { validateClaudeModelOuterFact, type ModelOuterConfinedFact } from
  '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';
import { createClaudeModelOriginalCompletionTickets } from '../../src/runtime/claude-model-tree-tickets.js';
import type { ClaudeModelTreeTerminalObservation } from
  '../../src/adapters/secondary-investigator/claude-model-tree-terminal.js';
import { readSnapshot } from '../../src/adapters/repository/queries.js';
import { parseInvestigationResult } from '../../src/core/investigation/result.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

// Frozen native bytes are rebound only as an offline synthetic input. No model,
// process termination, live isolation, or human takeover occurs in these tests.
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
  const fixtureParent = realpathSync.native(
    options.composition&&process.platform==='win32'?homedir():tmpdir());
  const dir = mkdtempSync(join(fixtureParent, 'rcac-model-outer-db-'));
  const fixtureRealDir = realpathSync.native(dir);
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
      if (!closed) store.close();
      base.close();
      const currentRealDir = realpathSync.native(dir);
      if (resolve(dirname(dir)) !== resolve(fixtureParent) ||
        resolve(dirname(currentRealDir)) !== resolve(fixtureParent) ||
        resolve(currentRealDir) !== resolve(fixtureRealDir) ||
        !basename(dir).startsWith('rcac-model-outer-db-') ||
        !basename(currentRealDir).startsWith('rcac-model-outer-db-'))
        throw new Error('Unsafe fixture cleanup target');
      rmSync(currentRealDir, { recursive: true, force: true });
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

async function preparedOutcome(f: ReturnType<typeof fixture>) {
  const {claim, fact} = ready(f);
  f.store.recordModelOuterFact(claim, f.binding, fact, outerReceipt, f.now);
  f.store.recordModelPromptIntent(claim, f.binding, f.launch, promptHash, f.now, windowReceipt);
  const page = readSnapshot(f.snapshot, {principal: claim.workerId, scopePaths:['src/a.ts']},
    {path:'src/a.ts'});
  const read = {workspaceId: claim.workspaceId, collaborationId: f.binding.collaborationId,
    workingCopyId: f.binding.workingCopyId, snapshotId: f.binding.snapshotId, path:'src/a.ts'};
  const receiptId = await f.store.reserveRunningRead(claim, f.binding, read, f.now)
    .complete({...page, decoding:'utf-8'});
  const result = parseInvestigationResult(JSON.stringify({kind:'investigation_result_v1',
    requestId:claim.requestId, attemptId:claim.attemptId, resultState:'completed',
    snapshotRef:f.snapshot.id, contextRevisionId:'ctx-outer',
    findings:[{statement:'Synthetic source observed',classification:'source_confirmed',
      evidenceRefs:[receiptId]}], evidence:[{path:'src/a.ts',symbol:null,
      lineRange:[1,1],byteRange:[0,page.byteRange.end],contentHash:page.contentHash,
      excerpt:page.content,toolReceipt:receiptId}],
    coverage:{searchedScope:['src/a.ts'],excludedCategories:[],truncated:false,
      missingDependencies:[]},openQuestions:[],limitsAndWarnings:[]}));
  const candidate = {kind:'claude_model_original_owner_candidate_v1' as const,
    requestId:claim.requestId,attemptId:claim.attemptId,workspaceId:claim.workspaceId,
    workerEpoch:claim.workerEpoch,nativeRef:claim.nativeRef!,promptHash,
    commandDigest:f.launch.commandDigest,formatContract:'claude_print_json_sdk_0_3_284' as const,
    result:JSON.stringify({kind:'investigation_result_v1',...result}),
    numTurns:1,rawBytesSha256:'a'.repeat(64)};
  const verified = {candidate,result,verifiedAt:f.now.toISOString(),evidenceReceiptIds:[receiptId]};
  const tickets = createClaudeModelOriginalCompletionTickets();
  f.authority.verifyClaudeModelOriginalTreeReceipt = tickets.verifyTree;
  f.authority.verifyClaudeModelOriginalOutcomeReceipt = tickets.verifyOutcome;
  const observation = treeObservation(fact);
  const treeReceipt = tickets.issueTree(claim,fact,observation);
  const outcomeReceipt = tickets.issueOutcome(claim,fact,f.store.getModelPromptIntent(claim)!,verified);
  return {claim,observation,treeReceipt,verified:{...verified,receipt:outcomeReceipt}};
}

function publicationRows(file: string, requestId: string) {
  const db = new DatabaseSync(file);
  try {
    const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}
      WHERE request_id=?`).get(requestId) as {n:number}).n);
    return {tree:count('investigation_model_tree_facts'),
      provenance:count('investigation_model_outcome_provenance'),
      slot:count('investigation_active_attempts'),outbox:count('investigation_outbox')};
  } finally { db.close(); }
}

function injectSqliteFault(file: string, stage: 'provenance'|'request'|'outbox'|'slot'|'after-slot') {
  const statement = {
    provenance:'BEFORE INSERT ON investigation_model_outcome_provenance',
    request:'BEFORE UPDATE ON investigation_requests',
    outbox:'BEFORE DELETE ON investigation_outbox',
    slot:'BEFORE DELETE ON investigation_active_attempts',
    'after-slot':'AFTER DELETE ON investigation_active_attempts',
  }[stage];
  const db = new DatabaseSync(file);
  try { db.exec(`CREATE TRIGGER inject_original_publication_failure ${statement}
    BEGIN SELECT RAISE(ABORT, 'injected original publication failure'); END`); }
  finally { db.close(); }
}

function removeSqliteFault(file: string) {
  const db = new DatabaseSync(file);
  try { db.exec('DROP TRIGGER inject_original_publication_failure'); }
  finally { db.close(); }
}

test('original outcome commits tree, provenance, result and slot/outbox removal together', async () => {
  const f = fixture();
  try {
    const {claim,observation,treeReceipt,verified} = await preparedOutcome(f);
    assert.deepEqual(publicationRows(f.file,claim.requestId),
      {tree:0,provenance:0,slot:1,outbox:1});
    const result = f.store.settleClaudeModelOriginalOutcome(
      claim,observation,treeReceipt,verified,f.now);
    assert.equal(result.state,'completed');
    assert.equal(result.result?.evidence.length,1);
    assert.equal(result.attempts[0]?.terminationConfirmed,true);
    assert.deepEqual(publicationRows(f.file,claim.requestId),
      {tree:1,provenance:1,slot:0,outbox:0});
    f.closeStore();
    const reopened = new SqliteInvestigationStore(f.file,f.authority);
    try {
      assert.equal(reopened.get(claim.requestId)?.state,'completed');
      assert.equal(reopened.get(claim.requestId)?.result?.evidence.length,1);
      assert.deepEqual(publicationRows(f.file,claim.requestId),
        {tree:1,provenance:1,slot:0,outbox:0});
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('injected SQLite faults roll back every original-publication write and retain recovery slot', async t => {
  for (const stage of ['provenance','request','outbox','slot','after-slot'] as const) {
    await t.test(stage, async () => {
      const f = fixture();
      try {
        const {claim,observation,treeReceipt,verified} = await preparedOutcome(f);
        injectSqliteFault(f.file,stage);
        try {
          assert.throws(() => f.store.settleClaudeModelOriginalOutcome(
            claim,observation,treeReceipt,verified,f.now),/injected original publication failure/);
        } finally { removeSqliteFault(f.file); }
        assert.deepEqual(publicationRows(f.file,claim.requestId),
          {tree:0,provenance:0,slot:1,outbox:1});
        assert.equal(f.store.get(claim.requestId)?.result,null);
        assert.equal(f.store.get(claim.requestId)?.attempts[0]?.terminationConfirmed,false);
        f.closeStore();
        const reopened = new SqliteInvestigationStore(f.file,f.authority);
        try {
          assert.deepEqual(publicationRows(f.file,claim.requestId),
            {tree:0,provenance:0,slot:1,outbox:1});
          assert.equal(reopened.get(claim.requestId)?.result,null);
          reopened.markRecoveryRequired(claim,f.now);
          assert.equal(reopened.get(claim.requestId)?.state,'recovery_required');
          assert.equal(reopened.get(claim.requestId)?.attempts[0]?.terminationConfirmed,false);
          assert.equal(reopened.listUnsettled().length,1);
          assert.deepEqual(publicationRows(f.file,claim.requestId),
            {tree:0,provenance:0,slot:1,outbox:1});
        } finally { reopened.close(); }
      } finally { f.close(); }
    });
  }
});

test('late old epoch cannot publish a result after cleanup takeover', async () => {
  const f = fixture();
  try {
    const {claim,observation,treeReceipt,verified} = await preparedOutcome(f);
    const cleanupAt = new Date(f.now.getTime()+31_000);
    const cleanup = f.store.acquireWslCleanupLease(claim,'cleanup',cleanupAt);
    assert.equal(cleanup?.workerEpoch,claim.workerEpoch+1);
    assert.throws(() => f.store.settleClaudeModelOriginalOutcome(
      claim,observation,treeReceipt,verified,cleanupAt));
    assert.equal(f.store.get(claim.requestId)?.state,'recovery_required');
    assert.equal(f.store.get(claim.requestId)?.result,null);
    assert.deepEqual(publicationRows(f.file,claim.requestId),
      {tree:0,provenance:0,slot:1,outbox:1});
  } finally { f.close(); }
});

test('cancel and revoked grants cannot turn an outcome into success', async t => {
  for (const mode of ['cancel','request-revoked','worker-revoked'] as const) {
    await t.test(mode, async () => {
      const f = fixture();
      try {
        const {claim,observation,treeReceipt,verified} = await preparedOutcome(f);
        if(mode==='cancel')
          f.store.requestCancel(f.store.get(claim.requestId)!,'cancel-original','request');
        if(mode==='request-revoked') f.base.revokeGrant('request',f.now.toISOString());
        if(mode==='worker-revoked') f.base.revokeGrant('worker-read',f.now.toISOString());
        const settled = f.store.settleClaudeModelOriginalOutcome(
          claim,observation,treeReceipt,verified,f.now);
        assert.equal(settled.state,mode==='cancel'?'cancelled':'failed');
        assert.equal(settled.result,null);
        assert.equal(settled.attempts[0]?.terminationConfirmed,true);
        assert.deepEqual(publicationRows(f.file,claim.requestId),
          {tree:1,provenance:0,slot:0,outbox:0});
        f.closeStore();
        const reopened = new SqliteInvestigationStore(f.file,f.authority);
        try {
          assert.equal(reopened.get(claim.requestId)?.result,null);
          assert.equal(reopened.get(claim.requestId)?.state,settled.state);
          assert.deepEqual(publicationRows(f.file,claim.requestId),
            {tree:1,provenance:0,slot:0,outbox:0});
        } finally { reopened.close(); }
      } finally { f.close(); }
    });
  }
});

