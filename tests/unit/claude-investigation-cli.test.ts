import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseClaudeStartupArguments} from '../../src/cli/claude-investigation.js';

test('Claude selection is an explicit local MCP pair without runtime/command overrides',()=>{
 const base=['--data-dir','D:/fixture','mcp'];
 assert.deepEqual(parseClaudeStartupArguments(base),{argv:base});
 assert.deepEqual(parseClaudeStartupArguments([...base,'--claude-workspace','ws','--claude-profile','profile']),
  {argv:base,selection:{workspaceId:'ws',profileRevision:'profile'}});
 for(const extra of [['--claude-workspace','ws'],['--claude-profile','profile'],
  ['--claude-workspace','ws','--claude-profile','profile','--claude-profile','other'],
  ['--claude-workspace','../escape','--claude-profile','profile']])assert.throws(()=>parseClaudeStartupArguments([...base,...extra]));
 for(const action of ['request','serve-http','run-claude-investigation'])assert.throws(()=>parseClaudeStartupArguments([
  '--data-dir','D:/fixture',action,'--claude-workspace','ws','--claude-profile','p']));
});
