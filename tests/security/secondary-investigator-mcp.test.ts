import assert from 'node:assert/strict';
import { test } from 'node:test';
import {createHash} from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createScopedInvestigatorMcpServer } from '../../src/adapters/secondary-investigator/scoped-mcp.js';
import { createPersistedInvestigatorMcpServer } from '../../src/adapters/secondary-investigator/persisted-mcp.js';
import type { Command } from '../../src/application/dispatch.js';
import type { RequestContext } from '../../src/core/policy/authorize.js';
import type { InvestigationClaim } from '../../src/adapters/storage/investigation-sqlite.js';
import type { InvestigationRecord } from '../../src/core/investigation/request.js';

const context: RequestContext = {
  principal: 'worker-attempt-1', audience: 'worker-local', recipient: 'worker-attempt-1',
  surface: 'external_mcp', now: new Date('2026-09-29T00:00:00Z'),
};
const ticket = {
  requestId: 'inv-1', attemptId: 'att-1', workerEpoch: 3,
  workspaceId: 'ws-a', collaborationId: 'col-a', workingCopyId: 'wc-a',
  snapshotId: 'snp-a', paths: ['src/entry.py', 'tests/test_flow.py'],
};
// A dispatcher fixture must satisfy the current public repo.read output contract;
// the security assertions below still test scope, fencing and late revocation.
function readPage(){
  const content='SYNTHETIC_ALLOWED_A';
  return {snapshotId:'snp-a',path:'src/entry.py',content,
    contentHash:createHash('sha256').update(content).digest('hex'),
    lineRange:{start:1,end:1},byteRange:{start:0,end:Buffer.byteLength(content)},
    decoding:'utf-8' as const,completeness:'complete' as const};
}

test('per-attempt MCP exposes only exact snapshot reads and rechecks the attempt around dispatch', async () => {
  const calls: Command[] = [];
  let active = true;
  let currentEpoch = ticket.workerEpoch;
  let changeAfterDispatch = false;
  const server = createScopedInvestigatorMcpServer({
    context, ticket,
    isAttemptActive: async (observed) => {
      assert.deepEqual(observed, ticket);
      return active && observed.workerEpoch === currentEpoch;
    },
    dispatcher: { async dispatch(boundContext, command) {
      await boundContext.assertFreshAuthority?.();
      calls.push(command);
      if (changeAfterDispatch) active = false;
      await boundContext.assertFreshAuthority?.();
      return readPage();
    } },
  });
  const client = new Client({ name: 'investigator-security-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const read = (workspaceId: string, collaborationId: string, workingCopyId: string,
    snapshotId: string, path: string) => client.callTool({ name: 'repo.read', arguments: {
      scope: { workspaceId, collaborationId }, payload: { workingCopyId, snapshotId, path },
    } });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map(item => item.name), ['repo.read']);
    for (const name of ['repo.search', 'investigate.submit', 'artifact.put_text', 'admin.register_workspace']) {
      await assert.rejects(client.callTool({ name, arguments: {} }));
    }
    assert.equal(calls.length, 0);
    const allowed = await read('ws-a', 'col-a', 'wc-a', 'snp-a', 'src/entry.py');
    assert.equal(allowed.isError, undefined);
    assert.match(JSON.stringify(allowed), /SYNTHETIC_ALLOWED_A/);
    assert.equal(calls.length, 1);

    for (const args of [
      ['ws-b', 'col-a', 'wc-a', 'snp-a', 'src/entry.py'],
      ['ws-a', 'col-b', 'wc-a', 'snp-a', 'src/entry.py'],
      ['ws-a', 'col-a', 'wc-b', 'snp-a', 'src/entry.py'],
      ['ws-a', 'col-a', 'wc-a', 'snp-b', 'src/entry.py'],
      ['ws-a', 'col-a', 'wc-a', 'snp-a', 'src/state.py'],
      ['ws-a', 'col-a', 'wc-a', 'snp-a', 'src/entry.py/../state.py'],
    ] as const) {
      const denied = await read(args[0], args[1], args[2], args[3], args[4]);
      assert.equal(denied.isError, true);
      assert.doesNotMatch(JSON.stringify(denied), /SYNTHETIC_ALLOWED_A/);
    }
    assert.equal(calls.length, 1);

    currentEpoch += 1;
    const staleEpoch = await read('ws-a', 'col-a', 'wc-a', 'snp-a', 'src/entry.py');
    assert.equal(staleEpoch.isError, true);
    assert.equal(calls.length, 1);
    currentEpoch = ticket.workerEpoch;

    active = false;
    const inactive = await read('ws-a', 'col-a', 'wc-a', 'snp-a', 'src/entry.py');
    assert.equal(inactive.isError, true);
    assert.equal(calls.length, 1);

    active = true;
    changeAfterDispatch = true;
    const revokedMidRead = await read('ws-a', 'col-a', 'wc-a', 'snp-a', 'src/entry.py');
    assert.equal(revokedMidRead.isError, true);
    assert.doesNotMatch(JSON.stringify(revokedMidRead), /SYNTHETIC_ALLOWED_A/);
    assert.equal(calls.length, 2);
  } finally { await client.close(); await server.close(); }
});

test('persisted MCP keeps the original claim after a caller mutates its input object', async () => {
  const claim: InvestigationClaim = { requestId: 'inv-1', attemptId: 'att-1', workerId: 'worker-1',
    workerEpoch: 1, workspaceId: 'ws-a', nativeRef: 'native-1', phase: 'started' };
  let currentEpoch = 1;
  const record = { id: 'inv-1', workspaceId: 'ws-a', collaborationId: 'col-a',
    workingCopyId: 'wc-a', snapshotRef: 'snp-a',
    scope: { paths: ['src/entry.py'], relatedTests: [] } } as unknown as InvestigationRecord;
  const options = {
    claim,
    store: { get: () => record, assertRunningReadAuthority: (observed: InvestigationClaim) => {
      if (observed.workerEpoch !== currentEpoch) throw new Error('STALE');
    }, reserveRunningRead: (observed: InvestigationClaim) => {
      if (observed.workerEpoch !== currentEpoch) throw new Error('STALE');
    } },
    workerGrantId: 'worker-read', workerAudience: 'investigator-ipc', workerRecipient: 'claude-local',
    dispatcher: { async dispatch(boundContext: RequestContext) {
      await boundContext.assertFreshAuthority?.();
      return readPage();
    } },
  };
  const server = createPersistedInvestigatorMcpServer(options);
  const client = new Client({ name: 'claim-mutation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const read = () => client.callTool({ name: 'repo.read', arguments: {
      scope: { workspaceId: 'ws-a', collaborationId: 'col-a' },
      payload: { workingCopyId: 'wc-a', snapshotId: 'snp-a', path: 'src/entry.py' },
    } });
    assert.equal((await read()).isError, undefined);
    currentEpoch = 2;
    claim.workerEpoch = 2;
    const denied = await read();
    assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /SYNTHETIC_ALLOWED_A/);
    options.claim = { ...claim, attemptId: 'att-2', workerEpoch: 2 };
    const replaced = await read();
    assert.equal(replaced.isError, true);
    assert.doesNotMatch(JSON.stringify(replaced), /SYNTHETIC_ALLOWED_A/);
  } finally { await client.close(); await server.close(); }
});
