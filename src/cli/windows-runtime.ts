import {join} from 'node:path';
import {SqliteStore} from '../adapters/storage/sqlite.js';
import type {InstallationRuntime} from '../runtime/installation.js';
import {assertActiveInstallation} from '../runtime/installation.js';
import {prepareWindowsInvestigatorRuntime,checkWindowsInvestigatorRuntimeStrict,
 type WindowsRuntimeInput,type WindowsRuntimeCheckInput} from
 '../runtime/windows-investigation-runtime-config.js';

/** Local administrator actions only; input cannot select a binary, environment or profile preset. */
export async function runWindowsRuntimeCommand(runtime:InstallationRuntime,
 action:'prepare-windows-investigator'|'check-windows-investigator',
 identity:{principal:string;audience:string;recipient:string},input:unknown):Promise<unknown>{
 assertActiveInstallation(runtime);
 const store=new SqliteStore(join(runtime.dataDirectory,'state.sqlite'));
 try{
  const context={...identity,surface:'local_admin' as const,now:new Date()};
  return action==='prepare-windows-investigator'
   ? prepareWindowsInvestigatorRuntime(runtime.dataDirectory,store,context,input as WindowsRuntimeInput)
   : await checkWindowsInvestigatorRuntimeStrict(runtime.dataDirectory,store,context,
      input as WindowsRuntimeCheckInput);
 }finally{store.close();}
}
