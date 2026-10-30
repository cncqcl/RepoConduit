import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteInvestigationStore } from '../../src/adapters/storage/investigation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { DispatchService } from '../../src/application/dispatch.js';
import { RepositoryApplication } from '../../src/application/repository.js';
import { authorize } from '../../src/core/policy/authorize.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';
import { attachPrivateFifo, preparePrivateFifo } from '../../src/runtime/investigation-private-fifo.js';

const wsl = 'C:\\Windows\\System32\\wsl.exe';
const distro = 'Ubuntu-22.04';
const linuxUser = 'fixture';

// Client does JSON-RPC over the sandbox-facing FIFOs; model stdin/stdout never carry MCP.
const client = String.raw`
import json, os, sys, time
directory, workspace, snapshot = sys.argv[1:4]
read_fd = os.open(directory + '/in', os.O_RDONLY | os.O_NONBLOCK)
write_fd = os.open(directory + '/out', os.O_WRONLY)
buffer = b''
def exchange(value, expected):
    global buffer
    os.write(write_fd, json.dumps(value, separators=(',', ':')).encode() + b'\n')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try: data = os.read(read_fd, 65536)
        except BlockingIOError: data = b''
        if data: buffer += data
        if b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            response = json.loads(line)
            if response.get('id') == expected: return response
        time.sleep(.01)
    raise TimeoutError('MCP response')
init = exchange({'jsonrpc':'2.0','id':1,'method':'initialize','params':{
    'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'fifo-test','version':'1'}}}, 1)
os.write(write_fd, b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
def read(ident, path):
    return exchange({'jsonrpc':'2.0','id':ident,'method':'tools/call','params':{
      'name':'repo.read','arguments':{'scope':{'workspaceId':workspace,'collaborationId':'col-a'},
      'payload':{'workingCopyId':'wc-a','snapshotId':snapshot,'path':path}}}}, ident)
allowed = read(2, 'src/entry.ts')
denied = read(3, 'src/hidden.ts')
print(json.dumps({'init':init,'allowed':allowed,'denied':denied}), flush=True)
line = sys.stdin.readline().strip()
if line == 'after-revoke':
    revoked = read(4, 'src/entry.ts')
    print(json.dumps({'revoked':revoked}), flush=True)
os.close(write_fd); os.close(read_fd)
`;

