import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { privateFifoSpec } from '../../src/adapters/secondary-investigator/wsl-private-fifo.js';
import { runPrivateFifoPrepare, runPrivateFifoRelay } from '../../src/adapters/secondary-investigator/wsl-private-fifo-runner.js';
import { attachPrivateFifo, preparePrivateFifo } from '../../src/runtime/investigation-private-fifo.js';
import type { InvestigationClaim, SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import type { DispatchService } from '../../src/application/dispatch.js';

test('private FIFO spec uses fixed WSL Python command and refuses unsafe identity', () => {
  const binding = { attemptId: 'attempt_11111111-1111-4111-8111-111111111111',
    workspaceId: 'ws-test', workerEpoch: 3, root: '/home/fixture/private-gates',
    distro: 'Ubuntu', linuxUser: 'fixture', uid: 1000, bootId: '11111111-1111-4111-8111-111111111111',
    unitName: 'rcac-investigator-11111111-1111-4111-8111-111111111111.service',
    invocationId: null, controlGroup: null, deadlineEpochMs: 0 };
  const spec = privateFifoSpec('prepare', binding);
  assert.equal(spec.executable, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(spec.args.slice(0, 8), ['-d', 'Ubuntu', '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3']);
  assert.deepEqual(spec.args.slice(8, 11), ['-I', '-S', '-c']);
  assert.ok(!spec.args.includes('sh'));
  assert.throws(() => privateFifoSpec('prepare', { ...binding, root: '/home/fixture/../other' }));
  assert.throws(() => privateFifoSpec('prepare', { ...binding, attemptId: '../other' }));
  assert.throws(() => privateFifoSpec('prepare', { ...binding, controlGroup: '/other' }));
  assert.throws(() => privateFifoSpec('relay', binding));
});

test('stale or unstarted durable attempt is rejected before any native I/O', async () => {
  const claim: InvestigationClaim = { requestId: 'inv', attemptId: 'attempt_11111111-1111-4111-8111-111111111111',
    workerId: 'worker', workerEpoch: 1, workspaceId: 'ws-one', nativeRef: null,
    phase: 'start_intent', wslResource: { distro: 'Ubuntu-22.04', uid: 1000,
      bootId: '11111111-1111-4111-8111-111111111111', unitName: 'rcac-test.service',
      invocationId: null, controlGroup: null,
      gate: { protocol: 'attempt_gate_v1', linuxUser: 'fixture', root: '/home/fixture/private',
        payloadKind: 'native_supervisor_v2', launch: { workerEpoch: 1, sourceDigest: 'a'.repeat(64),
          profileDigest: 'b'.repeat(64), action: 'fixed_zero_model_v1' } } } };
  let nativeAuthorityCalls = 0;
  const store = { listUnsettled: () => [claim], get: () => null,
    assertRunningReadAuthority: () => { nativeAuthorityCalls++; },
    reserveRunningRead: () => { nativeAuthorityCalls++; },
    preflightSourceRead: () => { nativeAuthorityCalls++; } } as unknown as SqliteInvestigationStore;
  const options = { claim, store, workerGrantId: 'grant', workerAudience: 'worker',
    workerRecipient: 'local', dispatcher: {} as DispatchService };
  await assert.rejects(attachPrivateFifo(options), /NOT_AVAILABLE/);
  await assert.rejects(preparePrivateFifo({ store, claim: { ...claim, workerEpoch: 2 } }), /NOT_AVAILABLE/);
  await assert.rejects(preparePrivateFifo({ store, claim: { ...claim,
    wslResource: { ...claim.wslResource!, gate: { ...claim.wslResource!.gate!, root: '/home/fixture/other' } } } }), /NOT_AVAILABLE/);
  assert.equal(nativeAuthorityCalls, 0);
});

test('real WSL relay keeps MCP bytes off control stderr and rejects reconnect', { timeout: 20000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows WSL only'); return; }
  const distro = 'Ubuntu-22.04';
  let info: { uid: number; boot: string };
  try {
    const output = execFileSync('C:\\Windows\\System32\\wsl.exe', ['-d', distro,
      '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3', '-c',
      "import os,json;print(json.dumps({'uid':os.getuid(),'boot':open('/proc/sys/kernel/random/boot_id').read().strip()}))"],
    { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    info = JSON.parse(output.slice(output.lastIndexOf('{')).trim()) as { uid: number; boot: string };
  } catch (error) { t.skip(`private WSL fixture unavailable: ${String(error).slice(0, 120)}`); return; }
  const id = randomUUID();
  const root = `/home/fixture/.local/share/rcac-fifo-test-${id}`;
  const unitName = `rcac-test-${id}.service`;
  const base = { attemptId: `attempt_${id}`, workspaceId: `ws_${id}`, workerEpoch: 1,
    root, distro, linuxUser: 'fixture', uid: info.uid, bootId: info.boot,
    unitName, invocationId: null, controlGroup: null, deadlineEpochMs: 0 };
  const wsl = 'C:\\Windows\\System32\\wsl.exe';
  execFileSync(wsl, ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec',
    '/usr/bin/python3', '-c', 'import os,sys;os.mkdir(sys.argv[1],0o700)', root], { timeout: 4000 });
  let relay: Awaited<ReturnType<typeof runPrivateFifoRelay>> | undefined;
  let helper: ReturnType<typeof spawn> | undefined;
  let helperClosed: Promise<number | null> | undefined;
  try {
    await runPrivateFifoPrepare(base);
    const markerFact = execFileSync(wsl, ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec',
      '/usr/bin/python3', '-I', '-S', '-c',
      "import os,stat,sys; p=sys.argv[1]+'/helper.lock'; s=os.stat(p,follow_symlinks=False); assert stat.S_ISREG(s.st_mode) and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and s.st_size==1; assert open(p,'rb').read()==b'0'; print('prepared')",
      `${root}/${base.attemptId}-1.mcp`], { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(markerFact.trim(), 'prepared');
    const live = { ...base, invocationId: 'a'.repeat(32), deadlineEpochMs: Date.now() + 30000,
      controlGroup: `/user.slice/user-${info.uid}.slice/user@${info.uid}.service/app.slice/${unitName}` };
    relay = await runPrivateFifoRelay(live);
    await assert.rejects(runPrivateFifoRelay(live));
    helper = spawn(wsl, ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3', '-c',
      "import os,sys; p=sys.argv[1]; i=os.open(p+'/in',os.O_RDONLY); b=os.read(i,128); os.close(i); o=os.open(p+'/out',os.O_WRONLY); os.write(o,b'REPLY:'+b); os.close(o)",
      `${root}/${base.attemptId}-1.mcp`], { stdio: ['ignore', 'pipe', 'pipe'] });
    helperClosed = new Promise(resolve => helper!.once('close', resolve));
    const chunks: Buffer[] = [];
    relay.child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(relay.child.exitCode, null, 'connected idle relay exited before request budget');
    relay.child.stdin.end('MCP_CANARY\n');
    await relay.closed;
    assert.equal(Buffer.concat(chunks).toString(), 'REPLY:MCP_CANARY\n');
    assert.equal(await helperClosed, 0);
    assert.equal((helper.stdout?.read() as Buffer | null)?.length ?? 0, 0);
  } finally {
    const relayStopped = await relay?.closeTransport().then(() => true, () => false) ?? true;
    if (helper && !helper.killed) helper.kill();
    const helperExit = helperClosed ? await Promise.race([helperClosed,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 2000))]) : 0;
    if (relayStopped && helperExit !== null) execFileSync(wsl,
      ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3', '-c',
        'import shutil,sys;shutil.rmtree(sys.argv[1])', root],
      { timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
});

test('real relay drains and exits when host input closes while FIFO peer stays idle',
  { timeout: 20000 }, async t => {
    if (process.platform !== 'win32') { t.skip('Windows WSL only'); return; }
    const wsl = 'C:\\Windows\\System32\\wsl.exe';
    const distro = 'Ubuntu-22.04';
    let info: { uid: number; boot: string };
    try {
      const output = execFileSync(wsl, ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec',
        '/usr/bin/python3', '-c',
        "import os,json;print(json.dumps({'uid':os.getuid(),'boot':open('/proc/sys/kernel/random/boot_id').read().strip()}))"],
      { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      info = JSON.parse(output.slice(output.lastIndexOf('{')).trim()) as { uid: number; boot: string };
    } catch { t.skip('private WSL fixture unavailable'); return; }
    const id = randomUUID();
    const root = `/home/fixture/.local/share/rcac-fifo-idle-${id}`;
    execFileSync(wsl, ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec',
      '/usr/bin/python3', '-c', 'import os,sys;os.mkdir(sys.argv[1],0o700)', root],
    { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    const unitName = `rcac-test-${id}.service`;
    const binding = { attemptId: `attempt_${id}`, workspaceId: `ws_${id}`, workerEpoch: 1,
      root, distro, linuxUser: 'fixture', uid: info.uid, bootId: info.boot, unitName,
      invocationId: null, controlGroup: null, deadlineEpochMs: 0 };
    let relay: Awaited<ReturnType<typeof runPrivateFifoRelay>> | undefined;
    let peer: ReturnType<typeof spawn> | undefined;
    let peerClosed: Promise<number | null> | undefined;
    try {
      await runPrivateFifoPrepare(binding);
      relay = await runPrivateFifoRelay({ ...binding, invocationId: 'b'.repeat(32),
        deadlineEpochMs: Date.now() + 30000,
        controlGroup: `/user.slice/user-${info.uid}.slice/user@${info.uid}.service/app.slice/${unitName}` });
      peer = spawn(wsl, ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3', '-c',
        "import os,sys,time;p=sys.argv[1];a=os.open(p+'/in',os.O_RDONLY|os.O_NONBLOCK);b=os.open(p+'/out',os.O_WRONLY);print('ready',flush=True);time.sleep(15)",
        `${root}/${binding.attemptId}-1.mcp`], { stdio: ['ignore', 'pipe', 'pipe'] });
      peerClosed = new Promise(resolve => peer!.once('close', resolve));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('peer readiness')), 5000);
        peer!.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
      });
      relay.child.stdin.end();
      await Promise.race([relay.closed, new Promise((_, reject) =>
        setTimeout(() => reject(new Error('idle relay did not exit')), 4000))]);
      peer.kill();
      await peerClosed;
      peer = undefined; peerClosed = undefined;
      await runPrivateFifoPrepare({ ...binding, workerEpoch: 2 });
      relay = await runPrivateFifoRelay({ ...binding, workerEpoch: 2,
        invocationId: 'c'.repeat(32), deadlineEpochMs: Date.now() + 30000,
        controlGroup: `/user.slice/user-${info.uid}.slice/user@${info.uid}.service/app.slice/${unitName}` });
      peer = spawn(wsl, ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3', '-c',
        "import os,sys,time;p=sys.argv[1];a=os.open(p+'/in',os.O_RDONLY|os.O_NONBLOCK);b=os.open(p+'/out',os.O_WRONLY);print('ready',flush=True);\ntry:\n while True:\n  os.write(b,b'X'*1024);time.sleep(.005)\nexcept BrokenPipeError: pass",
        `${root}/${binding.attemptId}-2.mcp`], { stdio: ['ignore', 'pipe', 'pipe'] });
      peerClosed = new Promise(resolve => peer!.once('close', resolve));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('writer readiness')), 5000);
        peer!.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
      });
      relay.child.stdout.resume();
      relay.child.stdin.end();
      await Promise.race([relay.closed, new Promise((_, reject) =>
        setTimeout(() => reject(new Error('continuous writer kept relay alive')), 4000))]);
    } finally {
      const relayStopped = await relay?.closeTransport().then(() => true, () => false) ?? true;
      peer?.kill();
      const peerExit = peerClosed ? await Promise.race([peerClosed,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2000))]) : 0;
      if (relayStopped && peerExit !== null) execFileSync(wsl,
        ['-d', distro, '--user', 'fixture', '--cd', '/', '--exec', '/usr/bin/python3', '-c',
          'import shutil,sys;shutil.rmtree(sys.argv[1])', root],
        { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  });
