import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
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
import { observeClaudeModelTreeTerminal, runClaudeModelTreeProbe,
  validateClaudeModelTreeTerminal } from
  '../../src/adapters/secondary-investigator/claude-model-tree-terminal.js';
import { observeClaudeModelTerminal, runClaudeModelTerminalProbe } from
  '../../src/adapters/secondary-investigator/claude-model-terminal-observer.js';
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

interface SentinelIdentity {
  kind: 'same_boot_sentinel_v1'; uid: number; bootId: string; pid: number;
  startTicks: number; controlGroup: string; pidNamespace: string;
}
interface SentinelExit {
  exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
  terminal: (SentinelIdentity & { reason: 'eof' | 'timeout' | 'unexpected_input' }) | null;
  stderr: string; stderrBytes: number;
}
class SentinelStartError extends Error {
  constructor(readonly exit: SentinelExit, cause: unknown) {
    super('SENTINEL_START_UNCONFIRMED', {cause});
    this.name = 'SentinelStartError';
  }
}

const sentinelPython = String.raw`import json,os,select,sys,time
raw=open('/proc/self/stat',encoding='ascii').read()
group=next(line[3:] for line in open('/proc/self/cgroup',encoding='ascii').read().splitlines() if line.startswith('0::'))
identity=dict(kind='same_boot_sentinel_v1',uid=os.getuid(),
 bootId=open('/proc/sys/kernel/random/boot_id',encoding='ascii').read().strip(),
 pid=os.getpid(),startTicks=int(raw[raw.rfind(')')+2:].split()[19]),
 controlGroup=group,pidNamespace=os.readlink('/proc/self/ns/pid'))
print(json.dumps(identity,separators=(',',':')),flush=True)
deadline=time.monotonic()+360
reason='timeout'
while time.monotonic()<deadline:
 readable,_,_=select.select([0],[],[],min(5,max(0,deadline-time.monotonic())))
 if readable:
  reason='eof' if not os.read(0,1) else 'unexpected_input'
  break
print(json.dumps(dict(identity,reason=reason),separators=(',',':')),flush=True)
`;

function validSentinel(value: unknown): value is SentinelIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.kind === 'same_boot_sentinel_v1' &&
    Number.isSafeInteger(item.uid) && (item.uid as number) > 0 &&
    typeof item.bootId === 'string' && /^[0-9a-f-]{36}$/.test(item.bootId) &&
    Number.isSafeInteger(item.pid) && (item.pid as number) > 1 &&
    Number.isSafeInteger(item.startTicks) && (item.startTicks as number) > 0 &&
    typeof item.controlGroup === 'string' && item.controlGroup.startsWith('/') &&
    typeof item.pidNamespace === 'string' && item.pidNamespace.startsWith('pid:[');
}

async function startSameBootSentinel(): Promise<{
  identity: SentinelIdentity; close(): Promise<SentinelExit> }> {
  const child = spawn(wsl, ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec',
    '/usr/bin/python3', '-I', '-S', '-c', sentinelPython],
  {env: {SystemRoot: String.raw`C:\Windows`, PATH: String.raw`C:\Windows\System32;C:\Windows`},
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  child.stdin.on('error', () => undefined);
  let identity: SentinelIdentity | null = null;
  let terminal: SentinelExit['terminal'] = null;
  let stderr = ''; let stderrBytes = 0; let stdoutBytes = 0;
  let startResolve!: (value: SentinelIdentity) => void;
  let startReject!: (error: Error) => void;
  const started = new Promise<SentinelIdentity>((resolve, reject) => {
    startResolve = resolve; startReject = reject;
  });
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
  child.stdout.on('data', (part: Buffer) => {stdoutBytes += part.length;});
  lines.on('line', line => {
    if (stdoutBytes > 4096 || Buffer.byteLength(line) > 1024) {
      if (!identity) startReject(new Error('SENTINEL_OUTPUT_BOUND'));
      return;
    }
    let value: unknown;
    try {value = JSON.parse(line) as unknown;} catch {return;}
    if (!validSentinel(value)) return;
    if (!identity) {identity = value; startResolve(value); return;}
    if (value.pid === identity.pid && value.startTicks === identity.startTicks &&
      value.bootId === identity.bootId && value.uid === identity.uid &&
      value.controlGroup === identity.controlGroup &&
      value.pidNamespace === identity.pidNamespace &&
      (value as SentinelExit['terminal'])?.reason &&
      ['eof', 'timeout', 'unexpected_input'].includes(
        (value as SentinelIdentity & {reason: string}).reason)) {
      terminal = value as SentinelExit['terminal'];
    }
  });
  child.stderr.on('data', (part: Buffer) => {
    stderrBytes += part.length;
    if (stderr.length < 4096) stderr += part.toString('utf8').slice(0, 4096 - stderr.length);
  });
  const closed = new Promise<Omit<SentinelExit, 'timedOut'>>(resolve => {
    child.on('error', error => {if (!identity) startReject(error);});
    child.on('close', (exitCode, signal) => {
      if (!identity) startReject(new Error('SENTINEL_EXIT_BEFORE_READY'));
      resolve({exitCode, signal, terminal, stderr, stderrBytes});
    });
  });
  const waitClosedBounded = async (): Promise<SentinelExit> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([closed.then(value => ({...value, timedOut: false})),
        new Promise<SentinelExit>(resolve => {
          timer = setTimeout(() => resolve({exitCode: null, signal: null,
            terminal: null, stderr, stderrBytes, timedOut: true}), 12000);
        })]);
      if (result.timedOut) {
        // Detach only this owned Windows bridge's pipes. This is not Linux terminal proof.
        lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
      }
      return result;
    } finally {if (timer) clearTimeout(timer);}
  };
  const startupTimer = setTimeout(() => {
    child.stdin.end(); startReject(new Error('SENTINEL_START_TIMEOUT'));
  }, 12000);
  try {identity = await started;}
  catch (error) {
    child.stdin.end();
    const exit = await waitClosedBounded();
    throw new SentinelStartError(exit, error);
  }
  finally {clearTimeout(startupTimer);}
  return {identity, close: async () => {
    child.stdin.end();
    return waitClosedBounded();
  }};
}

