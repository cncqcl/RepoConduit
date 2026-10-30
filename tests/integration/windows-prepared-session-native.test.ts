import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Readable} from 'node:stream';
import {test} from 'node:test';
import {openPreparedWindowsFixture} from '../../src/adapters/codex/investigator/windows-prepared-session.js';

function receiptLine(output:Readable):Promise<string>{
 return new Promise((resolve,reject)=>{
  let pending=Buffer.alloc(0);
  const clean=()=>{clearTimeout(timer);output.off('data',data);output.off('end',end);};
  const end=()=>{clean();reject(new Error('RECEIPT_EOF'));};
  const data=(bytes:Buffer)=>{
   pending=Buffer.concat([pending,bytes]);
   if(pending.length>4096){clean();reject(new Error('RECEIPT_LIMIT'));return;}
   const newline=pending.indexOf(10);
   if(newline>=0){clean();resolve(pending.subarray(0,newline).toString('utf8'));}
  };
  const timer=setTimeout(()=>{clean();reject(new Error('RECEIPT_TIMEOUT'));},5000);
  output.on('data',data);output.on('end',end);
 });
}

test('actual prepared owner stops an empty Job without starting a child or leaving write authority',
 {skip:process.platform!=='win32',timeout:15_000},async()=>{
  const session=await openPreparedWindowsFixture({maxWallSeconds:10});
  assert.equal(session.root,null);
  assert.throws(()=>session.send('{"id":1}\n'),/WINDOWS_PREPARED_UNKNOWN/);
  const closing=session.stop();
  assert.throws(()=>session.start(),/WINDOWS_PREPARED_UNKNOWN/);
  const closure=await closing;
  assert.equal(closure.kind,'prepared_closed');
  assert.equal(session.root,null);
  assert.deepEqual(closure.members,{complete:true,assigned:0,listed:0,pids:[]});
  assert.deepEqual(await session.stop(),closure);
 });

test('actual owner permits one start, confirms one full 64KiB UTF8 frame and revokes writer before Job stop',
 {skip:process.platform!=='win32',timeout:20_000},async()=>{
  const session=await openPreparedWindowsFixture({maxWallSeconds:15});
  try{
   const starting=session.start();
   assert.throws(()=>session.start(),/WINDOWS_PREPARED_UNKNOWN/);
   const root=await starting;
   assert.ok(root.pid>0);assert.equal(session.root,root);assert.ok(Object.isFrozen(root));
   const prefix='{"text":"',suffix='"}\n';
   const line=prefix+'日'.repeat(10_000)+'a'.repeat(65536-Buffer.byteLength(prefix+suffix)-30000)+suffix;
   assert.equal(Buffer.byteLength(line),65536);
   const reply=receiptLine(session.output);void reply.catch(()=>{});
   assert.equal(session.send(line),true);
   assert.deepEqual(JSON.parse(await reply),{receivedBytes:65536,
    sha256:createHash('sha256').update(line).digest('hex')});
   const closing=session.stop();
   assert.throws(()=>session.send('{}\n'),/WINDOWS_PREPARED_UNKNOWN/);
   const closure=await closing;
   assert.equal(closure.kind,'job_closed');
   assert.ok(closure.kind==='job_closed');assert.deepEqual(closure.root,root);
   assert.deepEqual(closure.members,{complete:true,assigned:0,listed:0,pids:[]});
  }finally{await session.stop().catch(()=>{});}
 });

test('invalid frame attempts revoke the actual owner before any later native write',
 {skip:process.platform!=='win32',timeout:30_000},async()=>{
  for(const rejected of ['{}\n{}\n','{"text":"\ud800"}\n','[]\n']){
   const session=await openPreparedWindowsFixture({maxWallSeconds:10});
   try{
    await session.start();
    let receivedBytes=0;session.output.on('data',(bytes:Buffer)=>{receivedBytes+=bytes.length;});
    assert.throws(()=>session.send(rejected),/WINDOWS_PREPARED_UNKNOWN/);
    assert.throws(()=>session.send('{}\n'),/WINDOWS_PREPARED_UNKNOWN/);
    await assert.rejects(session.stop(),/WINDOWS_PREPARED_UNKNOWN/);
    assert.equal(receivedBytes,0);
   }finally{await session.stop().catch(()=>{});}
  }
 });

test('aborting the actual owner removes send authority while the original Job proves closure',
 {skip:process.platform!=='win32',timeout:15_000},async()=>{
  const controller=new AbortController();
  const session=await openPreparedWindowsFixture({maxWallSeconds:10,signal:controller.signal});
  const root=await session.start();
  controller.abort();
  assert.throws(()=>session.send('{}\n'),/WINDOWS_PREPARED_UNKNOWN/);
  const closure=await session.stop();
  assert.equal(closure.kind,'job_closed');
  assert.ok(closure.kind==='job_closed');
  assert.deepEqual(closure.root,root);
  assert.deepEqual(closure.members,{complete:true,assigned:0,listed:0,pids:[]});
  assert.throws(()=>session.send('{}\n'),/WINDOWS_PREPARED_UNKNOWN/);
  assert.deepEqual(session.root,root);
 });