for (const gateKind of ['native_supervisor_v2', 'claude_model_v1'] as const) {
test(`durable ${gateKind} claim serves scoped MCP through real WSL FIFO and denies revoked reads`,
  { timeout: 30000 }, async t => {
    if (process.platform !== 'win32') { t.skip('Windows WSL only'); return; }
    let info: { uid: number; boot: string };
    try {
      const output = execFileSync(wsl, ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec',
        '/usr/bin/python3', '-c',
        "import os,json;print(json.dumps({'uid':os.getuid(),'boot':open('/proc/sys/kernel/random/boot_id').read().strip()}))"],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      info = JSON.parse(output.slice(output.lastIndexOf('{')).trim()) as { uid: number; boot: string };
    } catch { t.skip('private WSL fixture unavailable'); return; }
    const dir = mkdtempSync(join(tmpdir(), 'rcac-fifo-runtime-'));
    const dbFile = join(dir, 'state.sqlite');
    const root = `/home/${linuxUser}/.local/share/rcac-fifo-runtime-${randomUUID()}`;
    execFileSync(wsl, ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec',
      '/usr/bin/python3', '-c', 'import os,sys;os.mkdir(sys.argv[1],0o700)', root],
    { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    const base = new SqliteStore(dbFile);
    const workspaceId = `ws_${randomUUID()}`;
    const workerId = `worker_${randomUUID()}`;
    const now = new Date();
    let store: SqliteInvestigationStore | undefined;
    let transport: Awaited<ReturnType<typeof attachPrivateFifo>> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let childClosed: Promise<number | null> | undefined;
    let normalPeerExit = false;
    try {
      base.insertWorkspace({ id: workspaceId, name: 'Fixture', canonicalRoot: dir, registeredBy: 'owner' });
      base.insertCollaboration({ id: 'col-a', workspaceId, openedBy: 'owner', purpose: 'read',
        hostThreadId: null, state: 'open' });
      base.insertWorkingCopy({ id: 'wc-a', workspaceId, canonicalRoot: dir });
      const snapshot = createSnapshotFromFiles('wc-a', 'synthetic-commit', {
        'src/entry.ts': Buffer.from('export const allowed = "FIFO_ALLOWED";\n'),
        'src/hidden.ts': Buffer.from('export const hidden = "FIFO_DENIED";\n'),
      }).toPersisted();
      await base.saveSnapshot({ workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a', snapshot },
        { workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a', commitRef: 'synthetic-commit' },
        'capture', 'owner', 'local_cli');
      base.insertGrant({ id: 'request', principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user',
        workspaceId, collaborationId: 'col-a', permissions: ['investigation.request'], expiresAt: null, revokedAt: null });
      base.insertGrant({ id: 'original-read', principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user',
        workspaceId, collaborationId: 'col-a', permissions: ['data.read'], dataPaths: ['src/entry.ts'],
        expiresAt: null, revokedAt: null });
      base.insertGrant({ id: 'worker-read', principal: workerId, audience: 'investigator-ipc', recipient: 'local-worker',
        workspaceId, collaborationId: 'col-a', permissions: ['data.read'], dataPaths: ['src/entry.ts'],
        expiresAt: new Date(now.getTime() + 60000).toISOString(), revokedAt: null });
      const record: InvestigationRecord = { id: 'inv-a', workspaceId, collaborationId: 'col-a', workingCopyId: 'wc-a',
        principal: 'external-a', audience: 'chatgpt', recipient: 'chatgpt-user', grantId: 'request',
        profileRef: 'verified-test', budgetRef: 'bounded-test',
        budget: { maxWallSeconds: 60, maxTurns: 2, maxToolCalls: 5 },
        contextRevisionId: 'ctx-a', snapshotRef: snapshot.id, question: 'Trace entry',
        scope: { paths: ['src/entry.ts'], symbols: [], relatedTests: [] }, requestedOutputs: ['flow'],
        parentInvestigationId: null, state: 'queued', cancelRequested: false, attempts: [], result: null,
        createdAt: now.toISOString() };
      store = new SqliteInvestigationStore(dbFile, { verifyIsolation: () => true,
        verifyNativeReceipt: () => true, verifyOutcomeReceipt: () => true,
        verifyModelRunningReceipt: () => true });
      store.enqueue(record, 'submit', 'fingerprint');
      let claim = store.claimRequest(record.id, { workerId, isolationEvidence: 'synthetic-only',
        profileRevision: 'verified-test', permissionEpoch: 0, launchProtocol: 'resource_reservation_v1', now })!;
      const unitName = `rcac-investigator-${randomUUID()}.service`;
      claim = store.reserveWslResource(claim, { unitName, distro, uid: info.uid, bootId: info.boot,
        gate: { protocol: 'attempt_gate_v1', linuxUser, root, payloadKind: gateKind,
          launch: { workerEpoch: claim.workerEpoch, sourceDigest: 'a'.repeat(64),
            profileDigest: 'b'.repeat(64), action: gateKind === 'claude_model_v1' ? 'claude_model_v1' : 'fixed_zero_model_v1',
            ...(gateKind === 'claude_model_v1' ? { commandDigest: 'c'.repeat(64) } : {}) } } }, now);
      const prepared = await preparePrivateFifo({ store, claim });
      assert.equal(prepared.directory, `${root}/${claim.attemptId}-${claim.workerEpoch}.mcp`);
      // Synthetic native/isolation verifier: this does not prove a real native model unit.
      claim = store.observeWslResource(claim, { invocationId: 'a'.repeat(32),
        controlGroup: `/user.slice/user-${info.uid}.slice/user@${info.uid}.service/app.slice/${unitName}` }, now);
      claim = store.recordNativeStart(claim, 'synthetic-native-ref', 'synthetic-receipt', now);
      const repository = new RepositoryApplication({
        authorize: async request => {
          await request.context.assertFreshAuthority?.();
          const context = { ...request.context, now: new Date() };
          return authorize(context, request.operation, { workspaceId: request.workspaceId,
            collaborationId: request.collaborationId }, base.grantsFor(context.principal, context.audience));
        },
        getWorkingCopy: (ws, wc) => base.getWorkingCopy(ws, wc),
        collaborationBelongsToWorkspace: (ws, col) => base.collaborationBelongsToWorkspace(ws, col),
        lookupCapture: (input, key, principal, audience) => base.lookupCapture(input, key, principal, audience),
        saveSnapshot: (saved, input, key, principal, audience) => base.saveSnapshot(saved, input, key, principal, audience),
        getSnapshot: (id, ws, col) => base.getSnapshot(id, ws, col),
      });
      const dispatcher = new DispatchService(base, undefined, undefined, { repository });
      if (gateKind === 'claude_model_v1') {
        await assert.rejects(attachPrivateFifo({ claim, store, workerGrantId: 'worker-read',
          workerAudience: 'investigator-ipc', workerRecipient: 'local-worker', dispatcher }));
        store.recordModelRunningFact(claim, { protocol: 'claude_model_v1', action: 'claude_model_v1',
          phase: 'entered', closed: false, attemptId: claim.attemptId, workspaceId,
          bootId: info.boot, uid: info.uid, unitName, launchWorkerEpoch: claim.workerEpoch,
          sourceDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), commandDigest: 'c'.repeat(64),
          invocationId: claim.wslResource!.invocationId!, controlGroup: claim.wslResource!.controlGroup!,
          enterPid: 123, enterStartTicks: 456 }, 'synthetic-only', now);
      }
      await assert.rejects(attachPrivateFifo({ claim: { ...claim, workerEpoch: claim.workerEpoch + 1 },
        store, workerGrantId: 'worker-read', workerAudience: 'investigator-ipc',
        workerRecipient: 'local-worker', dispatcher }), /NOT_AVAILABLE/);
      transport = await attachPrivateFifo({ claim, store, workerGrantId: 'worker-read',
        workerAudience: 'investigator-ipc', workerRecipient: 'local-worker', dispatcher });
      child = spawn(wsl, ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec',
        '/usr/bin/python3', '-I', '-S', '-c', client, prepared.directory, workspaceId, snapshot.id],
      { stdio: ['pipe', 'pipe', 'pipe'] });
      childClosed = new Promise(resolve => child!.once('close', resolve));
      assert.ok(child.stdin && child.stdout);
      const lines: string[] = [];
      let text = '';
      child.stdout.on('data', (part: Buffer) => { text += part.toString();
        for (;;) { const index = text.indexOf('\n'); if (index < 0) break;
          lines.push(text.slice(0, index)); text = text.slice(index + 1); } });
      const waitLine = async (count: number) => {
        const deadline = Date.now() + 10000;
        while (lines.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(lines.length >= count, 'MCP client response timeout');
        return JSON.parse(lines[count - 1]!) as Record<string, unknown>;
      };
      const first = await waitLine(1);
      assert.match(JSON.stringify(first.init), /protocolVersion/);
      assert.match(JSON.stringify(first.allowed), /FIFO_ALLOWED/);
      assert.doesNotMatch(JSON.stringify(first.denied), /FIFO_DENIED/);
      base.revokeGrant('worker-read', new Date().toISOString());
      await Promise.race([transport.closed, new Promise((_, reject) =>
        setTimeout(() => reject(new Error('idle revocation did not close transport')), 3000))]);
      assert.equal(lines.length, 1);
      await transport.closeTransport();
      assert.equal(store.listUnsettled()[0]?.phase, 'started');
      child.stdin.end();
      normalPeerExit = (await childClosed) === 0;
      assert.ok(normalPeerExit);
    } finally {
      child?.kill();
      const childExit = childClosed ? await Promise.race([childClosed,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2000))]) : 0;
      const transportStopped = await transport?.closeTransport().then(() => true, () => false) ?? true;
      store?.close(); base.close(); rmSync(dir, { recursive: true, force: true });
      if (transportStopped && normalPeerExit && childExit !== null) execFileSync(wsl,
        ['-d', distro, '--user', linuxUser, '--cd', '/', '--exec', '/usr/bin/python3', '-c',
          'import shutil,sys;shutil.rmtree(sys.argv[1])', root],
        { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  });
}
