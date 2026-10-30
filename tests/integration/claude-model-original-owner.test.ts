import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { RepositoryApplication } from '../../src/application/repository.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { authorize } from '../../src/core/policy/authorize.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { buildClaudeModelSealedLaunch } from
  '../../src/adapters/secondary-investigator/claude-model-sealed-launch.js';
import { runClaudeModelSupervisorOperation, startClaudeModelUnit } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor-runner.js';
import { observeClaudeModelOuter } from
  '../../src/adapters/secondary-investigator/claude-model-outer-observer.js';
import type { ModelOuterConfinedFact } from
  '../../src/adapters/secondary-investigator/claude-model-outer-fact.js';
import { createClaudeModelRunningTickets } from '../../src/runtime/claude-model-running-tickets.js';
import { createClaudeModelOuterTickets } from '../../src/runtime/claude-model-outer-tickets.js';
import { persistClaudeModelRunning } from '../../src/runtime/claude-model-start-observation.js';
import { preparePrivateFifo, attachPrivateFifo } from '../../src/runtime/investigation-private-fifo.js';
import { ClaudeModelOriginalOwnerError, runClaudeModelOriginalOwner,
  type ClaudeModelOriginalOwnerPorts } from
  '../../src/runtime/claude-model-original-owner.js';

