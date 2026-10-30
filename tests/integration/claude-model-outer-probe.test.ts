import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { WslResource } from '../../src/adapters/storage/investigation-sqlite.js';
import { buildClaudeModelSealedLaunch } from '../../src/adapters/secondary-investigator/claude-model-sealed-launch.js';
import { observeClaudeModelRunning } from '../../src/adapters/secondary-investigator/claude-model-running-observer.js';
import { observeClaudeModelOuterCandidate, runClaudeModelOuterProbe,
  type ClaudeModelOuterProbeOutput, type ClaudeModelOuterProbeSpec } from
  '../../src/adapters/secondary-investigator/claude-model-outer-probe.js';
import { observeClaudeModelOuter } from
  '../../src/adapters/secondary-investigator/claude-model-outer-observer.js';
import { validateClaudeModelOuterObservation } from
  '../../src/adapters/secondary-investigator/claude-model-outer-validation.js';
import { runClaudeModelSupervisorOperation, startClaudeModelUnit } from
  '../../src/adapters/secondary-investigator/claude-model-supervisor-runner.js';
import { claudeModelSupervisorSpec, type ClaudeModelSupervisorDescriptor,
  type ClaudeModelSupervisorState } from '../../src/adapters/secondary-investigator/claude-model-supervisor.js';

const wsl = 'C:\\Windows\\System32\\wsl.exe';
const prefix = ['-d', 'Ubuntu-22.04', '--user', 'investigator', '--cd', '/', '--exec'];
const run = (args: readonly string[], maxBuffer = 16384) => spawnSync(wsl,
  [...prefix, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer });
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

