import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposeDecision } from '../../src/core/collaboration/decision.js';
import type { Permit } from '../../src/core/policy/authorize.js';

const permit: Permit = { grantId:'external-grant', operation:'decision.propose', effect:'state_write',
  scope:{workspaceId:'ws-a',collaborationId:'col-a'}, principal:'external', recipient:'mcp' };
const input = { id:'suggestion-1', workspaceId:'ws-a', collaborationId:'col-a',
  contextRevisionId:'ctx-1', snapshotId:'snap-1', recommendation:'modify' as const,
  reason:'Review the cited evidence', proposedBy:'external' };

test('decision suggestion is bounded and carries no local approval authority', () => {
  const result=proposeDecision(input,permit);
  assert.equal(result.kind,'decision_proposal');
  assert.equal(result.implementationAuthorized,false);
  assert.equal('decidedBy' in result,false);
  for (const changed of [
    {...input,id:123}, {...input,id:'x'.repeat(129)},
    {...input,reason:'🙂'.repeat(4097)},
    {...input,bundleId:'bundle'},
    {...input,bundleId:'bundle',bundleManifestHash:1},
    {...input,bundleId:'bundle',bundleManifestHash:'A'.repeat(64)},
    {...input,implementationAuthorized:true},
    {...input,proposedBy:'owner'},
  ]) assert.throws(()=>proposeDecision(changed as never,permit),/NOT_AVAILABLE/);
});
