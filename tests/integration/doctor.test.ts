import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { SessionControlSqlite } from '../../src/adapters/storage/session-control-sqlite.js';
import { diagnoseInstallation } from '../../src/application/diagnostics.js';

const script=resolve('src/cli/main.ts');
function run(root:string,action:string) {
  const result=spawnSync(process.execPath,['--import','tsx',script,'--data-dir',root,action],
    {encoding:'utf8',cwd:resolve('.'),timeout:30_000});
  return {status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error};
}
function snapshot(root:string):Record<string,string> {
  return Object.fromEntries(readdirSync(root).sort().map(name=>{
    const path=join(root,name);
    const stat=lstatSync(path);
    return [name,stat.isFile()?createHash('sha256').update(readFileSync(path)).digest('hex'):
      `nonregular:${stat.mode}`];
  }));
}

test('doctor preserves unconfirmed database cleanup as an aggregate error', () => {
  const base=process.platform==='win32'?homedir():tmpdir();
  const fixture=mkdtempSync(join(base,'rcac-doctor-close-'));
  const root=join(fixture,'data');
  const close=DatabaseSync.prototype.close;
  const failure=new Error('controlled native-close observation failure');
  try {
    assert.equal(run(root,'init').status,0);
    DatabaseSync.prototype.close=function() { close.call(this); throw failure; };
    assert.throws(()=>diagnoseInstallation(root,{principal:'fixture',recipient:'fixture',audience:'local-os',
      surface:'local_cli',now:new Date()}),error=>error instanceof AggregateError && error.errors.includes(failure));
  } finally { DatabaseSync.prototype.close=close; rmSync(fixture,{recursive:true,force:true}); }
});