test('actual WSL outer observer binds candidate to a fresh consumed journal',
  { timeout: 60000 }, async t => {
    if (process.platform !== 'win32' || process.env.RCAC_RUN_MODEL_OUTER_PROBE_TEST !== '1') {
      t.skip('native WSL requires explicit RCAC_RUN_MODEL_OUTER_PROBE_TEST=1'); return;
    }
    const id = randomUUID();
    const root = `/home/investigator/.local/rcac-outer-collector-${id}`;
    const attemptId = `attempt_${id}`;
    const unitName = `rcac-investigator-${id}.service`;
    const profile = { allowedDomains: [] as string[] };
    const paths = {
      installRoot: '/home/investigator/.local/share/rcac-second-runtime-20260929',
      nodeRoot: '/home/investigator/.hermes/node',
      srtSettingsFile: `${root}/host-original-srt.json`,
      mcpConfigFile: `${root}/host-original-mcp.json`,
      helperFile: `${root}/host-original-helper.py`,
      privateAuthHome: `${root}/auth`,
      privateFifoDirectory: `${root}/${attemptId}-1.mcp`,
    };
    const record: Record<string, unknown> = { id, root, paths, profile, startedAt: new Date().toISOString(),
      noPrompt: true, noModel: true, originalBootstrapDeadlineSeconds: 5 };
    const evidenceDir = join(process.cwd(), '.local', 'qualification');
    const evidenceStem = `MODEL_OUTER_VALIDATION_2026-09-30_${id}`;
    mkdirSync(evidenceDir, { recursive: true });
    const writeEvidence = () => writeFileSync(join(evidenceDir, `${evidenceStem}.json`),
      JSON.stringify(record, null, 2) + '\n');
    let handle: ReturnType<typeof startClaudeModelUnit> | undefined;
    let descriptor: ClaudeModelSupervisorDescriptor | undefined;
    let entered: ClaudeModelSupervisorState | null = null;
    let bridgeClosedObserved = false;
    const observedPids: { pid: number; ticks: number }[] = [];
    let failure: unknown;
    try {
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000 });
      const dirty = spawnSync('git', ['status', '--short'], { encoding: 'utf8', timeout: 2000 });
      record.sourceCommit = head.stdout.trim(); record.dirtyBefore = dirty.stdout;
      const uid = run(['/usr/bin/id', '-u']);
      const boot = run(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      assert.equal(uid.status, 0, uid.stderr);
      assert.equal(boot.status, 0, boot.stderr);
      assert.equal(Number(uid.stdout.trim()), 1000);
      const check = run(['/usr/bin/python3', '-I', '-S', '-c',
        'import os,sys; paths=sys.argv[1:]; assert all(os.path.isdir(p) for p in paths); print("installed synthetic runtime paths confirmed")',
        `${paths.installRoot}/node_modules`, `${paths.installRoot}/deps`, paths.nodeRoot]);
      assert.equal(check.status, 0, check.stderr);
      const setup = String.raw`import os,sys
root,attempt=sys.argv[1:3]
os.mkdir(root,0o700)
os.mkdir(root+'/auth',0o700)
relay=root+'/'+attempt+'-1.mcp'
os.mkdir(relay,0o700)
for name in ('in','out'): os.mkfifo(relay+'/'+name,0o600)
fd=os.open(relay+'/helper.lock',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
os.write(fd,b'0'); os.fsync(fd); os.close(fd)
for name,body in (('host-original-srt.json',b'{}'),('host-original-mcp.json',b'{}'),('host-original-helper.py',b'# synthetic helper source\n')):
 fd=os.open(root+'/'+name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 os.write(fd,body); os.close(fd)
`;
      const created = run(['/usr/bin/python3', '-I', '-S', '-c', setup, root, attemptId]);
      record.setup = { exitCode: created.status, stderr: created.stderr };
      assert.equal(created.status, 0, created.stderr);
      const launch = buildClaudeModelSealedLaunch(paths, profile, 3);
      descriptor = { attemptId, workspaceId: `ws_${id}`, distro: 'Ubuntu-22.04',
        linuxUser: 'investigator', uid: 1000, bootId: boot.stdout.trim(), unitName,
        launchWorkerEpoch: 1, sourceDigest: sha('synthetic-source'),
        profileDigest: sha('synthetic-explicit-empty-profile'), commandDigest: launch.commandDigest };
      record.descriptor = descriptor;
      record.recipeDigest = sha(JSON.stringify(launch.recipe));
      record.prepareArgs = claudeModelSupervisorSpec('prepare', descriptor, root).args;
      record.enterArgs = claudeModelSupervisorSpec('enter_wait_exec', descriptor, root, paths,
        undefined, { maxWallSeconds: 20, maxTurns: 3 }, profile).args;
      const prepared = await runClaudeModelSupervisorOperation('prepare', descriptor, root);
      record.prepared = prepared;
      assert.equal(prepared?.phase, 'prepared');
      handle = startClaudeModelUnit(descriptor, root, paths, { maxWallSeconds: 20, maxTurns: 3 }, profile);
      void handle.closed.then(() => { bridgeClosedObserved = true; });
      const enterDeadline = Date.now() + 4000;
      while (Date.now() < enterDeadline) {
        entered = await runClaudeModelSupervisorOperation('status', descriptor, root);
        if (entered?.phase === 'entered') break;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      record.entered = entered;
      assert.equal(entered?.phase, 'entered');
      assert.ok(entered);
      observedPids.push({ pid: entered.enterPid!, ticks: entered.enterStartTicks! });
      const resource: WslResource = { unitName, distro: descriptor.distro, uid: descriptor.uid,
        bootId: descriptor.bootId, invocationId: entered.invocationId!,
        controlGroup: entered.controlGroup!, gate: { protocol: 'attempt_gate_v1',
          linuxUser: descriptor.linuxUser, root, payloadKind: 'claude_model_v1',
          launch: { workerEpoch: 1, sourceDigest: descriptor.sourceDigest,
            profileDigest: descriptor.profileDigest, commandDigest: descriptor.commandDigest,
            action: 'claude_model_v1' } } };
      const running = await observeClaudeModelRunning(resource, entered, descriptor);
      record.running = running;
      assert.equal(running.kind, 'claude_model_running');
      if (running.kind !== 'claude_model_running') throw new Error('running fact unavailable');
      record.releaseArgs = claudeModelSupervisorSpec('release', descriptor, root, undefined,
        { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! }).args;
      const ownerReleaseStart = performance.now();
      const ownerDeadline = ownerReleaseStart + 5000;
      record.ownerWindow = { releaseStartPerformanceMs: ownerReleaseStart,
        deadlinePerformanceMs: ownerDeadline, durationMs: 5000 };
      const released = await runClaudeModelSupervisorOperation('release', descriptor, root,
        { invocationId: entered.invocationId!, controlGroup: entered.controlGroup! });
      record.released = released;
      assert.ok(released && ['released', 'consumed'].includes(released.phase));
      const startup = await handle.ready;
      record.startup = startup;
      assert.ok(startup);
      assert.equal(startup.kind, 'bootstrap_ready_candidate');
      observedPids.push({ pid: startup.outerCandidate.hostPid,
        ticks: startup.outerCandidate.startTicks });
      let collectorOutput: ClaudeModelOuterProbeOutput | undefined;
      let collectorSpec: ClaudeModelOuterProbeSpec | undefined;
      let statusCalls = 0;
      const outerInput = { running, startup, descriptor, paths, profile,
        limits: {maxWallSeconds:20,maxTurns:3} };
      const observed = await observeClaudeModelOuter(outerInput,
        { deadline: ownerDeadline, closed: handle.closed }, {
        collect: input => observeClaudeModelOuterCandidate(input, async spec => {
          collectorSpec = spec;
          collectorOutput = await runClaudeModelOuterProbe(spec);
          return collectorOutput;
        }),
        status: async (actualDescriptor, actualRoot, signal) => {
          statusCalls++;
          assert.deepEqual(actualDescriptor, descriptor);
          assert.equal(actualRoot, root);
          const journalAfter = await runClaudeModelSupervisorOperation('status',
            actualDescriptor, actualRoot, undefined, signal);
          record.statusJournalReturned = journalAfter;
          return journalAfter;
        },
      });
      const semanticStart = performance.now();
      const semanticValid = validateClaudeModelOuterObservation(outerInput, observed,
        { maxWallSeconds: 20, maxTurns: 3 });
      const semanticEnd = performance.now();
      record.semanticValidation = { result: semanticValid, maxWallSeconds: 20,
        startedPerformanceMs: semanticStart, finishedPerformanceMs: semanticEnd,
        durationMs: semanticEnd - semanticStart, remainingMs: ownerDeadline - semanticEnd,
        bridgeClosedObserved, rawEvidence: `${evidenceStem}.raw.json` };
      record.ownerWindow = { ...record.ownerWindow as object,
        returnedPerformanceMs: semanticEnd, remainingMs: ownerDeadline - semanticEnd };
      record.statusCalls = statusCalls;
      record.collectorArgs = collectorSpec?.args;
      record.collectorExitCode = collectorOutput?.exitCode;
      record.collectorStderr = collectorOutput?.stderr.toString('utf8');
      record.collectorStdoutBytes = collectorOutput?.stdout.length;
      record.collectorStdoutSha256 = collectorOutput && sha(collectorOutput.stdout);
      if (collectorOutput) writeFileSync(join(evidenceDir, `${evidenceStem}.raw.json`),
        collectorOutput.stdout);
      record.observationKind = observed.kind;
      record.journalAfter = observed.kind === 'outer_journal_candidate' ? observed.journalAfter : null;
      record.candidateKind = observed.kind === 'outer_journal_candidate' ? observed.candidate.kind : null;
      if (observed.kind === 'outer_journal_candidate') {
        const probe = observed.candidate.probe;
        observedPids.push({ pid: probe.processes.wrapper.pid,
          ticks: probe.processes.wrapper.startTicks });
        observedPids.push({ pid: probe.processes.bootstrap.pid,
          ticks: probe.processes.bootstrap.startTicks });
        record.outerSummary = {
          unitBefore: probe.unitBefore, unitAfter: probe.unitAfter,
          pids: Object.fromEntries(Object.entries(probe.processes).map(([name, proc]) =>
            [name, { pid: proc.pid, ppid: proc.ppid, ticks: proc.startTicks }])),
          mountLines: { outer: probe.processes.outer.mountinfoRaw?.trimEnd().split('\n').length,
            bootstrap: probe.processes.bootstrap.mountinfoRaw?.trimEnd().split('\n').length },
        };
        record.sandboxPidView = probe.sandboxPidView;
        record.sandboxPaths = probe.sandboxPaths;
        record.endingIdentities = probe.endingIdentities;
        const badMount = structuredClone(observed);
        badMount.candidate.probe.mountedFixedFiles[0]!.sha256 = '0'.repeat(64);
        const badProcess = structuredClone(observed);
        badProcess.candidate.probe.processes.bootstrap.exe = '/tmp/python3';
        record.semanticNegative = {
          fixedFileDigestAccepted: validateClaudeModelOuterObservation(outerInput, badMount,
            { maxWallSeconds: 20, maxTurns: 3 }),
          bootstrapExecutableAccepted: validateClaudeModelOuterObservation(outerInput, badProcess,
            { maxWallSeconds: 20, maxTurns: 3 }),
          nativeCalls: 0,
        };
        assert.deepEqual(record.semanticNegative, {
          fixedFileDigestAccepted: false, bootstrapExecutableAccepted: false, nativeCalls: 0 });
      }
      assert.equal(semanticValid, true, 'outer mount/process/FD semantics unconfirmed');
      assert.ok(semanticEnd < ownerDeadline, 'semantic validation exceeded original release deadline');
      assert.equal(bridgeClosedObserved, false, 'original bridge closed before semantic validation');
      let blockedCalls = 0;
      const blockedRunner = async (): Promise<ClaudeModelOuterProbeOutput> => {
        blockedCalls++; throw new Error('unexpected native I/O');
      };
      const wrong = await observeClaudeModelOuterCandidate({ running, startup: {
        ...startup, outerCandidate: { ...startup.outerCandidate,
          hostPid: startup.outerCandidate.hostPid + 1 } }, descriptor, paths, profile }, blockedRunner);
      const cancelled = await observeClaudeModelOuterCandidate({ running: {
        ...running, journal: { ...running.journal, closed: true } }, startup,
      descriptor, paths, profile }, blockedRunner);
      record.negative = { wrong: wrong.kind, cancelled: cancelled.kind, nativeCalls: blockedCalls };
      assert.deepEqual(record.negative,
        { wrong: 'unconfirmed', cancelled: 'unconfirmed', nativeCalls: 0 });
      assert.equal(observed.kind, 'outer_journal_candidate');
      if (observed.kind === 'outer_journal_candidate') {
        assert.equal(observed.journalAfter.phase, 'consumed');
        assert.equal(observed.journalAfter.closed, false);
        assert.deepEqual(observed.journalAfter, startup.journal);
        assert.equal(statusCalls, 1);
      }
    } catch (error) {
      failure = error;
      record.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    } finally {
      if (handle) {
        const bridge = await handle.closeBridge();
        record.bridge = { ...bridge, stdout: bridge.stdout?.toString('utf8') };
      }
      if (descriptor) {
        const stopped = run(['/usr/bin/systemctl', '--user', 'stop', descriptor.unitName]);
        record.stop = { exitCode: stopped.status, stderr: stopped.stderr, stdout: stopped.stdout };
        const terminal = String.raw`import json,os,subprocess,sys
unit,group,identities=sys.argv[1:4]
result=subprocess.run(['/usr/bin/systemctl','--user','show','--no-pager','--property=MainPID,ControlGroup',unit],capture_output=True,timeout=2)
fields=dict(line.split('=',1) for line in result.stdout.decode().splitlines() if '=' in line)
same=[]
for item in json.loads(identities):
 pid,ticks=item['pid'],item['ticks']
 try:
  with open('/proc/%d/stat'%pid,encoding='ascii') as stream: raw=stream.read()
  current=int(raw[raw.rfind(')')+2:].split()[19]); same.append({'pid':pid,'sameTicks':current==ticks,'currentTicks':current})
 except FileNotFoundError: same.append({'pid':pid,'sameTicks':False,'currentTicks':None})
path='/sys/fs/cgroup'+group
exists=os.path.exists(path)
populated=None
if exists:
 with open(path+'/cgroup.events',encoding='ascii') as stream:
  populated=dict(row.split(' ',1) for row in stream.read().splitlines()).get('populated')
print(json.dumps({'showExit':result.returncode,'showStderr':result.stderr.decode(), 'mainPid':fields.get('MainPID'),'controlGroup':fields.get('ControlGroup'),'cgroupExists':exists,'cgroupPopulated':populated,'pids':same}))
`;
        const check = run(['/usr/bin/python3', '-I', '-S', '-c', terminal,
          descriptor.unitName, entered?.controlGroup ?? '', JSON.stringify(observedPids)]);
        record.terminalExitCode = check.status;
        record.terminalStderr = check.stderr;
        try { record.terminal = JSON.parse(check.stdout); }
        catch { record.terminalRaw = check.stdout; }
        const terminalFact = record.terminal as { mainPid?: string; controlGroup?: string;
          cgroupExists?: boolean; cgroupPopulated?: string | null;
          pids?: { sameTicks: boolean }[] } | undefined;
        if (check.status !== 0 || stopped.status !== 0 || terminalFact?.mainPid !== '0' ||
          terminalFact.controlGroup !== '' ||
          terminalFact.cgroupExists && terminalFact.cgroupPopulated !== '0' ||
          terminalFact.pids?.some(item => item.sameTicks)) {
          failure ??= new Error('exact owned Linux unit terminal state unconfirmed');
        }
      }
      record.finishedAt = new Date().toISOString();
      record.fixtureRetained = true;
      writeEvidence();
    }
    if (failure) throw failure;
  });
