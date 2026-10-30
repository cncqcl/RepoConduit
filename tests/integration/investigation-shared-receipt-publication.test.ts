import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {fixture, preparedOutcome, publicationRows} from
  '../helpers/claude-model-original-publication-fixture.js';

test('one original Claude read can support two exact excerpts under a one-call budget', async () => {
  const f = fixture({maxToolCalls:1});
  try {
    const {claim,observation,treeReceipt,verified} = await preparedOutcome(f,
      {splitEvidence:true});
    assert.equal(f.store.getSucceededReadReceipts(claim).length,1);
    assert.equal(verified.result.evidence.length,2);
    assert.deepEqual(verified.evidenceReceiptIds,
      verified.result.evidence.map(item=>item.toolReceipt));
    assert.equal(new Set(verified.evidenceReceiptIds).size,1);
    const settled = f.store.settleClaudeModelOriginalOutcome(claim,observation,
      treeReceipt,verified,f.now);
    assert.equal(settled.state,'completed');
    assert.equal(settled.result?.evidence.length,2);
    assert.deepEqual(settled.result?.evidence.map(item=>item.toolReceipt),
      verified.evidenceReceiptIds);
    assert.deepEqual(publicationRows(f.file,claim.requestId),
      {tree:1,provenance:1,slot:0,outbox:0});
    f.closeStore();
    const reopened = new SqliteInvestigationStore(f.file);
    try {
      assert.equal(reopened.get(claim.requestId)?.state,'completed');
      assert.deepEqual(reopened.get(claim.requestId)?.result?.evidence.map(item=>item.toolReceipt),
        verified.evidenceReceiptIds);
      assert.equal(reopened.listUnsettled().length,0);
    } finally {reopened.close();}
  } finally {f.close();}
});