test('doctor reports bounded capabilities from an existing private installation without writing',()=>{
  const base=process.platform==='win32'?homedir():tmpdir();
  const dir=mkdtempSync(join(base,'rcac-doctor-'));
  const root=join(dir,'data');
  try {
    const init=run(root,'init');
    assert.equal(init.status,0,init.stderr);
    const before=snapshot(root);
    const doctor=run(root,'doctor');
    assert.equal(doctor.status,0,doctor.stderr);
    const report=JSON.parse(doctor.stdout) as Record<string,unknown>;
    assert.equal(report.schemaVersion,1);
    assert.deepEqual(report.installation,{status:'readable',reason:'private_database_schema_valid'});
    assert.deepEqual(report.service,{status:'not_checked',reason:'no_service_probe'});
    assert.deepEqual(report.tools,{status:'not_checked',reason:'no_host_probe'});
    assert.deepEqual(report.identity,{status:'not_checked',reason:'native_account_not_observed'});
    assert.deepEqual(report.mcp,{status:'not_configured',reason:'binding_absent',authorizedOperations:0});
    assert.deepEqual(report.sessions,{status:'foreground_adapter_installed',reason:'runtime_not_checked',
      account:'not_checked',binding:'not_checked',history:'not_checked',humanHandoff:'not_checked',
      unresolvedSends:'none'});
    assert.deepEqual(report.investigator,{status:'runtime_unavailable',reason:'runtime_not_verified',profileConfigured:false});
    assert.deepEqual(report.files,{status:'local_implemented',reason:'remote_not_checked',originsConfigured:false});
    assert.deepEqual(snapshot(root),before);
    assert.doesNotMatch(doctor.stdout,new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    writeFileSync(join(root,'oauth-config.json'),JSON.stringify({issuer:{},bindings:[{}],
      allowedFileOrigins:['http://invalid.example']}),{mode:0o600});
    const badOrigin=run(root,'doctor');
    assert.equal(badOrigin.status,0,badOrigin.stderr);
    assert.deepEqual((JSON.parse(badOrigin.stdout) as Record<string,unknown>).files,
      {status:'local_implemented',reason:'origin_config_invalid',originsConfigured:false});
    const live=new DatabaseSync(join(root,'state.sqlite'));
    try {
      live.exec('CREATE TABLE doctor_live_probe(x INTEGER); INSERT INTO doctor_live_probe VALUES(1)');
      const sidecarsBefore=snapshot(root);
      const busy=run(root,'doctor');
      assert.equal(busy.status,1,busy.stdout);
      assert.deepEqual(snapshot(root),sidecarsBefore);
    } finally {live.close();}
    const db=new DatabaseSync(join(root,'state.sqlite'));
    try {db.exec('DROP TABLE grants; CREATE TABLE grants(id TEXT)');} finally {db.close();}
    const brokenBefore=snapshot(root);
    const broken=run(root,'doctor');
    assert.equal(broken.status,1,broken.stdout);
    assert.deepEqual(snapshot(root),brokenBefore);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('doctor separates configured local authorization from unverified runtime and account identity',()=>{
  const base=process.platform==='win32'?homedir():tmpdir();
  const dir=mkdtempSync(join(base,'rcac-doctor-configured-'));
  const root=join(dir,'data');
  const principal='SYNTHETIC_PRIVATE_PRINCIPAL_67f9';
  try {
    assert.equal(run(root,'init').status,0);
    const store=new SqliteStore(join(root,'state.sqlite'));
    try {
      store.insertWorkspace({id:'ws-diagnostic',name:'Diagnostic',canonicalRoot:dir,
        registeredBy:'owner'});
      store.insertCollaboration({id:'col-diagnostic',workspaceId:'ws-diagnostic',openedBy:'owner',
        purpose:'diagnostic',hostThreadId:null,state:'open'});
      store.insertGrant({id:'grant-diagnostic',principal,audience:'external-audience',
        recipient:principal,workspaceId:'ws-diagnostic',permissions:['collab.read'],
        expiresAt:null,revokedAt:null});
      store.insertGrant({id:'grant-send',principal:'owner',audience:'host',recipient:'owner',
        workspaceId:'ws-diagnostic',collaborationId:'col-diagnostic',
        permissions:['conversation.control'],expiresAt:null,revokedAt:null});
      store.insertProfileRevision({workspaceId:'ws-diagnostic',expectedRevisionId:null,
        presetRef:'static_readonly_v1',budget:{maxWallSeconds:60,maxTurns:1,maxToolCalls:2}},
      'owner',new Date());
    } finally {store.close();}
    const sessions=new SessionControlSqlite(join(root,'state.sqlite'));
    try {
      sessions.create({bindingId:'binding-diagnostic',workspaceId:'ws-diagnostic',
        collaborationId:'col-diagnostic',providerId:'provider-private',accountId:'account-private',
        nativeSessionId:'native-private',cursor:'first',control:'host_controlled',epoch:0,revision:0});
      const permit={grantId:'grant-send',operation:'conversation.send' as const,
        effect:'external_send' as const,scope:{workspaceId:'ws-diagnostic',
          collaborationId:'col-diagnostic'},principal:'owner',recipient:'owner'};
      sessions.claimCommand({commandId:'send-private',scope:{principal:'owner',audience:'host',
        workspaceId:'ws-diagnostic',operation:'conversation.send',idempotencyKey:'send-private'},
      payload:{text:'SYNTHETIC_PRIVATE_BODY_28f1'},permit,bindingId:'binding-diagnostic',
      expectedRevision:0,expectedEpoch:0});
      sessions.markSending('send-private',permit,0,0);
      sessions.finishSend('send-private',1,0,'unknown');
    } finally {sessions.close();}
    writeFileSync(join(root,'mcp-binding.json'),JSON.stringify({principal,audience:'external-audience',
      recipient:principal,workspaceId:'ws-diagnostic',visibleOperations:['collab.list']}),{mode:0o600});
    const before=snapshot(root);
    const configured=run(root,'doctor');
    assert.equal(configured.status,0,configured.stderr);
    const report=JSON.parse(configured.stdout) as Record<string,unknown>;
    assert.deepEqual(report.mcp,{status:'configured_authorized',reason:'authorized',authorizedOperations:1});
    assert.deepEqual(report.investigator,{status:'runtime_unavailable',reason:'runtime_not_verified',profileConfigured:true});
    assert.deepEqual(report.sessions,{status:'foreground_adapter_installed',reason:'runtime_not_checked',
      account:'not_checked',binding:'not_checked',history:'not_checked',humanHandoff:'not_checked',
      unresolvedSends:'present'});
    assert.deepEqual(report.identity,{status:'not_checked',reason:'native_account_not_observed'});
    assert.deepEqual(snapshot(root),before);
    assert.doesNotMatch(configured.stdout,/SYNTHETIC_PRIVATE_PRINCIPAL_67f9|SYNTHETIC_PRIVATE_BODY_28f1|ws-diagnostic|grant-diagnostic|account-private/);
    const expired=new DatabaseSync(join(root,'state.sqlite'));
    try {expired.prepare('UPDATE grants SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',
      'grant-diagnostic');} finally {expired.close();}
    const expiredDoctor=run(root,'doctor');
    assert.equal(expiredDoctor.status,0,expiredDoctor.stderr);
    assert.deepEqual((JSON.parse(expiredDoctor.stdout) as Record<string,unknown>).mcp,
      {status:'configured_unavailable',reason:'authorization_unavailable',authorizedOperations:0});
    const renewed=new DatabaseSync(join(root,'state.sqlite'));
    try {renewed.prepare('UPDATE grants SET expires_at=NULL WHERE id=?').run('grant-diagnostic');}
    finally {renewed.close();}
    const revoke=new SqliteStore(join(root,'state.sqlite'));
    try {revoke.revokeGrant('grant-diagnostic',new Date().toISOString());}
    finally {revoke.close();}
    const denied=run(root,'doctor');
    assert.equal(denied.status,0,denied.stderr);
    assert.deepEqual((JSON.parse(denied.stdout) as Record<string,unknown>).mcp,
      {status:'configured_unavailable',reason:'authorization_unavailable',authorizedOperations:0});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('doctor does not create a missing installation',()=>{
  const base=process.platform==='win32'?homedir():tmpdir();
  const dir=mkdtempSync(join(base,'rcac-doctor-missing-'));
  const root=join(dir,'absent');
  try {
    const result=run(root,'doctor');
    assert.equal(result.status,1);
    assert.equal(readdirSync(dir).length,0);
    assert.doesNotMatch(result.stderr,/rcac-doctor-missing-/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
