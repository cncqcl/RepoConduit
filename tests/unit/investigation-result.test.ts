import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInvestigationResult } from '../../src/core/investigation/result.js';
import { validateInvestigationResultEvidence } from '../../src/runtime/claude-model-investigation.js';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { createHash } from 'node:crypto';

const valid = () => ({ kind: 'investigation_result_v1', requestId: 'r', attemptId: 'a',
  resultState: 'completed', snapshotRef: 's', contextRevisionId: 'c',
  findings: [{ statement: 'The file contains a value.', classification: 'source_confirmed', evidenceRefs: ['receipt-1'] }],
  evidence: [{ path: 'src/a.ts', symbol: null, lineRange: [1, 1], byteRange: [0, 5],
    contentHash: 'a'.repeat(64), excerpt: 'value', toolReceipt: 'receipt-1' }],
  coverage: { searchedScope: ['src/a.ts'], excludedCategories: [], truncated: false, missingDependencies: [] },
  openQuestions: [], limitsAndWarnings: [] });

test('v1 result parser accepts a closed bounded completed result and rejects duplicate keys', () => {
  const parsed = parseInvestigationResult(JSON.stringify(valid()));
  assert.equal(parsed.evidence[0]?.toolReceipt, 'receipt-1');
  assert.throws(() => parseInvestigationResult(JSON.stringify(valid()).replace('"requestId":"r"',
    '"requestId":"r","requestId":"other"')));
  assert.throws(() => parseInvestigationResult(JSON.stringify({ ...valid(), extra: true })));
  assert.throws(() => parseInvestigationResult(JSON.stringify({ ...valid(), resultState: 'failed' })));
  assert.throws(() => parseInvestigationResult(JSON.stringify({ ...valid(), findings: [{
    statement: 'tool did X', classification: 'tool_observed', evidenceRefs: ['receipt-1'] }] })));
  assert.throws(() => parseInvestigationResult(JSON.stringify({ ...valid(), findings: [{
    statement: 'unsupported source claim', classification: 'source_confirmed', evidenceRefs: [] }] })));
  assert.throws(() => parseInvestigationResult(JSON.stringify(valid()).replace(
    '"statement":"The file contains a value."',
    '"statement":"The file contains a value.","statement":"duplicate"')));
  assert.equal(parseInvestigationResult(JSON.stringify({...valid(),evidence:[{
    ...valid().evidence[0],excerpt:'  \n'}]})).evidence[0]?.excerpt,'  \n');
});

test('one trusted read receipt supports multiple exact excerpts without weakening each evidence check', () => {
  const bytes = Buffer.from('alpha\nbeta\n');
  const snapshot = createSnapshotFromFiles('wc', 'commit', {'src/a.ts': bytes});
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const binding = {requestId:'r',attemptId:'a',workspaceId:'ws',collaborationId:'col',
    workingCopyId:'wc',snapshotId:snapshot.id,contextRevisionId:'c',launchEpoch:1,
    intentId:'intent',threadId:'thread',turnId:'turn',workerPrincipal:'worker',
    workerAudience:'investigator',workerRecipient:'local',workerGrantId:'grant'};
  const receipt = {...binding,id:'receipt-1',callId:'read-call',path:'src/a.ts',fullContentHash:contentHash,
    byteRange:[0,bytes.length] as [number,number],lineRange:[1,2] as [number,number],
    pageContentHash:contentHash,completeness:'complete' as const,
    reservedAt:'2026-10-21T05:00:00.000Z',observedAt:'2026-10-21T05:00:00.001Z'};
  const candidate = {...valid(),snapshotRef:snapshot.id,
    findings:[{statement:'Both source lines were read.',classification:'source_confirmed',
      evidenceRefs:['receipt-1']}],evidence:[
      {...valid().evidence[0]!,contentHash,excerpt:'alpha',lineRange:[1,1],byteRange:[0,5]},
      {...valid().evidence[0]!,contentHash,excerpt:'beta',lineRange:[2,2],byteRange:[6,10]},
    ]};
  const parsed = parseInvestigationResult(JSON.stringify(candidate));
  assert.equal(parsed.evidence.length,2);
  assert.doesNotThrow(() => validateInvestigationResultEvidence(parsed,[receipt],snapshot,binding));
  for (const change of [
    {excerpt:'betx'}, {byteRange:[6,12] as [number,number]},
    {lineRange:[1,1] as [number,number]}, {path:'src/b.ts'},
    {contentHash:'0'.repeat(64)}, {toolReceipt:'unknown-receipt'},
  ]) {
    const corrupted = structuredClone(parsed);
    Object.assign(corrupted.evidence[1]!,change);
    assert.throws(() => validateInvestigationResultEvidence(corrupted,[receipt],snapshot,binding));
  }
  assert.throws(() => validateInvestigationResultEvidence(parsed,[receipt,receipt],snapshot,binding));
  assert.throws(() => parseInvestigationResult(JSON.stringify({...candidate,evidence:[]})));
  assert.throws(() => parseInvestigationResult(JSON.stringify({...candidate,
    evidence:Array.from({length:41},()=>candidate.evidence[0])})));
  assert.throws(() => parseInvestigationResult(JSON.stringify({...candidate,
    findings:[{...candidate.findings[0],evidenceRefs:['receipt-1','receipt-1']}]})));
  assert.throws(() => parseInvestigationResult(JSON.stringify({...candidate,
    findings:[{...candidate.findings[0],evidenceRefs:['unknown-receipt']}]})));
});

