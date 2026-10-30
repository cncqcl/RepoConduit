import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createSyntheticQualificationRead} from '../../tools/windows-qualification-synthetic-read.ts';

test('synthetic repo.read goes through real dispatch and repository application with fixed path scope',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rcac-qualification-read-'));
 let session:Awaited<ReturnType<typeof createSyntheticQualificationRead>>|undefined;
 try{
  session=await createSyntheticQualificationRead(root);
  const observed=await session.read({path:'README.md',maxBytes:4096,maxLines:200});
  assert.match(JSON.stringify(observed),/RepoConduit synthetic qualification source/);
  await assert.rejects(session.read({path:'private.txt',maxBytes:4096,maxLines:200}),/QUALIFICATION_READ_DENIED/);
  assert.equal(session.dispatches(),2);
  assert.equal(session.calls(),2);
  await session.read({path:'README.md',maxBytes:4096,maxLines:200});
  await assert.rejects(session.read({path:'README.md',maxBytes:4096,maxLines:200}),/QUALIFICATION_READ_DENIED/);
  assert.equal(session.dispatches(),3);
 }finally{session?.close();rmSync(root,{recursive:true,force:true});}
});
