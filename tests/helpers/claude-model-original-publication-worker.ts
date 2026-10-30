import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, preparedOutcome } from './claude-model-original-publication-fixture.js';

// Test-only subprocess: synthetic model/tree inputs, production SQLite settlement.
const stage = process.argv[2] ?? '';
const parentDir = process.argv[3] ?? '';
const triggers: Record<string,string> = {
  tree:'AFTER INSERT ON investigation_model_tree_facts',
  provenance:'AFTER INSERT ON investigation_model_outcome_provenance',
  record:'AFTER UPDATE ON investigation_requests',
  outbox:'AFTER DELETE ON investigation_outbox',
  slot:'AFTER DELETE ON investigation_active_attempts',
};
if (!parentDir || (stage !== 'committed' && !triggers[stage]))
  throw new Error('Invalid test worker input');

const f = fixture({parentDir});
const {claim,observation,treeReceipt,verified} = await preparedOutcome(f);
function publishMarker(name: string, value: unknown) {
  const temporary=join(parentDir,`${name}.tmp`);
  writeFileSync(temporary,JSON.stringify(value),{flag:'wx'});
  renameSync(temporary,join(parentDir,name));
}
publishMarker('ready.json',{
  pid:process.pid,file:f.file,dir:f.dir,requestId:claim.requestId,stage});

if (stage !== 'committed') {
  // DatabaseSync.function is connection-local. Register on the production store
  // connection so its trigger runs inside settleClaudeModelOriginalOutcome.
  const db = (f.store as unknown as {db:DatabaseSync}).db;
  db.function('test_original_crash_marker', () => {
    publishMarker('stage.json',{pid:process.pid,stage});
    const status = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20_000);
    if (status === 'timed-out') throw new Error('Parent did not terminate owned worker');
    return 1;
  });
  db.exec(`CREATE TRIGGER test_original_crash_stage ${triggers[stage]}
    BEGIN SELECT test_original_crash_marker(); END`);
}

f.store.settleClaudeModelOriginalOutcome(claim,observation,treeReceipt,verified,f.now);
if (stage === 'committed')
  publishMarker('committed.json',{pid:process.pid,stage});
f.closeStore();
f.base.close();