const wsl = 'C:\\Windows\\System32\\wsl.exe';
const distro = 'Ubuntu-22.04';
const linuxUser = 'investigator';
const installRoot = '/home/investigator/.local/share/rcac-second-runtime-20260929';
const nodeRoot = '/home/investigator/.hermes/node';
const profile = { allowedDomains: [] as string[] };
const limits = { maxWallSeconds: 60, maxTurns: 2 };
const profileRevision = 'synthetic-empty-auth';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hashBytes = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function runWsl(args: string[], timeout = 8000): string {
  return execFileSync(wsl, ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec', ...args],
    { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

const inspectUnit = String.raw`import json,os,subprocess,sys
unit,group,identities,expected_boot=sys.argv[1:5]
actual_boot=open('/proc/sys/kernel/random/boot_id',encoding='ascii').read().strip()
result=subprocess.run(['/usr/bin/systemctl','--user','show','--no-pager',
 '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup',unit],
 capture_output=True,timeout=3)
fields=dict(row.split('=',1) for row in result.stdout.decode().splitlines() if '=' in row)
pids=[]
for item in json.loads(identities):
 pid,ticks=item['pid'],item['ticks']
 try:
  with open('/proc/%d/stat'%pid,encoding='ascii') as stream: raw=stream.read()
  current=int(raw[raw.rfind(')')+2:].split()[19])
  pids.append(dict(pid=pid,sameTicks=current==ticks))
 except FileNotFoundError: pids.append(dict(pid=pid,sameTicks=False))
path='/sys/fs/cgroup'+group
exists=os.path.exists(path)
populated=None
if exists:
 with open(path+'/cgroup.events',encoding='ascii') as stream:
  populated=dict(row.split(' ',1) for row in stream.read().splitlines()).get('populated')
print(json.dumps(dict(showExit=result.returncode,mainPid=fields.get('MainPID'),
 controlGroup=fields.get('ControlGroup'),cgroupExists=exists,
 cgroupPopulated=populated,pids=pids,bootId=actual_boot,
 bootMatches=actual_boot==expected_boot,unit=fields)))
`;

test('original WSL owner persists outer fact with real SQLite and private FIFO, then closes without prompt',
  { timeout: 90000 }, async t => {
    if (process.platform !== 'win32') { t.skip('Windows WSL fixture unavailable'); return; }
    if (process.env.RCAC_RUN_MODEL_OUTER_OWNER_TEST !== '1') {
      t.skip('real WSL fixture requires RCAC_RUN_MODEL_OUTER_OWNER_TEST=1'); return;
    }
    const runId = randomUUID();
    const evidenceDir = join(process.cwd(), '.local', 'qualification');
    const evidencePath = join(evidenceDir, `MODEL_ORIGINAL_OWNER_${runId}.json`);
    const controller = new AbortController();
    // Leave time below node:test 90 s for exact-unit stop, terminal inspection and evidence.
    const watchdog = setTimeout(() => controller.abort(), 50000);
    mkdirSync(evidenceDir, { recursive: true });
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'],
      { encoding: 'utf8', timeout: 2000 }).trim();
    const gitStatusShort = execFileSync('git', ['status', '--short', '--untracked-files=normal'],
      { encoding: 'utf8', timeout: 2000 });
    const evidence: Record<string, unknown> = { schema: 'model_original_owner_test_v1',
      runId, sourceCommit, gitStatusShort, stage: 'host_preflight', result: 'started',
      runtime: { distro, linuxUser, installRoot, nodeRoot, profileRevision,
        maxWallSeconds: limits.maxWallSeconds, auth: 'new_empty_0700',
        isolationReceipt: 'synthetic_only', dataDisclosure: 'synthetic_snapshot_only',
        modelAccount: 'not_used', modelPrompt: 'never_called' } };
    const writeEvidence = () => {
      const body = JSON.stringify(evidence, null, 2) + '\n';
      writeFileSync(evidencePath, body);
      return hashBytes(readFileSync(evidencePath));
    };
    writeEvidence();
    let host: { uid: number; boot: string; runtimeReady: boolean };
    try {
      const output = runWsl(['/usr/bin/python3', '-I', '-S', '-c',
        `import json,os
print(json.dumps(dict(uid=os.getuid(),boot=open('/proc/sys/kernel/random/boot_id').read().strip(),
 runtimeReady=all(os.path.isdir(p) for p in ${JSON.stringify(
          [`${installRoot}/node_modules`, `${installRoot}/deps`, nodeRoot])}))))`]);
      host = JSON.parse(output.slice(output.lastIndexOf('{')).trim()) as typeof host;
    } catch {
      evidence.result = 'skipped'; evidence.stage = 'host_preflight';
      evidence.skipReason = 'private_wsl_user_or_runtime_unavailable';
      writeEvidence(); clearTimeout(watchdog);
      t.skip('private WSL user or runtime unavailable'); return;
    }
    if (!host.runtimeReady) {
      evidence.result = 'skipped'; evidence.stage = 'host_preflight';
      evidence.skipReason = 'installed_private_runtime_paths_unavailable';
      writeEvidence(); clearTimeout(watchdog);
      t.skip('installed private runtime paths unavailable'); return;
    }

    const dir = mkdtempSync(join(tmpdir(), 'rcac-original-owner-'));
    const file = join(dir, 'state.sqlite');
    const root = `/home/${linuxUser}/.local/share/rcac-owner-${randomUUID()}`;
    const base = new SqliteStore(file);
    const runningTickets = createClaudeModelRunningTickets();
    const outerTickets = createClaudeModelOuterTickets();
    const workspaceId = `ws_${randomUUID()}`;
    const workerId = `worker_${randomUUID()}`;
    const now = new Date();
    const snapshot = createSnapshotFromFiles('wc-owner', 'synthetic-commit', {
      'src/entry.ts': Buffer.from('export const allowed = "OWNER_TEST";\n'),
    }).toPersisted();
    let store: SqliteInvestigationStore | undefined;
    let reopened: SqliteInvestigationStore | undefined;
    let owner: Awaited<ReturnType<typeof runClaudeModelOriginalOwner>> | undefined;
    let originalClaim: ReturnType<SqliteInvestigationStore['listUnsettled']>[number] | undefined;
    let savedFact: ModelOuterConfinedFact | undefined;
    let unitName: string | undefined;
    let group: string | null | undefined;
    let observedBoot: string | undefined;
    let identities: { pid: number; ticks: number }[] = [];
    let terminalConfirmed = false;
    let testError: unknown;
    let rootCreated = false;
    let rootRemoved = false;
    let sqliteRemoved = false;
    try {
      evidence.stage = 'sqlite_fixture';
      base.insertWorkspace({ id: workspaceId, name: 'Synthetic owner fixture',
        canonicalRoot: dir, registeredBy: 'owner' });
      base.insertCollaboration({ id: 'col-owner', workspaceId, purpose: 'owner fixture',
        openedBy: 'owner', hostThreadId: null, state: 'open' });
      base.insertWorkingCopy({ id: 'wc-owner', workspaceId, canonicalRoot: dir });
      await base.saveSnapshot({ workspaceId, collaborationId: 'col-owner',
        workingCopyId: 'wc-owner', snapshot }, { workspaceId,
        collaborationId: 'col-owner', workingCopyId: 'wc-owner', commitRef: 'synthetic-commit' },
      'capture', 'owner', 'local_cli');
      base.insertGrant({ id: 'request', principal: 'external', audience: 'chatgpt',
        recipient: 'web', workspaceId, collaborationId: 'col-owner',
        permissions: ['investigation.request'], revokedAt: null, expiresAt: null });
      base.insertGrant({ id: 'read', principal: 'external', audience: 'chatgpt',
        recipient: 'web', workspaceId, collaborationId: 'col-owner',
        permissions: ['data.read'], dataPaths: ['src/entry.ts'], revokedAt: null, expiresAt: null });
      base.insertGrant({ id: 'worker-read', principal: workerId, audience: 'investigator',
        recipient: 'local', workspaceId, collaborationId: 'col-owner',
        permissions: ['data.read'], dataPaths: ['src/entry.ts'], revokedAt: null,
        expiresAt: new Date(now.getTime() + 120000).toISOString() });
      const record: InvestigationRecord = { id: `inv-${randomUUID()}`, workspaceId,
        collaborationId: 'col-owner', workingCopyId: 'wc-owner', principal: 'external',
        audience: 'chatgpt', recipient: 'web', grantId: 'request', profileRef: profileRevision,
        budgetRef: 'synthetic', budget: { maxWallSeconds: limits.maxWallSeconds,
          maxTurns: 2, maxToolCalls: 5 }, snapshotRef: snapshot.id,
        contextRevisionId: 'ctx-owner', question: 'Read the synthetic entry',
        scope: { paths: ['src/entry.ts'], symbols: [], relatedTests: [] },
        requestedOutputs: ['flow'], parentInvestigationId: null, state: 'queued',
        cancelRequested: false, attempts: [], result: null, createdAt: now.toISOString() };
      store = new SqliteInvestigationStore(file, { verifyIsolation: () => true,
        verifyNativeReceipt: runningTickets.verifyNativeStart,
        verifyModelRunningObservationReceipt: runningTickets.verifyRunningObservation,
        verifyOutcomeReceipt: () => true,
        verifyModelOuterReceipt: outerTickets.verifyOuter,
        verifyModelPromptWindowReceipt: outerTickets.verifyPromptWindow });
      store.enqueue(record, 'submit', 'fingerprint');
      let claim = store.claimRequest(record.id, { workerId,
        isolationEvidence: 'synthetic-isolation-only', profileRevision, permissionEpoch: 0,
        launchProtocol: 'resource_reservation_v1', now })!;
      const paths = { installRoot, nodeRoot, srtSettingsFile: `${root}/host-srt.json`,
        mcpConfigFile: `${root}/host-mcp.json`, helperFile: `${root}/host-helper.py`,
        privateAuthHome: `${root}/auth`,
        privateFifoDirectory: `${root}/${claim.attemptId}-${claim.workerEpoch}.mcp` };
      const launch = { workerEpoch: claim.workerEpoch, sourceDigest: sha('synthetic-source'),
        profileDigest: sha('synthetic-explicit-empty-profile'),
        commandDigest: buildClaudeModelSealedLaunch(paths, profile, limits.maxTurns).commandDigest,
        action: 'claude_model_v1' as const };
      unitName = `rcac-investigator-${randomUUID()}.service`;
      const descriptor = { attemptId: claim.attemptId, workspaceId, distro, linuxUser,
        uid: host.uid, bootId: host.boot, unitName, launchWorkerEpoch: claim.workerEpoch,
        sourceDigest: launch.sourceDigest, profileDigest: launch.profileDigest,
        commandDigest: launch.commandDigest };
      claim = store.reserveWslResource(claim, { unitName, distro, uid: host.uid,
        bootId: host.boot, gate: { protocol: 'attempt_gate_v1', linuxUser, root,
          payloadKind: 'claude_model_v1', launch } }, now);
      evidence.identity = { workspaceId, requestId: record.id, attemptId: claim.attemptId,
        workerEpoch: claim.workerEpoch, unitName, root };
      evidence.stage = 'private_auth_setup';
      t.diagnostic('reserved private WSL claim; preparing empty-auth owner fixture');
      const setup = String.raw`import os,sys
root=sys.argv[1]
os.mkdir(root,0o700)
os.mkdir(root+'/auth',0o700)
for name,body in [('host-srt.json',b'{}'),('host-mcp.json',b'{}'),
                  ('host-helper.py',b'# synthetic path placeholder\n')]:
 fd=os.open(root+'/'+name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 os.write(fd,body);os.close(fd)
assert os.listdir(root+'/auth')==[]
`;
      runWsl(['/usr/bin/python3', '-I', '-S', '-c', setup, root]);
      rootCreated = true;
      evidence.stage = 'original_owner';
      const repository = new RepositoryApplication({
        authorize: async request => {
          await request.context.assertFreshAuthority?.();
          const context = { ...request.context, now: new Date() };
          return authorize(context, request.operation, { workspaceId: request.workspaceId,
            collaborationId: request.collaborationId }, base.grantsFor(context.principal, context.audience));
        },
        getWorkingCopy: (ws, wc) => base.getWorkingCopy(ws, wc),
        collaborationBelongsToWorkspace: (ws, col) => base.collaborationBelongsToWorkspace(ws, col),
        lookupCapture: (input, key, principal, audience) =>
          base.lookupCapture(input, key, principal, audience),
        saveSnapshot: (saved, input, key, principal, audience) =>
          base.saveSnapshot(saved, input, key, principal, audience),
        getSnapshot: (id, ws, col) => base.getSnapshot(id, ws, col),
      });
      const dispatcher = new DispatchService(base, undefined, undefined, { repository });
      const binding = { collaborationId: 'col-owner', workingCopyId: 'wc-owner',
        snapshotId: snapshot.id, paths: ['src/entry.ts'], workerGrantId: 'worker-read',
        workerAudience: 'investigator', workerRecipient: 'local' };
      evidence.nativePortsRoute = 'real_native_ports_with_observation_capture';
      const capturePorts: ClaudeModelOriginalOwnerPorts = {
        prepare: preparePrivateFifo,
        operation: runClaudeModelSupervisorOperation,
        start: startClaudeModelUnit,
        persist: persistClaudeModelRunning,
        attach: attachPrivateFifo,
        observe: async (...args) => {
          // Capture an unvalidated native candidate for offline semantic diagnosis.
          // Forward the exact arguments and return the actual observer result unchanged.
          const observation = await observeClaudeModelOuter(...args);
          try {
            evidence.unvalidatedObservation = structuredClone(observation);
            evidence.trustedExpected = structuredClone({ descriptor: args[0].descriptor,
              paths: args[0].paths, profile: args[0].profile, limits, profileRevision });
            evidence.unvalidatedObservationSha256 =
              hashBytes(JSON.stringify(evidence.unvalidatedObservation));
            writeEvidence();
          } catch { evidence.observationCapture = 'failed'; }
          return observation;
        },
      };
      owner = await runClaudeModelOriginalOwner({ claim, store, binding, descriptor,
        paths, profile, profileRevision, limits, runningTickets, outerTickets,
        dispatcher, signal: controller.signal }, capturePorts);
      t.diagnostic('original-owner coordinator returned a bounded outer fact');
      savedFact = owner.fact;
      originalClaim = store.listUnsettled()[0]!;
      assert.equal(savedFact.kind, 'model_outer_confined_v1');
      assert.deepEqual(store.getModelOuterFact(originalClaim), savedFact);
      assert.equal(store.getModelPromptIntent(originalClaim), null);
      assert.equal(store.get(record.id)?.result, null);
      evidence.fact = savedFact;
      evidence.factSha256 = hashBytes(JSON.stringify(savedFact));
      evidence.stage = 'owner_close_and_sqlite_reopen';
      const probe = savedFact.observation.candidate.probe;
      identities = Object.values(probe.processes).map(process =>
        ({ pid: process.pid, ticks: process.startTicks }));
      group = savedFact.observation.candidate.running.resource.controlGroup;
      observedBoot = savedFact.observation.candidate.running.resource.bootId;
      await owner.close();
      owner = undefined;
      store.close(); store = undefined;
      reopened = new SqliteInvestigationStore(file);
      const historical = reopened.getModelOuterFact(originalClaim);
      assert.deepEqual(historical, savedFact);
      const intent = reopened.getModelPromptIntent(originalClaim);
      assert.equal(intent, null);
      const unsettled = reopened.listUnsettled();
      assert.equal(unsettled.length, 1);
      assert.equal(reopened.get(record.id)?.result, null);
      evidence.persistence = { reopenEqual: true, noPromptIntent: true,
        activeSlotCount: unsettled.length, activePhase: unsettled[0]?.phase,
        recordState: reopened.get(record.id)?.state,
        resultIsNull: reopened.get(record.id)?.result === null };
      evidence.stage = 'exact_unit_stop_and_terminal';
    } catch (error) { testError = error; }
    finally {
      const failureStage = evidence.stage;
      try { await owner?.close(); } catch (error) { testError ??= error; }
      if (identities.length === 0) {
        try {
          const audit = reopened ?? store;
          const current = audit?.listUnsettled()[0];
          const running = current && audit?.getModelRunningObservation(current);
          if (running?.kind === 'claude_model_running' && running.native.mainPid > 0 &&
            running.native.startTicks > 0 && running.resource.controlGroup) {
            identities = [{ pid: running.native.mainPid, ticks: running.native.startTicks }];
            group = running.resource.controlGroup;
            observedBoot = running.native.bootId;
            unitName ??= running.resource.unitName;
            evidence.knownRunningParent = { source: 'persisted_native_json',
              bootId: running.native.bootId, unitName: running.native.unitName,
              invocationId: running.native.invocationId,
              controlGroup: running.native.controlGroup,
              pid: running.native.mainPid, startTicks: running.native.startTicks };
          }
        } catch { evidence.knownRunningParent = 'unavailable'; }
      }
      if (unitName) {
        try {
          runWsl(['/usr/bin/systemctl', '--user', 'stop', unitName]);
          evidence.stopExit = 0;
        } catch (error) {
          evidence.stopExit = typeof (error as {status?: unknown}).status === 'number' ?
            (error as {status: number}).status : null;
          testError ??= error;
        }
      }
      if (unitName && group && observedBoot && identities.length > 0) {
        try {
          const output = runWsl(['/usr/bin/python3', '-I', '-S', '-c', inspectUnit,
            unitName, group, JSON.stringify(identities), observedBoot]);
          const checked = JSON.parse(output.trim()) as {
            showExit: number; mainPid: string; controlGroup: string;
            cgroupExists: boolean; cgroupPopulated: string | null;
            bootId: string; bootMatches: boolean;
            unit: Record<string, string>;
            pids: { sameTicks: boolean }[] };
          evidence.terminal = checked;
          evidence.terminalScope = identities.length === 4 ? 'outer_four_pid' : 'known_parent_only';
          const observedTerminal = checked.showExit === 0 && checked.bootMatches &&
            checked.unit.Id === unitName &&
            checked.mainPid === '0' &&
            checked.controlGroup === '' && (!checked.cgroupExists || checked.cgroupPopulated === '0') &&
            checked.pids.length === identities.length && checked.pids.every(item => !item.sameTicks);
          if (identities.length === 1) evidence.knownParentTerminal = observedTerminal;
          if (identities.length === 4) evidence.fourPidTerminal = observedTerminal;
          terminalConfirmed = identities.length === 4 && observedTerminal;
        } catch (error) { testError ??= error; }
      }
      evidence.terminalConfirmed = terminalConfirmed;
      try { store?.close(); } catch (error) { testError ??= error; }
      try { reopened?.close(); } catch (error) { testError ??= error; }
      try { base.close(); } catch (error) { testError ??= error; }
      // Preserve the full fact, reopened SQLite checks and terminal fields before deletion.
      writeEvidence();
      if (terminalConfirmed && testError === undefined && rootCreated) {
        try {
          const cleanup = String.raw`import os,shutil,sys
root=sys.argv[1]
assert os.path.realpath(root)==root and not os.path.islink(root)
assert os.path.dirname(root)=='/home/investigator/.local/share' and os.path.basename(root).startswith('rcac-owner-')
shutil.rmtree(root)
`;
          runWsl(['/usr/bin/python3', '-I', '-S', '-c', cleanup, root]);
          rootRemoved = true;
          const resolved = realpathSync(dir);
          assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
          assert.ok(basename(resolved).startsWith('rcac-original-owner-'));
          rmSync(dir, { recursive: true, force: true });
          sqliteRemoved = true;
        } catch (error) { testError ??= error; }
      } else t.diagnostic(`Retained unconfirmed original-owner fixture: ${dir} ; ${root}`);
      clearTimeout(watchdog);
      evidence.cleanup = { rootRemoved, sqliteRemoved,
        retainedRoot: rootRemoved ? null : root,
        retainedSqlite: sqliteRemoved ? null : file };
      evidence.stage = testError === undefined && terminalConfirmed && rootRemoved && sqliteRemoved ?
        'complete' : failureStage;
      evidence.result = evidence.stage === 'complete' ? 'passed' : 'failed';
      if (testError !== undefined) evidence.failure = {
        stage: failureStage, category: testError instanceof Error ? testError.name : typeof testError,
        nativeStage: testError instanceof ClaudeModelOriginalOwnerError ? testError.stage : 'unknown' };
      const evidenceSha256 = writeEvidence();
      t.diagnostic(`Evidence: ${evidencePath} sha256=${evidenceSha256}`);
    }
    if (testError !== undefined) throw testError;
    assert.equal(terminalConfirmed, true, 'exact Linux unit/PID/cgroup termination unconfirmed');
    t.diagnostic('original-owner outer fact persisted; zero model prompts were sent');
  });
