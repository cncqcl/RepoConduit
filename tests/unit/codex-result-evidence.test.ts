import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createSnapshotFromFiles} from '../../src/adapters/repository/snapshots.js';
import {parseInvestigationResult} from '../../src/core/investigation/result.js';
import {validateInvestigationResultEvidence} from '../../src/runtime/investigation-result-evidence.js';

test('Codex evidence requires exact native tuple and actual successful page bytes without a fabricated process identity',()=>{
 const bytes=Buffer.from('answer\n');
 const snapshot=createSnapshotFromFiles('copy','commit',{'src/a.ts':bytes});
 const digest=createHash('sha256').update(bytes).digest('hex');
 const binding={requestId:'request',attemptId:'attempt',workspaceId:'ws',collaborationId:'col',
  workingCopyId:'copy',snapshotId:snapshot.id,contextRevisionId:'ctx',launchEpoch:1,
  threadId:'thread',turnId:'turn',intentId:'intent',workerPrincipal:'worker',
  workerAudience:'investigator',workerRecipient:'local',workerGrantId:'worker-grant'};
 const receipt={...binding,id:'receipt',callId:'call',path:'src/a.ts',fullContentHash:digest,
  byteRange:[0,7] as [number,number],lineRange:[1,1] as [number,number],pageContentHash:digest,
  completeness:'complete' as const,reservedAt:'2026-10-03T00:00:00.000Z',observedAt:'2026-10-03T00:00:00.001Z'};
 const result=parseInvestigationResult(JSON.stringify({kind:'investigation_result_v1',requestId:'request',
  attemptId:'attempt',snapshotRef:snapshot.id,contextRevisionId:'ctx',resultState:'completed',findings:[],
  evidence:[{path:'src/a.ts',symbol:null,lineRange:[1,1],byteRange:[0,6],contentHash:digest,
   excerpt:'answer',toolReceipt:'receipt'}],coverage:{searchedScope:['src/a.ts'],
   excludedCategories:[],truncated:false,missingDependencies:[]},openQuestions:[],limitsAndWarnings:[]}));
 assert.doesNotThrow(()=>validateInvestigationResultEvidence(result,[receipt],snapshot,binding));
 for(const mutation of [{threadId:'other'},{turnId:'other'},{intentId:'other'},{launchEpoch:2},
  {workerGrantId:'other'},{pageContentHash:'0'.repeat(64)}])
  assert.throws(()=>validateInvestigationResultEvidence(result,[{...receipt,...mutation}],snapshot,binding));
 assert.throws(()=>validateInvestigationResultEvidence(result,[{...receipt,nativeRef:'fake'}],snapshot,binding));
 assert.throws(()=>validateInvestigationResultEvidence(result,[],snapshot,binding));
});
