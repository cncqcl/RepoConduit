import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {openApplication} from '../../src/runtime/application.js';
import {protectNewDataDirectory} from '../../src/runtime/local-security.js';
import {SqliteInvestigationStore} from '../../src/adapters/storage/investigation-sqlite.js';
import {SqliteStore} from '../../src/adapters/storage/sqlite.js';
import type {InvestigationRecord} from '../../src/core/investigation/request.js';

test('a Claude facade cannot return a pending Codex request from another workspace',async()=>{
 const base=process.env.RCAC_TEST_FIXTURE_ROOT??homedir();
 const root=mkdtempSync(join(base,'rcac-runtime-selection-'));protectNewDataDirectory(root);
 new SqliteStore(join(root,'state.sqlite')).close();
 const record:InvestigationRecord={id:'inv-cancelled',workspaceId:'codex-ws',collaborationId:'col',workingCopyId:'copy',
  principal:'external',audience:'mcp',recipient:'user',grantId:'request',profileRef:'codex-profile',budgetRef:'codex-profile',
  budget:{maxWallSeconds:30,maxTurns:1,maxToolCalls:2},contextRevisionId:'ctx',snapshotRef:'snapshot',question:'fixture',
  scope:{paths:['entry.ts'],symbols:[],relatedTests:[]},requestedOutputs:['evidence'],parentInvestigationId:null,
  state:'cancelled',cancelRequested:true,attempts:[],result:null,createdAt:new Date().toISOString()};
 const original=SqliteInvestigationStore.prototype.get;
 // Only lookup is a unit fixture. Neither native admission nor a model is invoked for a terminal request.
 SqliteInvestigationStore.prototype.get=function(id){return id===record.id?structuredClone(record):original.call(this,id);};
 let app:ReturnType<typeof openApplication>|undefined;
 try{
  app=openApplication(root,{codexInvestigator:{workspaceId:'codex-ws',profileRevision:'codex-profile'},
   claudeInvestigator:{workspaceId:'claude-ws',profileRevision:'claude-profile'}});
  await app.ready;
  const codex=app.runCodexInvestigation(record.id);
  const claude=app.runClaudeInvestigation(record.id);
  await assert.rejects(claude,/NOT_AVAILABLE/);
  assert.equal((await codex)?.state,'cancelled');
 }finally{await app?.close();SqliteInvestigationStore.prototype.get=original;rmSync(root,{recursive:true,force:true});}
});