const inspectSentinelPython = String.raw`import json,os,sys
pid=int(sys.argv[1])
raw=open('/proc/%d/stat'%pid,encoding='ascii').read()
group=next(line[3:] for line in open('/proc/%d/cgroup'%pid,encoding='ascii').read().splitlines() if line.startswith('0::'))
print(json.dumps(dict(bootId=open('/proc/sys/kernel/random/boot_id',encoding='ascii').read().strip(),
 pid=pid,startTicks=int(raw[raw.rfind(')')+2:].split()[19]),state=raw[raw.rfind(')')+2:].split()[0],
 controlGroup=group,pidNamespace=os.readlink('/proc/%d/ns/pid'%pid))))
`;

function inspectSentinel(identity: SentinelIdentity): Record<string, unknown> {
  const observed = JSON.parse(runWsl(['/usr/bin/python3', '-I', '-S', '-c',
    inspectSentinelPython, String(identity.pid)]).trim()) as Record<string, unknown>;
  assert.equal(observed.bootId, identity.bootId);
  assert.equal(observed.pid, identity.pid);
  assert.equal(observed.startTicks, identity.startTicks);
  assert.equal(observed.controlGroup, identity.controlGroup);
  assert.equal(observed.pidNamespace, identity.pidNamespace);
  assert.equal(['Z', 'X', 'x'].includes(String(observed.state)), false);
  return observed;
}

const inspectUnit = String.raw`import json,os,subprocess,sys
unit,group,identities,expected_boot,expected_inv=sys.argv[1:6]
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
  pids.append(dict(pid=pid,exists=True,sameTicks=current==ticks))
 except FileNotFoundError: pids.append(dict(pid=pid,exists=False,sameTicks=False))
path='/sys/fs/cgroup'+group
exists=os.path.exists(path)
populated=None
if exists:
 with open(path+'/cgroup.events',encoding='ascii') as stream:
  populated=dict(row.split(' ',1) for row in stream.read().splitlines()).get('populated')
print(json.dumps(dict(showExit=result.returncode,mainPid=fields.get('MainPID'),
 controlGroup=fields.get('ControlGroup'),cgroupExists=exists,
 cgroupPopulated=populated,pids=pids,bootId=actual_boot,
  bootMatches=actual_boot==expected_boot,invocationMatches=fields.get('InvocationID')==expected_inv,
  unit=fields)))
`;

// Guard any fallback stop with original boot, invocation, group, PID and start ticks.
const stopExactUnit = String.raw`import json,os,subprocess,sys
unit,group,boot,inv,pid_text,ticks_text=sys.argv[1:7]
if open('/proc/sys/kernel/random/boot_id',encoding='ascii').read().strip()!=boot: raise ValueError('boot')
result=subprocess.run(['/usr/bin/systemctl','--user','show','--no-pager',
 '--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup',unit],
 capture_output=True,timeout=3)
fields=dict(row.split('=',1) for row in result.stdout.decode().splitlines() if '=' in row)
if (result.returncode!=0 or fields.get('Id')!=unit or fields.get('InvocationID')!=inv or
    fields.get('ControlGroup')!=group or fields.get('MainPID')!=pid_text): raise ValueError('unit identity')
with open('/proc/%s/stat'%pid_text,encoding='ascii') as stream: raw=stream.read()
if int(raw[raw.rfind(')')+2:].split()[19])!=int(ticks_text): raise ValueError('pid identity')
stop=subprocess.run(['/usr/bin/systemctl','--user','stop',unit],capture_output=True,timeout=5)
print(json.dumps(dict(preStop=fields,stopExit=stop.returncode)))
if stop.returncode!=0: raise ValueError('stop failed')
`;

