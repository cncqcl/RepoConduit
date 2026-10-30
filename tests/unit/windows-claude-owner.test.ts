import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {openOwnedWindowsClaude,parsePreparedWindowsEvent} from
 '../../src/adapters/codex/investigator/windows-prepared-session.js';
import {buildClaudeWindowsLaunchSpec} from
 '../../src/adapters/secondary-investigator/claude-windows-protocol.js';

const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const recipe='windows_claude_readonly_v1' as const;

test('Claude owner accepts only the fixed recipe and strict event binding',()=>{
 const binding={recipe,hostScopeId:randomUUID(),executionInstanceId:randomUUID()};
 const frame=JSON.stringify({protocol:'windows_job_stdio_v1',helperVersion:'3',...binding,
  sequence:1,kind:'prepared_closed',childPresent:false,
  members:{complete:true,assigned:0,listed:0,pids:[]}});
 assert.equal(parsePreparedWindowsEvent(frame,binding,1)?.kind,'prepared_closed');
 assert.equal(parsePreparedWindowsEvent(frame.replace(recipe,'windows_app_server_readonly_v1'),binding,1),null);
});

test('native and launch recipe preapprove only the two concrete repo.read MCP names',()=>{
 const actual='mcp__repo-conduit__repo.read,mcp__repo-conduit__repo_read';
 const native=readFileSync(resolve('native/windows/WindowsJobHost.cs'),'utf8');
 assert.ok(native.includes(`--allowedTools ${actual}`),'fixed native recipe must preapprove the two exact MCP names');
 const launch=buildClaudeWindowsLaunchSpec({
  executablePath:'C:\\Users\\fixture-user\\.local\\bin\\claude.exe',root:'D:\\synthetic\\claude',
  mcpEndpoint:'http://127.0.0.1:45678/mcp',bearerToken:'x'.repeat(32),maxTurns:1,
  inheritedEnv:{USERPROFILE:'C:\\Users\\fixture-user'},
 });
 const index=launch.argv.indexOf('--allowedTools');
 assert.ok(index>0);assert.equal(launch.argv[index+1],actual);
 assert.equal(launch.argv.filter(value=>value==='--allowedTools').length,1);
 assert.equal(launch.argv.includes('--dangerously-skip-permissions'),false);
});

test('Claude owner rejects caller-supplied executable, argv or environment before native launch',async()=>{
 const launch={runtimeRoot:resolve('D:/synthetic/claude'),sourceCwd:resolve('D:/synthetic/claude/work'),
  configSha256:'0'.repeat(64),maxWallSeconds:5,maxTurns:1};
 for(const extra of [{executable:'C:/other.exe'},{argv:['--dangerously-skip-permissions']},
  {env:{ANTHROPIC_API_KEY:'sentinel'}}]){
  await assert.rejects(openOwnedWindowsClaude({...launch,...extra}),/WINDOWS_PREPARED_UNKNOWN/);
 }
 for(const maxTurns of [0,9,1.5]){
  await assert.rejects(openOwnedWindowsClaude({...launch,maxTurns}),/WINDOWS_PREPARED_UNKNOWN/);
 }
});

test('native Claude recipe verifies config SHA before preparation and stops empty Job before child start',
 {skip:process.platform!=='win32',timeout:30_000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rcac-claude-owner-'));
  const exe=join(dir,'WindowsJobHost.exe');const runtime=join(dir,'runtime');
  const cwd=join(runtime,'work');mkdirSync(cwd,{recursive:true});
  const bytes='{"mcpServers":{"repo-conduit":{"type":"http","url":"http://127.0.0.1:1/mcp"}}}\n';
  writeFileSync(join(runtime,'mcp.json'),bytes);
  try{
   const built=spawnSync(compiler,['/nologo','/target:exe','/platform:x64',`/out:${exe}`,
    resolve('native/windows/WindowsJobHost.cs')],{encoding:'utf8',timeout:30_000,windowsHide:true});
   assert.equal(built.status,0,`${built.stdout} ${built.stderr}`);
   const base=[recipe,randomUUID(),randomUUID(),runtime];
   const wrong=spawnSync(exe,[...base,'0'.repeat(64),cwd,'5','1'],{
    input:'stop\n',encoding:'utf8',timeout:7000,windowsHide:true});
   assert.equal(wrong.stdout,'');assert.notEqual(wrong.status,0);
   assert.match(wrong.stderr,/CONFIG_HASH/);
   const hash=createHash('sha256').update(readFileSync(join(runtime,'mcp.json'))).digest('hex');
   const child=spawn(exe,[...base,hash,cwd,'5','1'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
   let stdout='',stderr='',stopSent=false;
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   child.stdout.on('data',(chunk:string)=>{
    stdout+=chunk;if(!stopSent&&stdout.includes('"kind":"prepared"')){
     stopSent=true;child.stdin.write('stop\n');
    }
   });
   child.stderr.on('data',(chunk:string)=>{stderr+=chunk;});
   const exitCode=await new Promise<number|null>((res,rej)=>{
    const timer=setTimeout(()=>{child.kill();rej(new Error('CLAUDE_PREPARE_TIMEOUT'));},7000);
    child.once('close',code=>{clearTimeout(timer);res(code);});
   });
   assert.equal(exitCode,0,`${stdout} ${stderr}`);
   const events=stdout.trim().split(/\r?\n/u).map(line=>JSON.parse(line) as Record<string,unknown>);
   assert.deepEqual(events.map(e=>e.kind),['prepared','prepared_closed']);
   assert.equal(events[0]?.childPresent,false);
   assert.deepEqual(events[1]?.members,{complete:true,assigned:0,listed:0,pids:[]});
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
 });
