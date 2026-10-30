import assert from 'node:assert/strict';
import {test} from 'node:test';
import {localCliError} from '../../src/cli/main.js';

const message='Data directory permissions unavailable or unsafe';
const failure=(cause:unknown)=>new Error(message,{cause});

test('local CLI preserves only the closed private-directory diagnostic vocabulary',()=>{
 for(const operation of ['protect','verify_data','verify_installation']){
  for(const reason of ['timeout','output_limit','spawn_missing','spawn_denied','helper_rejected','unknown']){
   const cause=Object.freeze({component:'private_directory',operation,reason});
   assert.deepEqual(localCliError(failure(cause)),{code:'ERROR',message,privateDirectory:cause});
  }
 }
});

test('local CLI refuses extra secret fields, unknown values and nested subprocess causes',()=>{
 const secret='SYNTHETIC_PRIVATE_ERROR_MARKER';
 for(const cause of [
  {component:'private_directory',operation:'verify_data',reason:'timeout',stderr:secret},
  {component:'private_directory',operation:'verify_data',reason:secret},
  {component:'private_directory',operation:secret,reason:'timeout'},
  {component:secret,operation:'verify_data',reason:'timeout'},
  {component:'private_directory',operation:'verify_data',reason:'timeout',environment:{TOKEN:secret}},
  new Error(secret,{cause:{component:'private_directory',operation:'verify_data',reason:'timeout'}}),
  null,secret,
 ]){
  const output=localCliError(failure(cause));
  assert.deepEqual(output,{code:'ERROR',message});
  assert.equal(JSON.stringify(output).includes(secret),false);
 }
});

test('local CLI requires the direct known error and preserves generic public redaction',()=>{
 const cause={component:'private_directory',operation:'verify_data',reason:'timeout'};
 for(const error of [new Error('SYNTHETIC_PRIVATE_MESSAGE',{cause}),{message,cause},
  new Error(message,{cause:{component:'installation_runtime',detail:cause}})]){
  const output=localCliError(error);
  assert.equal('privateDirectory' in output,false);
  assert.equal(JSON.stringify(output).includes('SYNTHETIC_PRIVATE_MESSAGE'),false);
 }
});