test('native zero-model tree close survives an installed CLI recovery restart',
  { timeout: 330000 }, async t => {
    if (process.platform !== 'win32') { t.skip('Windows WSL fixture unavailable'); return; }
    if (process.env.RCAC_RUN_MODEL_TREE_NATIVE_RESTART !== '1') {
      t.skip('native WSL and installed restart require RCAC_RUN_MODEL_TREE_NATIVE_RESTART=1'); return;
    }
    const runId = randomUUID();
    const evidenceDir = join(process.cwd(), '.local', 'qualification');
    const evidencePath = join(evidenceDir, `MODEL_TREE_NATIVE_RESTART_${runId}.json`);
    const controller = new AbortController();
    // Package work is outside the native owner watchdog and the claim lease.
    let watchdog: NodeJS.Timeout | undefined;
    mkdirSync(evidenceDir, { recursive: true });
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'],
      { encoding: 'utf8', timeout: 2000 }).trim();
    const gitStatusShort = execFileSync('git', ['status', '--short', '--untracked-files=normal'],
      { encoding: 'utf8', timeout: 2000 });
    const evidence: Record<string, unknown> = { schema: 'model_tree_native_restart_test_v1',
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
    const captureProcess = (label: string, result: {
      status: number | null; signal: NodeJS.Signals | null; error?: Error;
      stdout: string | null; stderr: string | null }) => {
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      evidence[label] = {status: result.status, signal: result.signal,
        errorName: result.error?.name ?? null,
        errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
        stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 4096),
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
        stdoutTruncated: stdout.length > 4096, stderrTruncated: stderr.length > 4096,
        stdoutSha256: hashBytes(stdout), stderrSha256: hashBytes(stderr)};
      writeEvidence();
    };
    let sentinel: Awaited<ReturnType<typeof startSameBootSentinel>> | undefined;
    let sentinelExitConfirmed = false;
    let sentinelClosePromise: Promise<void> | undefined;
    const closeSentinel = (): Promise<void> => {
      if (!sentinel) return Promise.resolve();
      sentinelClosePromise ??= (async () => {
        const exit = await sentinel!.close();
        evidence.sentinelExit = exit;
        writeEvidence();
        assert.equal(exit.timedOut, false);
        assert.equal(exit.exitCode, 0);
        assert.equal(exit.signal, null);
        assert.deepEqual(exit.terminal, {...sentinel!.identity, reason: 'eof'});
        sentinelExitConfirmed = true;
      })();
      return sentinelClosePromise;
    };
    evidence.stage = 'same_boot_sentinel_start';
    try {
      sentinel = await startSameBootSentinel();
      t.after(closeSentinel);
    } catch (error) {
      if (sentinel) {
        try {await closeSentinel();} catch {evidence.sentinelExitConfirmed = false;}
      }
      evidence.result = 'failed';
      evidence.sentinelStartFailure = {category: error instanceof Error ? error.name : typeof error,
        boundedExit: error instanceof SentinelStartError ? error.exit : null};
      writeEvidence(); throw error;
    }
    evidence.sentinelStart = sentinel.identity;
    evidence.sentinelStartSha256 = hashBytes(JSON.stringify(sentinel.identity));
    try {evidence.sentinelInitialInspection = inspectSentinel(sentinel.identity);}
    catch (error) {
      evidence.result = 'failed'; evidence.sentinelInitialInspection = 'unconfirmed';
      try {await closeSentinel();} catch {evidence.sentinelExitConfirmed = false;}
      writeEvidence(); throw error;
    }
    writeEvidence();
    console.error(`[model-tree-native-restart ${runId}] owned same-boot sentinel ready`);
    let host: { uid: number; boot: string; runtimeReady: boolean };
    try {
      const output = runWsl(['/usr/bin/python3', '-I', '-S', '-c',
        `import json,os
print(json.dumps(dict(uid=os.getuid(),boot=open('/proc/sys/kernel/random/boot_id').read().strip(),
 runtimeReady=all(os.path.isdir(p) for p in ${JSON.stringify(
          [`${installRoot}/node_modules`, `${installRoot}/deps`, nodeRoot])}))))`]);
      host = JSON.parse(output.slice(output.lastIndexOf('{')).trim()) as typeof host;
    } catch {
      try {inspectSentinel(sentinel.identity);}
      catch (error) {
        evidence.result = 'failed'; evidence.stage = 'host_preflight_boot_or_sentinel_changed';
        try {await closeSentinel();} catch {evidence.sentinelExitConfirmed = false;}
        writeEvidence(); throw error;
      }
      await closeSentinel();
      evidence.result = 'skipped'; evidence.stage = 'host_preflight';
      evidence.skipReason = 'private_wsl_user_or_runtime_unavailable';
      writeEvidence(); clearTimeout(watchdog);
      t.skip('private WSL user or runtime unavailable'); return;
    }
    if (!host.runtimeReady) {
      await closeSentinel();
      evidence.result = 'skipped'; evidence.stage = 'host_preflight';
      evidence.skipReason = 'installed_private_runtime_paths_unavailable';
      writeEvidence(); clearTimeout(watchdog);
      t.skip('installed private runtime paths unavailable'); return;
    }
    try {
      assert.equal(host.uid, sentinel.identity.uid);
      assert.equal(host.boot, sentinel.identity.bootId);
      evidence.sentinelHostBinding = {sameUid: true, sameBoot: true};
      writeEvidence();
    } catch (error) {await closeSentinel(); throw error;}

    const fixture = await (async () => {
      let createdDirectory: string | null = null;
      try {
        const fixtureParent = process.platform === 'win32' ? homedir() : tmpdir();
        const dir = mkdtempSync(join(fixtureParent, 'rcac-model-restart-'));
        createdDirectory = dir;
        const data = join(dir, 'data');
        const file = join(data, 'state.sqlite');
        const root = `/home/${linuxUser}/.local/share/rcac-owner-${randomUUID()}`;
        const runningTickets = createClaudeModelRunningTickets();
        const outerTickets = createClaudeModelOuterTickets();
        const workspaceId = `ws_${randomUUID()}`;
        const workerId = `worker_${randomUUID()}`;
        const snapshot = createSnapshotFromFiles('wc-owner', 'synthetic-commit', {
          'src/entry.ts': Buffer.from('export const allowed = "OWNER_TEST";\n'),
        }).toPersisted();
        return {fixtureParent, dir, data, file, root, runningTickets, outerTickets,
          workspaceId, workerId, snapshot};
      } catch (error) {
        evidence.result = 'failed'; evidence.stage = 'fixture_construction';
        evidence.fixtureConstruction = {retainedDirectory: createdDirectory,
          failureCategory: error instanceof Error ? error.name : typeof error};
        try {await closeSentinel();} catch {evidence.sentinelExitConfirmed = false;}
        writeEvidence(); throw error;
      }
    })();
    const {fixtureParent, dir, data, file, root, runningTickets, outerTickets,
      workspaceId, workerId, snapshot} = fixture;
    let base: SqliteStore | undefined;
    let now: Date;
    let store: SqliteInvestigationStore | undefined;
    let reopened: SqliteInvestigationStore | undefined;
    let owner: Awaited<ReturnType<typeof runClaudeModelOriginalOwner>> | undefined;
    let originalClaim: ReturnType<SqliteInvestigationStore['listUnsettled']>[number] | undefined;
    let savedFact: ModelOuterConfinedFact | undefined;
    let unitName: string | undefined;
    let group: string | null | undefined;
    let observedBoot: string | undefined;
    let originalInvocation: string | undefined;
    let originalParent: {pid: number; ticks: number} | undefined;
    let identities: { pid: number; ticks: number }[] = [];
    let terminalConfirmed = false;
    let testError: unknown;
    let rootCreated = false;
    let rootRemoved = false;
    let sqliteRemoved = false;
    let installedCli: string | undefined;
    let firstTreeConfirmed = false;
    let settled = false;
    let claimCreated = false;
    try {
      evidence.stage = 'packed_offline_install';
      const npmCli = process.env.npm_execpath;
      assert.ok(npmCli, 'invoke opt-in test through npm to bind its installed npm CLI');
      const repositoryRoot = resolve('.');
      const runNode = (args: string[], timeout: number): string => {
        const result = spawnSync(process.execPath, args,
          {cwd: repositoryRoot, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024});
        assert.equal(result.status, 0, `offline package command failed: ${result.stderr || result.stdout}`);
        return result.stdout;
      };
      runNode([npmCli, 'run', 'build'], 20000);
      const packed = JSON.parse(runNode([npmCli, 'pack', '--json', '--pack-destination', dir],
        15000)) as {filename: string}[];
      assert.equal(packed.length, 1);
      const tarball = join(dir, packed[0]!.filename);
      const packageSha256 = hashBytes(readFileSync(tarball));
      runNode([npmCli, 'install', '--offline', '--prefix', join(dir, 'installed'),
        '--ignore-scripts', '--no-audit', '--no-fund', tarball], 20000);
      installedCli = join(dir, 'installed', 'node_modules', 'repo-conduit',
        'dist', 'src', 'cli', 'main.js');
      assert.ok(existsSync(installedCli));
      evidence.package = {filename: packed[0]!.filename, sha256: packageSha256,
        installedCliSha256: hashBytes(readFileSync(installedCli)),
        route: 'npm_pack_offline_install'};
      evidence.stage = 'installed_cli_init';
      console.error(`[model-tree-native-restart ${runId}] installed CLI init starting`);
      const initialized = spawnSync(process.execPath, [installedCli, '--data-dir', data, 'init'],
        {cwd: dir, encoding: 'utf8', timeout: 60000});
      captureProcess('installedInit', initialized);
      console.error(`[model-tree-native-restart ${runId}] installed CLI init exited ${initialized.status}`);
      assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
      const localPrincipal = (JSON.parse(initialized.stdout) as {principal: string}).principal;
      base = new SqliteStore(file);
      now = new Date();
      watchdog = setTimeout(() => controller.abort(), 45000);
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
      base.insertGrant({id: 'local-read', principal: localPrincipal, audience: 'local-os',
        recipient: localPrincipal, workspaceId, collaborationId: 'col-owner',
        permissions: ['collab.read'], revokedAt: null, expiresAt: null});
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
      claimCreated = true;
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
      evidence.sentinelBeforeOwner = inspectSentinel(sentinel.identity);
      console.error(`[model-tree-native-restart ${runId}] private Linux root prepared; original owner starting`);
      evidence.stage = 'original_owner';
      const fixtureBase = base;
      const repository = new RepositoryApplication({
        authorize: async request => {
          await request.context.assertFreshAuthority?.();
          const context = { ...request.context, now: new Date() };
          return authorize(context, request.operation, { workspaceId: request.workspaceId,
            collaborationId: request.collaborationId }, fixtureBase.grantsFor(context.principal, context.audience));
        },
        getWorkingCopy: (ws, wc) => fixtureBase.getWorkingCopy(ws, wc),
        collaborationBelongsToWorkspace: (ws, col) => fixtureBase.collaborationBelongsToWorkspace(ws, col),
        lookupCapture: (input, key, principal, audience) =>
          fixtureBase.lookupCapture(input, key, principal, audience),
        saveSnapshot: (saved, input, key, principal, audience) =>
          fixtureBase.saveSnapshot(saved, input, key, principal, audience),
        getSnapshot: (id, ws, col) => fixtureBase.getSnapshot(id, ws, col),
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
      evidence.stage = 'exact_supervisor_close_before_owner_close';
      const probe = savedFact.observation.candidate.probe;
      identities = Object.values(probe.processes).map(process =>
        ({ pid: process.pid, ticks: process.startTicks }));
      group = savedFact.observation.candidate.running.resource.controlGroup;
      observedBoot = savedFact.observation.candidate.running.resource.bootId;
      originalInvocation = savedFact.observation.candidate.running.native.invocationId;
      originalParent = {pid: savedFact.observation.candidate.running.native.mainPid,
        ticks: savedFact.observation.candidate.running.native.startTicks};
      const closed = await runClaudeModelSupervisorOperation('close', descriptor, root);
      assert.ok(closed?.closed && closed.phase === 'consumed');
      assert.deepEqual(closed, {...savedFact.observation.journalAfter, closed: true});
      evidence.closedJournal = closed;
      evidence.closedJournalSha256 = hashBytes(JSON.stringify(closed));
      evidence.stage = 'first_native_tree_observation';
      evidence.sentinelBeforeTree = inspectSentinel(sentinel.identity);
      assert.ok(group);
      assert.notEqual(sentinel.identity.controlGroup, group);
      assert.equal(sentinel.identity.controlGroup.startsWith(`${group}/`), false);
      assert.equal(sentinel.identity.controlGroup.includes(unitName), false);
      assert.notEqual(sentinel.identity.pidNamespace,
        savedFact.observation.candidate.probe.processes.outer.namespaces.pid);
      const nativeCalls: Record<string, unknown>[] = [];
      evidence.firstTreeNativeCalls = nativeCalls;
      const saveNativeCalls = () => {
        try { writeEvidence(); }
        catch { evidence.firstTreeNativeCallCapture = 'write_failed'; }
      };
      const actualTreeProbe: typeof runClaudeModelTreeProbe = async spec => {
        const started = performance.now();
        const call: Record<string, unknown> = {kind: 'actual_tree_probe',
          mode: spec.args.at(-1), startedAt: new Date().toISOString(),
          implementation: 'runClaudeModelTreeProbe'};
        nativeCalls.push(call); saveNativeCalls();
        try {
          const output = await runClaudeModelTreeProbe(spec);
          const cap = 4096;
          try {
            Object.assign(call, {exitCode: output.exitCode, decodedPreviewCapChars: cap,
              decodedStdoutPreview: output.stdout.slice(0, cap),
              decodedStderrPreview: output.stderr.slice(0, cap),
              decodedStdoutChars: output.stdout.length, decodedStderrChars: output.stderr.length,
              decodedStdoutUtf8Bytes: Buffer.byteLength(output.stdout),
              decodedStderrUtf8Bytes: Buffer.byteLength(output.stderr),
              decodedStdoutPreviewTruncated: output.stdout.length > cap,
              decodedStderrPreviewTruncated: output.stderr.length > cap,
              decodedStdoutTextSha256: hashBytes(output.stdout),
              decodedStderrTextSha256: hashBytes(output.stderr)});
          } catch { call.capture = 'failed'; }
          return output;
        } catch (error) {
          call.errorName = error instanceof Error ? error.name : typeof error;
          throw error;
        } finally { call.elapsedMs = performance.now() - started; saveNativeCalls(); }
      };
      const actualUnitProbe: typeof runClaudeModelTerminalProbe = async spec => {
        const started = performance.now();
        const call: Record<string, unknown> = {kind: 'actual_unit_terminal_probe',
          startedAt: new Date().toISOString(), implementation: 'runClaudeModelTerminalProbe',
          executable: spec.executable};
        nativeCalls.push(call); saveNativeCalls();
        try {
          const output = await runClaudeModelTerminalProbe(spec);
          const cap = 4096;
          try {
            Object.assign(call, {exitCode: output.exitCode, decodedPreviewCapChars: cap,
              decodedStdoutPreview: output.stdout.slice(0, cap),
              decodedStderrPreview: output.stderr.slice(0, cap),
              decodedStdoutChars: output.stdout.length, decodedStderrChars: output.stderr.length,
              decodedStdoutUtf8Bytes: Buffer.byteLength(output.stdout),
              decodedStderrUtf8Bytes: Buffer.byteLength(output.stderr),
              decodedStdoutPreviewTruncated: output.stdout.length > cap,
              decodedStderrPreviewTruncated: output.stderr.length > cap,
              decodedStdoutTextSha256: hashBytes(output.stdout),
              decodedStderrTextSha256: hashBytes(output.stderr)});
          } catch { call.capture = 'failed'; }
          return output;
        } catch (error) {
          call.errorName = error instanceof Error ? error.name : typeof error;
          throw error;
        } finally {call.elapsedMs = performance.now() - started; saveNativeCalls();}
      };
      const actualTerminalObserver = async (
        resource: Parameters<typeof observeClaudeModelTerminal>[0],
        journal: Parameters<typeof observeClaudeModelTerminal>[1],
        observedDescriptor: Parameters<typeof observeClaudeModelTerminal>[2],
        runningFact: Parameters<typeof observeClaudeModelTerminal>[3]) => {
        const started = performance.now();
        const call: Record<string, unknown> = {kind: 'actual_unit_terminal_observer',
          startedAt: new Date().toISOString(), implementation: 'observeClaudeModelTerminal'};
        nativeCalls.push(call); saveNativeCalls();
        try {
          const observation = await observeClaudeModelTerminal(resource, journal,
            observedDescriptor, runningFact, actualUnitProbe);
          try {
            call.observation = structuredClone(observation);
            call.observationJsonSha256 = hashBytes(JSON.stringify(observation));
          } catch { call.capture = 'failed'; }
          return observation;
        } catch (error) {
          call.errorName = error instanceof Error ? error.name : typeof error;
          throw error;
        } finally { call.elapsedMs = performance.now() - started; saveNativeCalls(); }
      };
      const firstTree = await observeClaudeModelTreeTerminal(savedFact, closed,
        actualTreeProbe, actualTerminalObserver);
      evidence.firstTreeObservation = firstTree;
      evidence.firstTreeObservationSha256 = hashBytes(JSON.stringify(firstTree));
      assert.equal(firstTree.kind, 'model_tree_terminal_v1');
      assert.equal(validateClaudeModelTreeTerminal(savedFact, firstTree), true);
      firstTreeConfirmed = true;
      // The original owner closes only its Windows bridge/FIFO and marks recovery required.
      evidence.stage = 'owner_close_and_sqlite_reopen';
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
      assert.equal(unsettled[0]?.phase, 'reconcile');
      assert.equal(reopened.get(record.id)?.state, 'recovery_required');
      reopened.close(); reopened = undefined;
      base.close(); base = undefined;
      evidence.stage = 'real_lease_expiry';
      // The claim was created at now with a fixed 30-second lease. No clock/SQL mutation.
      while (Date.now() <= now.getTime() + 30300) {
        const remaining = now.getTime() + 30300 - Date.now();
        console.error(`[model-tree-native-restart ${runId}] waiting for real lease: ${Math.max(0, remaining)} ms`);
        await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(1, remaining))));
      }
      evidence.lease = {claimCreatedAt: now.toISOString(), expiredAtOrBefore: new Date().toISOString(),
        waitRoute: 'wall_clock_without_database_mutation'};
      evidence.stage = 'installed_cli_startup_recovery';
      evidence.sentinelBeforeInstalledRecovery = inspectSentinel(sentinel.identity);
      const request = {operation: 'collab.get', scope: {workspaceId,
        collaborationId: 'col-owner'}, payload: {}};
      const invokeInstalled = () => spawnSync(process.execPath,
        [installedCli!, '--data-dir', data, 'request'],
        {cwd: dir, encoding: 'utf8', timeout: 60000, input: JSON.stringify(request)});
      console.error(`[model-tree-native-restart ${runId}] installed CLI first recovery starting`);
      const firstStart = invokeInstalled();
      captureProcess('installedFirstStart', firstStart);
      console.error(`[model-tree-native-restart ${runId}] installed CLI first recovery exited ${firstStart.status}`);
      assert.equal(firstStart.status, 0, firstStart.stderr || firstStart.stdout);
      assert.equal((JSON.parse(firstStart.stdout) as {id: string}).id, 'col-owner');
      reopened = new SqliteInvestigationStore(file);
      const finalRecord = reopened.get(record.id);
      assert.equal(reopened.listUnsettled().length, 0);
      assert.equal(finalRecord?.state, 'failed');
      assert.equal(finalRecord?.result, null);
      assert.equal(finalRecord?.failureReason, 'model_tree_terminated_without_outcome');
      assert.equal(finalRecord?.attempts.length, 1);
      assert.equal(finalRecord?.attempts[0]?.terminationConfirmed, true);
      const audit = new DatabaseSync(file, {readOnly: true});
      let settledTree: unknown;
      try {
        const historical = audit.prepare('SELECT outer_json FROM investigation_model_running_facts WHERE attempt_id=?')
          .get(originalClaim.attemptId) as {outer_json: string} | undefined;
        assert.deepEqual(JSON.parse(historical!.outer_json) as unknown, savedFact);
        const treeRows = audit.prepare('SELECT observation_json FROM investigation_model_tree_facts WHERE attempt_id=?')
          .all(originalClaim.attemptId) as {observation_json: string}[];
        assert.equal(treeRows.length, 1);
        settledTree = JSON.parse(treeRows[0]!.observation_json) as unknown;
        assert.equal(validateClaudeModelTreeTerminal(savedFact, settledTree as typeof firstTree), true);
        assert.equal((audit.prepare('SELECT COUNT(*) AS count FROM investigation_model_dispatch WHERE attempt_id=?')
          .get(originalClaim.attemptId) as {count: number}).count, 0);
      } finally { audit.close(); }
      evidence.installedSettlement = {record: finalRecord, treeObservation: settledTree,
        activeSlotCount: 0, promptIntentCount: 0, originalFactEqual: true};
      reopened.close(); reopened = undefined;
      console.error(`[model-tree-native-restart ${runId}] installed CLI second restart starting`);
      const secondStart = invokeInstalled();
      captureProcess('installedSecondStart', secondStart);
      console.error(`[model-tree-native-restart ${runId}] installed CLI second restart exited ${secondStart.status}`);
      assert.equal(secondStart.status, 0, secondStart.stderr || secondStart.stdout);
      reopened = new SqliteInvestigationStore(file);
      assert.equal(reopened.listUnsettled().length, 0);
      assert.deepEqual(reopened.get(record.id), finalRecord);
      const secondAudit = new DatabaseSync(file, {readOnly: true});
      try {
        assert.equal((secondAudit.prepare('SELECT COUNT(*) AS count FROM investigation_model_tree_facts WHERE attempt_id=?')
          .get(originalClaim.attemptId) as {count: number}).count, 1);
        const sameTree = secondAudit.prepare('SELECT observation_json FROM investigation_model_tree_facts WHERE attempt_id=?')
          .get(originalClaim.attemptId) as {observation_json: string};
        assert.deepEqual(JSON.parse(sameTree.observation_json) as unknown, settledTree);
        const historical = secondAudit.prepare('SELECT outer_json FROM investigation_model_running_facts WHERE attempt_id=?')
          .get(originalClaim.attemptId) as {outer_json: string};
        assert.deepEqual(JSON.parse(historical.outer_json) as unknown, savedFact);
      } finally {secondAudit.close();}
      settled = true;
      evidence.stage = 'exact_unit_terminal_and_cleanup';
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
            originalInvocation = running.native.invocationId;
            originalParent = {pid: running.native.mainPid, ticks: running.native.startTicks};
            unitName ??= running.resource.unitName;
            evidence.knownRunningParent = { source: 'persisted_native_json',
              bootId: running.native.bootId, unitName: running.native.unitName,
              invocationId: running.native.invocationId,
              controlGroup: running.native.controlGroup,
              pid: running.native.mainPid, startTicks: running.native.startTicks };
          }
        } catch { evidence.knownRunningParent = 'unavailable'; }
      }
      if (!firstTreeConfirmed && unitName && group && observedBoot && originalInvocation && originalParent) {
        try {
          const result = runWsl(['/usr/bin/python3', '-I', '-S', '-c', stopExactUnit,
            unitName, group, observedBoot, originalInvocation,
            String(originalParent.pid), String(originalParent.ticks)]);
          evidence.exactFallbackStop = JSON.parse(result.trim()) as unknown;
        } catch (error) {
          evidence.exactFallbackStop = 'identity_unconfirmed_or_stop_failed';
          testError ??= error;
        }
      } else if (!firstTreeConfirmed) {
        evidence.exactFallbackStop = 'no_verified_original_start_identity';
      }
      if (unitName && group && observedBoot && originalInvocation && identities.length > 0) {
        try {
          const output = runWsl(['/usr/bin/python3', '-I', '-S', '-c', inspectUnit,
            unitName, group, JSON.stringify(identities), observedBoot, originalInvocation]);
          const checked = JSON.parse(output.trim()) as {
            showExit: number; mainPid: string; controlGroup: string;
            cgroupExists: boolean; cgroupPopulated: string | null;
            bootId: string; bootMatches: boolean; invocationMatches: boolean;
            unit: Record<string, string>;
            pids: { exists: boolean; sameTicks: boolean }[] };
          evidence.terminal = checked;
          evidence.terminalScope = identities.length === 4 ? 'outer_four_pid' : 'known_parent_only';
          const observedTerminal = checked.showExit === 0 && checked.bootMatches &&
            checked.unit.Id === unitName &&
            checked.mainPid === '0' &&
            checked.controlGroup === '' && (!checked.cgroupExists || checked.cgroupPopulated === '0') &&
            checked.pids.length === identities.length && checked.pids.every(item => !item.exists) &&
            ((checked.unit.LoadState === 'loaded' && checked.invocationMatches &&
              ((checked.unit.ActiveState === 'inactive' && checked.unit.SubState === 'dead') ||
               (checked.unit.ActiveState === 'failed' && checked.unit.SubState === 'failed'))) ||
             (checked.unit.LoadState === 'not-found' && checked.unit.InvocationID === '' &&
              checked.unit.ActiveState === 'inactive' && checked.unit.SubState === 'dead'));
          if (identities.length === 1) evidence.knownParentTerminal = observedTerminal;
          if (identities.length === 4) evidence.fourPidTerminal = observedTerminal;
          terminalConfirmed = identities.length === 4 && observedTerminal;
        } catch (error) { testError ??= error; }
      }
      evidence.terminalConfirmed = terminalConfirmed;
      try { evidence.sentinelBeforeCleanup = inspectSentinel(sentinel.identity); }
      catch (error) { testError ??= error; evidence.sentinelBeforeCleanup = 'unconfirmed'; }
      try { await closeSentinel(); }
      catch (error) { testError ??= error; }
      evidence.sentinelExitConfirmed = sentinelExitConfirmed;
      try { store?.close(); } catch (error) { testError ??= error; }
      try { reopened?.close(); } catch (error) { testError ??= error; }
      try { base?.close(); } catch (error) { testError ??= error; }
      // Preserve the full fact, reopened SQLite checks and terminal fields before deletion.
      writeEvidence();
      if (terminalConfirmed && firstTreeConfirmed && settled && sentinelExitConfirmed &&
        testError === undefined && rootCreated) {
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
          assert.equal(dirname(resolved).toLowerCase(), resolve(fixtureParent).toLowerCase());
          assert.ok(basename(resolved).startsWith('rcac-model-restart-'));
          rmSync(dir, { recursive: true, force: true });
          sqliteRemoved = true;
        } catch (error) { testError ??= error; }
      } else t.diagnostic(`Retained unconfirmed fixture: ${dir}; Linux root ${rootCreated ? root : 'not created'}`);
      clearTimeout(watchdog);
      evidence.cleanup = { claimCreated, linuxRootCreated: rootCreated,
        originalUnitNameReserved: unitName ?? null, rootRemoved, sqliteRemoved,
        retainedRoot: rootCreated && !rootRemoved ? root : null,
        retainedSqlite: !sqliteRemoved && existsSync(file) ? file : null,
        retainedFixtureDirectory: sqliteRemoved ? null : dir };
      evidence.stage = testError === undefined && terminalConfirmed && firstTreeConfirmed &&
        settled && rootRemoved && sqliteRemoved ?
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
    assert.equal(firstTreeConfirmed && settled, true, 'native tree or installed settlement unconfirmed');
    t.diagnostic('native tree and installed recovery settled once; zero model prompts were sent');
  });