test('snapshot and successful page receipt must bound each evidence byte and exact line', () => {
  const bytes = Buffer.from('alpha\r\nbeta\n');
  const snapshot = createSnapshotFromFiles('wc', 'commit', {'src/a.ts': bytes});
  const candidate = valid(); candidate.snapshotRef = snapshot.id;
  candidate.evidence[0]!.contentHash = createHash('sha256').update(bytes).digest('hex');
  candidate.evidence[0]!.excerpt = 'beta';
  candidate.evidence[0]!.byteRange = [7, 11];
  candidate.evidence[0]!.lineRange = [2, 2];
  candidate.coverage.truncated = true;
  const read = {id: 'receipt-1', requestId: 'r', attemptId: 'a', workspaceId: 'ws',
    collaborationId: 'col', workingCopyId: 'wc', snapshotId: snapshot.id,
    contextRevisionId: 'c', launchEpoch: 1, nativeRef: 'native', workerPrincipal: 'worker',
    workerAudience: 'investigator', workerRecipient: 'local', workerGrantId:'grant', path: 'src/a.ts',
    fullContentHash: candidate.evidence[0]!.contentHash, byteRange: [7, 12] as [number, number],
    lineRange: [2, 2] as [number, number],
    pageContentHash: createHash('sha256').update('beta\n').digest('hex'),
    completeness: 'complete' as const, reservedAt: new Date().toISOString(),
    observedAt: new Date().toISOString()};
  const trusted = {requestId:'r', attemptId:'a', workspaceId:'ws', collaborationId:'col',
    workingCopyId:'wc', snapshotId:snapshot.id, contextRevisionId:'c',
    launchEpoch:1, nativeRef:'native', workerPrincipal:'worker', workerAudience:'investigator',
    workerRecipient:'local',workerGrantId:'grant'};
  assert.doesNotThrow(() => validateInvestigationResultEvidence(
    parseInvestigationResult(JSON.stringify(candidate)), [read], snapshot, trusted));
  assert.throws(() => validateInvestigationResultEvidence(
    parseInvestigationResult(JSON.stringify({...candidate, evidence:[{...candidate.evidence[0], excerpt:'betx'}]})),
    [read], snapshot, trusted));
  assert.throws(() => validateInvestigationResultEvidence(
    parseInvestigationResult(JSON.stringify(candidate)),
    [{...read,pageContentHash:'0'.repeat(64)}], snapshot, trusted));
  assert.throws(() => validateInvestigationResultEvidence(
    parseInvestigationResult(JSON.stringify({...candidate,evidence:[{
      ...candidate.evidence[0],byteRange:[6,11],excerpt:'\nbeta'}]})),
    [read], snapshot, trusted));
  assert.throws(() => validateInvestigationResultEvidence(
    parseInvestigationResult(JSON.stringify({...candidate,coverage:{
      ...candidate.coverage,searchedScope:[]}})),[read],snapshot,trusted));
});
