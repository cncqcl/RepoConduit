import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProfileConfiguration } from '../../src/core/investigation/trusted-profile.js';

const valid={workspaceId:'ws-profile',expectedRevisionId:null,presetRef:'static_readonly_v1',
  budget:{maxWallSeconds:600,maxTurns:8,maxToolCalls:40}};

test('static read-only profile accepts only bounded positive safe integer budgets', () => {
  assert.deepEqual(parseProfileConfiguration(valid),valid);
  assert.deepEqual(parseProfileConfiguration({...valid,budget:{maxWallSeconds:1,maxTurns:1,
    maxToolCalls:1}}).budget,{maxWallSeconds:1,maxTurns:1,maxToolCalls:1});
  for (const [field,bad] of [
    ['maxWallSeconds',0],['maxWallSeconds',601],['maxTurns',0],['maxTurns',9],
    ['maxToolCalls',0],['maxToolCalls',41],['maxWallSeconds',1.5],
    ['maxToolCalls',Number.MAX_SAFE_INTEGER+1],['maxTurns','1'],
  ] as const) {
    assert.throws(()=>parseProfileConfiguration({...valid,
      budget:{...valid.budget,[field]:bad}}),/INVALID_ARGUMENT/,`${field}=${bad}`);
  }
});

test('profile configuration rejects authority, runtime and schema injection', () => {
  for (const extra of [{command:'git status'},{model:'gpt'},{env:{}},{network:['example.test']},
    {credentials:'secret'},{verified:true},{enabled:true},{implementationAuthorized:true},
    {isolationVerified:true}]) {
    assert.throws(()=>parseProfileConfiguration({...valid,...extra}),/INVALID_ARGUMENT/);
  }
  for (const malformed of [
    {...valid,expectedRevisionId:undefined},{...valid,expectedRevisionId:17},
    {...valid,presetRef:'arbitrary'},{...valid,budget:{...valid.budget,network:false}},
    {...valid,budget:{maxWallSeconds:600,maxTurns:8}},
    {...valid,workspaceId:''},
  ]) assert.throws(()=>parseProfileConfiguration(malformed),/INVALID_ARGUMENT/);
});
