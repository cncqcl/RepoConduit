import {spawnSync} from 'node:child_process';
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {userInfo} from 'node:os';
import {win32} from 'node:path';

// The reviewed 0.165 alpha.1.2 executable retains the used protocol shapes.
// Keep the codec contract identity; pin the actual launch binary independently.
export const WINDOWS_DESKTOP_VERSION='0.165.0-alpha.1.2';
/** Historical location is a bounded fallback, never a version or ordering preference. */
export const WINDOWS_DESKTOP_LEGACY_CODEX='C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
interface SelectionRuntime {
 root:string;directories():string[];valid(path:string):boolean;
 version(path:string):{status:number|null;stdout:string;error?:unknown};
}
const unavailable=()=>new Error('NOT_AVAILABLE');
export function desktopVersionMatches(stdout:string):boolean {
 return stdout.replaceAll('\r\n','\n')===`codex-cli ${WINDOWS_DESKTOP_VERSION}\n`;
}
/** Internal adapter seam. No request, profile or MCP field can choose an executable. */
export function selectWindowsDesktopTarget(runtime:SelectionRuntime):string {
 const entries=runtime.directories();
 if(entries.length>8||entries.some(e=>!/^[0-9a-f]{16}$/.test(e)))throw unavailable();
 const candidates=[...new Set([...entries.map(e=>win32.join(runtime.root,e,'codex.exe')),
  WINDOWS_DESKTOP_LEGACY_CODEX])];
 const supported:string[]=[];
 for(const path of candidates){
  if(!runtime.valid(path))continue;
  const observed=runtime.version(path);
  if(observed.error||observed.status!==0||Buffer.byteLength(observed.stdout)>512)throw unavailable();
  if(desktopVersionMatches(observed.stdout))supported.push(path);
 }
 if(supported.length!==1)throw unavailable();
 return supported[0]!;
}
export function resolveWindowsDesktopTarget():string {
 if(process.platform!=='win32')throw unavailable();
 const root=win32.join(userInfo().homedir,'AppData','Local','OpenAI','Codex','bin');
 const safe=(path:string):boolean=>{
  try{
   const stat=lstatSync(path);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0)return false;
   for(let current=path;;current=win32.dirname(current)){
    if(lstatSync(current).isSymbolicLink()||realpathSync.native(current).toLowerCase()!==current.toLowerCase())return false;
    if(win32.dirname(current)===current)break;
   }
   return true;
  }catch{return false;}
 };
 try{return selectWindowsDesktopTarget({root,
  directories:()=>{try{return readdirSync(root);}catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}},valid:safe,
  version:path=>spawnSync(path,['--version'],{shell:false,windowsHide:true,encoding:'utf8',
   timeout:5000,maxBuffer:4096,env:{SystemRoot:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows'}}),
 });}catch{throw unavailable();}
}
